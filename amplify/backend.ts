import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBackend } from '@aws-amplify/backend';
import { CfnResource, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { auth } from './auth/resource';
import { sessionBinding } from './functions/session-binding/resource';

const GITHUB_CLIENT_ID = 'Ov23liDvunrMrRslwdjl'; // GitHub OAuth AppのClient ID（公開時はプレースホルダーに戻す）
const SECRET_NAME = 'github-agent/oauth-client-secret';
// Slack AppのClient ID。実値はコミットせず環境変数で渡す
// （例: SLACK_CLIENT_ID=xxxx.yyyy npx ampx sandbox --once）
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID ?? '<SLACK_CLIENT_ID>';
const SLACK_SECRET_NAME = 'slack-agent/oauth-client-secret';

const backend = defineBackend({ auth, sessionBinding });

// resourceGroupNameでLambdaが配置されたカスタムスタックを取得し、
// 以降のリソースをすべて同じスタックに定義する（循環参照の回避）
const stack = Stack.of(backend.sessionBinding.resources.lambda);
const dirname = path.dirname(fileURLToPath(import.meta.url));

// AgentCoreのリソース名はアカウント内で一意のため、環境ごとの接尾辞で衝突を避ける
// （Hosting: ブランチ名 / sandbox: OSユーザー名）
const rawEnvName = process.env.AWS_BRANCH ?? process.env.USER ?? 'sandbox';
const suffix =
  rawEnvName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'sandbox';

// コールバック先はHostingならAmplifyドメイン、sandboxならローカル開発サーバー
const isHosting =
  process.env.AWS_BRANCH !== undefined && process.env.AWS_APP_ID !== undefined;
const callbackUrl = isHosting
  ? `https://${process.env.AWS_BRANCH}.${process.env.AWS_APP_ID}.amplifyapp.com/callback`
  : 'http://localhost:5173/callback';

// ─── DynamoDB ───────────────────────────────────────
const table = new dynamodb.Table(stack, 'AuthSessionTable', {
  partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: 'ttl',
  removalPolicy: RemovalPolicy.DESTROY,
});

// ─── Lambda ─────────────────────────────────────────
const fn = backend.sessionBinding.resources.lambda;
table.grantReadWriteData(fn);
backend.sessionBinding.addEnvironment('TABLE_NAME', table.tableName);

fn.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock-agentcore:CompleteResourceTokenAuth'],
    resources: ['*'],
  })
);

// CompleteResourceTokenAuthの内部でIdentityが呼び出し元の権限で
// クライアントシークレット（EXTERNAL）を取得するため、Lambdaにも必要
fn.addToRolePolicy(
  new PolicyStatement({
    actions: ['secretsmanager:GetSecretValue'],
    resources: [
      `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${SECRET_NAME}-*`,
      `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${SLACK_SECRET_NAME}-*`,
    ],
  })
);

// ─── API Gateway ────────────────────────────────────
const userPool = backend.auth.resources.userPool;
const userPoolClient = backend.auth.resources.userPoolClient;

const authorizer = new HttpJwtAuthorizer(
  'CognitoAuthorizer',
  `https://cognito-idp.${stack.region}.amazonaws.com/${userPool.userPoolId}`,
  { jwtAudience: [userPoolClient.userPoolClientId] }
);

const httpApi = new apigwv2.HttpApi(stack, 'SessionBindingApi', {
  corsPreflight: {
    allowOrigins: ['*'], // 動作確認用。本番はAmplifyのドメインに絞る
    allowMethods: [
      apigwv2.CorsHttpMethod.POST,
      apigwv2.CorsHttpMethod.OPTIONS,
    ],
    allowHeaders: ['Authorization', 'Content-Type'],
  },
  defaultAuthorizer: authorizer,
});

const integration = new HttpLambdaIntegration('BindingIntegration', fn);
httpApi.addRoutes({
  path: '/auth/pending',
  methods: [apigwv2.HttpMethod.POST],
  integration,
});
httpApi.addRoutes({
  path: '/auth/complete',
  methods: [apigwv2.HttpMethod.POST],
  integration,
});

const outputs: Record<string, string> = {
  sessionBindingApiUrl: httpApi.apiEndpoint,
};

// ─── Gateway用IAMロール ─────────────────────────────
const gatewayRole = new Role(stack, 'GatewayRole', {
  assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
});

gatewayRole.addToPolicy(
  new PolicyStatement({
    actions: [
      'bedrock-agentcore:GetWorkloadAccessToken',
      // ユーザーJWTを渡すアウトバウンド認証ではJWT用の別アクションが必要
      'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
      'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
      'bedrock-agentcore:GetResourceOauth2Token',
    ],
    resources: ['*'], // 動作確認用。本番はworkload-identity / token-vaultのARNに絞る
  })
);

gatewayRole.addToPolicy(
  new PolicyStatement({
    actions: ['secretsmanager:GetSecretValue'],
    resources: [
      `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${SECRET_NAME}-*`,
      `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${SLACK_SECRET_NAME}-*`,
    ],
  })
);

// ─── OAuth2 Credential Provider ──────────────────────
// シークレットは自前のSecrets Managerを参照（EXTERNAL）。値がテンプレートに乗らない
// 注意: GitHub OAuth Appに登録できるコールバックURLは1つだけ。sandboxで3LOまで
// 試す場合は、開発用のOAuth Appを別途作成してこのClient ID/シークレットを差し替える
const credentialProvider = new CfnResource(stack, 'GitHubCredentialProvider', {
  type: 'AWS::BedrockAgentCore::OAuth2CredentialProvider',
  properties: {
    Name: `github-provider-${suffix}`,
    CredentialProviderVendor: 'GithubOauth2',
    Oauth2ProviderConfigInput: {
      GithubOauth2ProviderConfig: {
        ClientId: GITHUB_CLIENT_ID,
        ClientSecretSource: 'EXTERNAL',
        // シークレットはJSON形式（{"client_secret": "..."}）で格納し、JsonKeyで参照する
        // （CFNスキーマ上、SecretIdとJsonKeyの両方が必須。プレーン文字列は不可）
        ClientSecretConfig: {
          SecretId: SECRET_NAME,
          JsonKey: 'client_secret',
        },
      },
    },
  },
});

// Slack用。ビルトインのSlackOauth2ベンダーは標準のoauth.v2.accessを使うため
// ボットトークンが保存され、ユーザートークン必須のSlack MCPサーバーに拒否される
// （sandboxで実測済み）。CustomOauth2でユーザーフロー専用エンドポイントを明示する
const slackCredentialProvider = new CfnResource(
  stack,
  'SlackCredentialProvider',
  {
    type: 'AWS::BedrockAgentCore::OAuth2CredentialProvider',
    properties: {
      Name: `slack-user-provider-${suffix}`,
      CredentialProviderVendor: 'CustomOauth2',
      Oauth2ProviderConfigInput: {
        CustomOauth2ProviderConfig: {
          ClientId: SLACK_CLIENT_ID,
          ClientSecretSource: 'EXTERNAL',
          ClientSecretConfig: {
            SecretId: SLACK_SECRET_NAME,
            JsonKey: 'client_secret',
          },
          OauthDiscovery: {
            AuthorizationServerMetadata: {
              Issuer: 'https://slack.com',
              AuthorizationEndpoint: 'https://slack.com/oauth/v2_user/authorize',
              TokenEndpoint: 'https://slack.com/api/oauth.v2.user.access',
              ResponseTypes: ['code'],
            },
          },
        },
      },
    },
  }
);

// ─── Gateway ─────────────────────────────────────────
const gateway = new CfnResource(stack, 'GitHubGateway', {
  type: 'AWS::BedrockAgentCore::Gateway',
  properties: {
    Name: `github-gateway-${suffix}`,
    AuthorizerType: 'CUSTOM_JWT',
    AuthorizerConfiguration: {
      CustomJWTAuthorizer: {
        DiscoveryUrl: Fn.sub(
          'https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/openid-configuration',
          {
            region: stack.region,
            poolId: userPool.userPoolId,
          }
        ),
        AllowedClients: [userPoolClient.userPoolClientId],
      },
    },
    RoleArn: gatewayRole.roleArn,
    ProtocolType: 'MCP',
    ProtocolConfiguration: {
      Mcp: {
        SupportedVersions: ['2025-11-25'], // 3LOには2025-11-25以降が必須
        SearchType: 'SEMANTIC',
      },
    },
    ExceptionLevel: 'DEBUG',
  },
});

// ─── Gateway Target: GitHub公式リモートMCPサーバー ────
// 3LOのMCPサーバーターゲットは作成時に対話認可が必要になるため、
// ツール定義（mcpToolSchema）を静的に渡してIaCワンショットを維持する
// （静的スキーマは認可コードグラント専用の仕組み。同期は無効になる）
const mcpToolsSchema = readFileSync(
  path.join(dirname, 'github-mcp-tools.json'),
  'utf-8'
);

new CfnResource(stack, 'GitHubMcpTarget', {
  type: 'AWS::BedrockAgentCore::GatewayTarget',
  properties: {
    Name: 'githubmcp',
    GatewayIdentifier: gateway.ref,
    TargetConfiguration: {
      Mcp: {
        McpServer: {
          Endpoint: 'https://api.githubcopilot.com/mcp/',
          McpToolSchema: {
            InlinePayload: mcpToolsSchema,
          },
        },
      },
    },
    // Credential Providerは既存ターゲットと共有。スコープも同一にすることで
    // 認可済みユーザーのトークンがそのまま再利用される（再認可不要）
    CredentialProviderConfigurations: [
      {
        CredentialProviderType: 'OAUTH',
        CredentialProvider: {
          OauthCredentialProvider: {
            ProviderArn: credentialProvider
              .getAtt('CredentialProviderArn')
              .toString(),
            Scopes: ['repo', 'read:user'],
            GrantType: 'AUTHORIZATION_CODE',
            DefaultReturnUrl: callbackUrl,
          },
        },
      },
    ],
  },
});

// ─── Gateway Target: Slack公式リモートMCPサーバー ─────
// GitHubターゲットと同じくツール定義を静的に渡す（同期なし・Lambdaプロキシ不要）。
// Slack MCPサーバーはユーザートークン必須。Slack App側でMCPサーバーアクセスの
// 有効化（App Assistant設定）を済ませておくこと
const slackToolsSchema = readFileSync(
  path.join(dirname, 'slack-mcp-tools.json'),
  'utf-8'
);

new CfnResource(stack, 'SlackMcpTarget', {
  type: 'AWS::BedrockAgentCore::GatewayTarget',
  properties: {
    Name: 'slackmcp',
    GatewayIdentifier: gateway.ref,
    TargetConfiguration: {
      Mcp: {
        McpServer: {
          Endpoint: 'https://mcp.slack.com/mcp',
          McpToolSchema: {
            InlinePayload: slackToolsSchema,
          },
        },
      },
    },
    CredentialProviderConfigurations: [
      {
        CredentialProviderType: 'OAUTH',
        CredentialProvider: {
          OauthCredentialProvider: {
            ProviderArn: slackCredentialProvider
              .getAtt('CredentialProviderArn')
              .toString(),
            // Slack AppのUser Token Scopesと一致させる
            Scopes: [
              'channels:history',
              'channels:read',
              'chat:write',
              'search:read.public',
              'users:read',
            ],
            GrantType: 'AUTHORIZATION_CODE',
            DefaultReturnUrl: callbackUrl,
          },
        },
      },
    ],
  },
});

const gatewayUrl = gateway.getAtt('GatewayUrl').toString();
outputs.gatewayUrl = gatewayUrl;

// ─── Agent Runtime（コンテナはCDKが自動ビルド&push） ──
// agent/ ディレクトリのDockerfileからARM64イメージをアセットとしてビルドする
const runtime = new agentcore.Runtime(stack, 'GithubAgentRuntime', {
  runtimeName: `github_agent_${suffix}`,
  agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromAsset(
    path.join(dirname, '../agent'),
    { platform: Platform.LINUX_ARM64 }
  ),
  // インバウンド認証はフロントエンドと同じCognito
  authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingCognito(
    userPool,
    [userPoolClient]
  ),
});

// エージェントが使うBedrockモデルの呼び出し許可
runtime.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
    resources: ['*'],
  })
);

// 環境変数とユーザーJWT転送の許可リスト（L1プロパティで指定）
const cfnRuntime = runtime.node.defaultChild as CfnResource;
cfnRuntime.addPropertyOverride('EnvironmentVariables', {
  GATEWAY_URL: gatewayUrl,
});
cfnRuntime.addPropertyOverride('RequestHeaderConfiguration', {
  RequestHeaderAllowlist: ['Authorization'],
});

outputs.agentArn = runtime.agentRuntimeArn;

backend.addOutput({
  custom: outputs,
});
