# 3LO Agent — AgentCore Gateway 3LO フルサーバーレスサンプル

Amazon Bedrock AgentCore Gateway のアウトバウンド認証（ユーザー委任型認可 / 3LO）で、GitHub・Slack・Google カレンダーに接続する、フルサーバーレスのチャットエージェントです。1 つの Gateway に複数 SaaS のターゲットを集約し、**公式リモート MCP サーバーがある SaaS は MCP サーバーターゲット、無い SaaS は OpenAPI ターゲット**で繋ぐ使い分けのサンプルになっています。

| ターゲット | 接続方式 | 接続先 |
|-----------|---------|--------|
| GitHub | MCP サーバーターゲット（静的ツールスキーマ） | GitHub 公式リモート MCP サーバー |
| Slack | MCP サーバーターゲット（静的ツールスキーマ） | Slack 公式リモート MCP サーバー |
| Google カレンダー | OpenAPI ターゲット | Google Calendar API（REST） |

- ユーザーは Cognito でログインし、チャットで自分の GitHub アカウントの情報（リポジトリ・Issue・PR・コミットなど）、Slack ワークスペースの情報（メッセージ検索・チャンネル履歴など）、Google カレンダーの予定を質問できます
- 初回のツール呼び出し時にチャット内へ各サービスの認可リンクが表示され、認可を完了するとエージェントが自動で処理を再開します（サービスごとに独立して認可）
- 各サービスのアクセストークンは Gateway と Token Vault の間で完結し、エージェントのコード・Runtime のコンテナ・フロントエンドのいずれにも現れません
- インフラは Amplify Gen 2 の backend.ts に集約されており、シークレット登録を済ませておけばデプロイ 1 回で全リソースが立ち上がります

## アーキテクチャ

![アーキテクチャ図](images/gateway-3lo-multi-target.drawio.png)

（PNG には draw.io の XML が埋め込んであるため、draw.io で開けばそのまま編集できます）

| コンポーネント | 使用サービス | 役割 |
|---------------|-------------|------|
| フロントエンド | Amplify Hosting（React SPA） | チャット UI と OAuth コールバック画面 |
| ユーザー認証 | Amazon Cognito（Amplify Auth） | アプリへのログイン。アクセストークンを Runtime・Gateway の呼び出しにも利用 |
| エージェント | AgentCore Runtime + Strands Agents | Gateway の MCP ツールを呼び出すエージェント |
| ツール基盤 | AgentCore Gateway | GitHub / Slack の公式リモート MCP サーバーの中継と Google Calendar API のツール化を担い、アウトバウンド認証（3LO）でトークンを付与 |
| 認可基盤 | AgentCore Identity | GitHub / Slack / Google 用の Credential Provider と Token Vault |
| Session Binding API | API Gateway + Lambda + DynamoDB | 認可フローの記録と Session Binding の完了（プロバイダー非依存） |

3LO フローの詳細（シーケンス図・設計判断の理由）は [docs/architecture.md](docs/architecture.md) を参照してください。

## ディレクトリ構成

```
.
├── amplify/                        # Amplify Gen 2 バックエンド定義
│   ├── backend.ts                  # 全リソースの組み立て（Gateway / Runtime / Identity 含む）
│   ├── auth/resource.ts            # Cognito（Amplify Auth）
│   ├── functions/session-binding/  # Session Binding 用 Lambda
│   ├── github-mcp-tools.json       # GitHubターゲットの静的ツールスキーマ（厳選6ツール）
│   ├── slack-mcp-tools.json        # Slackターゲットの静的ツールスキーマ（厳選5ツール）
│   └── google-calendar-openapi.json # Google CalendarターゲットのOpenAPI定義（読み取り系3操作）
├── agent/                          # Strands エージェント（詳細は agent/README.md）
│   ├── main.py                     # エントリーポイント（MCPClient で Gateway に接続）
│   ├── gateway_auth.py             # 3LO 認可待ちを扱う strands フック（プロバイダー非依存）
│   └── Dockerfile                  # ARM64 イメージ（CDK がアセットとしてビルド）
├── scripts/
│   └── fetch_mcp_tools.py          # MCPサーバーから静的ツールスキーマを生成（github / slack）
├── src/                            # React SPA
│   ├── App.tsx                     # チャット UI（SSE ストリーミング / ツール表示 / 認可カード）
│   └── Callback.tsx                # OAuth コールバック画面（Session Binding 完了）
├── docs/                           # 設計解説・トラブルシューティング
├── images/                         # アーキテクチャ図（draw.io XML埋め込みPNG）
└── amplify.yml                     # Amplify Hosting のビルド設定（Docker ビルド対応）
```

## 前提

| 項目 | 値 |
|------|-----|
| リージョン | us-east-1（AgentCore が使えるリージョンなら変更可。コードはリージョン非依存） |
| Python | 3.12 |
| Node.js | 22.x |
| パッケージ管理 | uv（Python） / pnpm（Node.js） |
| エージェント | Strands Agents + MCP Python SDK |
| モデル | Claude Sonnet 4.5（`us.anthropic.claude-sonnet-4-5-20250929-v1:0`） |
| IaC | aws-cdk-lib 2.255.0 以降（aws_bedrockagentcore モジュールを使用） |
| コンテナ | Docker（ローカル開発時は Docker Desktop 起動が必要） |

事前に必要なもの:

- GitHub アカウント
- Slack ワークスペース（App をインストールできる権限）
- Google アカウントと GCP プロジェクト（OAuth クライアントを作成できる権限）
- Amazon Bedrock で Claude モデルが有効化済みであること
- （Hosting へデプロイする場合）Amplify Hosting に接続する GitHub リポジトリ

## セットアップ

### 1. GitHub OAuth App の作成

1. GitHub の Settings → Developer settings → OAuth Apps から「New OAuth App」を押下
2. Application name は任意、Homepage URL は任意、Authorization callback URL は仮の URL で作成（手順 7 で差し替えます）
3. Client ID を控え、「Generate a new client secret」で Client Secret を控える（生成直後しか表示されません）

### 2. Slack App の作成

1. https://api.slack.com/apps → 「Create New App」→ From scratch でアプリを作成
2. OAuth & Permissions → Scopes の **User Token Scopes** に以下を追加（Bot Token Scopes ではない方）
   - `channels:history` / `channels:read` / `chat:write` / `search:read.public` / `users:read`
3. **Bot Token Scopes に `users:read` を 1 つ追加**してボットユーザーを作成する（ボットは実際には使われませんが、これがないと認可画面で「doesn't have a bot user to install」エラーになります）
4. アプリ設定の App Assistant ページ（`https://api.slack.com/apps/<APP_ID>/app-assistant`）で **MCP サーバーアクセスを有効化**する（無効のままだと Gateway からの呼び出しが 400 エラーになります）
5. Basic Information → App Credentials の Client ID / Client Secret を控える

> [!WARNING]
> OAuth & Permissions の PKCE 設定は**有効化しないでください**。この構成はクライアントシークレットを使うコンフィデンシャルクライアントであり PKCE は不要です。有効化するとアプリが「パブリッククライアント」としてマークされ、これは Slack サポートに連絡しないと戻せない不可逆操作です。

### 3. Google OAuth クライアントの作成

1. GCP コンソールで Google Calendar API を有効化する（API とサービス → ライブラリ）
2. OAuth 同意画面を設定する（User Type: External、公開ステータス: **テスト**のままにし、テストユーザーに自分の Google アカウントを追加。スコープに `https://www.googleapis.com/auth/calendar.readonly` を追加）
3. 認証情報 → OAuth クライアント ID → 種類は**ウェブアプリケーション**で作成（リダイレクト URI は仮で OK、手順 7 で登録します）
4. Client ID / Client Secret を控える

> [!NOTE]
> 同意画面が「テスト」ステータスのままなら、センシティブスコープ（calendar.readonly）でも Google の審査は不要です（テストユーザー 100 人まで）。認可時に「未確認アプリ」画面が出た場合は「続行」で通過できます。

### 4. クライアントシークレットを Secrets Manager に登録

```shell
aws secretsmanager create-secret \
  --name github-agent/oauth-client-secret \
  --secret-string '{"client_secret": "<GitHubのClient Secret>"}' \
  --region us-east-1

aws secretsmanager create-secret \
  --name slack-agent/oauth-client-secret \
  --secret-string '{"client_secret": "<SlackのClient Secret>"}' \
  --region us-east-1

aws secretsmanager create-secret \
  --name google-agent/oauth-client-secret \
  --secret-string '{"client_secret": "<GoogleのClient Secret>"}' \
  --region us-east-1
```

> [!WARNING]
> 必ず JSON 形式で登録してください。プレーン文字列だと CloudFormation の事前検証で `Required property [JsonKey] not found` になりデプロイが失敗します（EXTERNAL 参照は SecretId と JsonKey の両方が必須のため）。

### 5. sandbox で動かす（ローカル開発）

sandbox でも Gateway・Runtime を含む全リソースが作成されます。リソース名には環境ごとの接尾辞（sandbox は OS ユーザー名、Hosting はブランチ名）が付き、コールバック先は `http://localhost:5173/callback` に向きます。

クライアント ID はコミットせず、環境変数で渡します。

```shell
# Docker Desktop を起動しておく（エージェントイメージをローカルでビルドするため）
pnpm install
GITHUB_CLIENT_ID=<GitHubのClient ID> SLACK_CLIENT_ID=<SlackのClient ID> GOOGLE_CLIENT_ID=<GoogleのClient ID> \
  pnpm ampx sandbox      # バックエンドのデプロイ（変更監視つき）
pnpm dev                 # 別ターミナルで。http://localhost:5173
```

> [!NOTE]
> `ampx sandbox` の監視対象は amplify/ 配下のみです。agent/ のコードだけ変更した場合は `touch amplify/backend.ts` で再デプロイをトリガーしてください。

### 6. Amplify Hosting へのデプロイ

1. リポジトリを push し、Amplify コンソールから Hosting に接続する（ビルド設定は `amplify.yml` を使用）
2. Amplify コンソールの「環境変数」に `GITHUB_CLIENT_ID`・`SLACK_CLIENT_ID`・`GOOGLE_CLIENT_ID` を設定する
3. Amplify コンソールの「ビルドの設定」→「ビルドイメージ」を `public.ecr.aws/codebuild/amazonlinux-x86_64-standard:5.0` に変更する（標準イメージには Docker が無いため。amplify.yml 冒頭の 2 行がこのイメージ内で dockerd を起動し ARM64 ビルドを可能にします）
4. SPA のルーティング用に「書き換えて、リダイレクト」へ下記ルールを追加する（/callback への直接アクセス対応）

| 送信元アドレス | ターゲットアドレス | 入力 |
|--------------|------------------|------|
| `</^[^.]+$/>` | /index.html | 200（書き換え） |

### 7. 各サービスへのコールバック URL 登録

デプロイで作成された Credential Provider のコールバック URL を取得し、各サービスに登録します。Provider 名には環境の接尾辞が付きます（main ブランチなら `-main`、sandbox なら `-<OSユーザー名>`）。

```shell
# GitHub用（OAuth App の Authorization callback URL に設定）
aws bedrock-agentcore-control get-oauth2-credential-provider \
  --name github-provider-main --region us-east-1 \
  --query callbackUrl --output text

# Slack用（Slack App の OAuth & Permissions → Redirect URLs に追加）
aws bedrock-agentcore-control get-oauth2-credential-provider \
  --name slack-user-provider-main --region us-east-1 \
  --query callbackUrl --output text

# Google用（OAuth クライアントの「承認済みのリダイレクト URI」に追加）
aws bedrock-agentcore-control get-oauth2-credential-provider \
  --name google-provider-main --region us-east-1 \
  --query callbackUrl --output text
```

> [!NOTE]
> GitHub OAuth App に登録できるコールバック URL は 1 つだけです。sandbox と Hosting の両方で 3LO まで通す場合は、開発用の OAuth App をもう 1 つ作成して Client ID / シークレットを使い分けてください（Slack App の Redirect URLs と Google OAuth クライアントのリダイレクト URI は複数登録できます）。

> [!NOTE]
> Credential Provider を作り直すとコールバック URL も変わります（URL 末尾がプロバイダー固有 ID のため）。再デプロイでプロバイダーが再作成された場合は、各サービスへの再登録を忘れないでください。

## 動作確認

1. アプリにアクセスし、Cognito でサインアップ・ログインする
2. 「私のリポジトリを教えて」などと送信すると、初回は GitHub の認可リンクが表示される（エージェントは裏で 5 秒間隔のリトライで認可完了を待機）
3. リンクから認可を完了すると、コールバック画面に「アカウント連携が完了しました」と表示され、元のチャットで回答が自動で流れ始める
4. 「Slackで自分のメッセージを検索して」「今日の予定を教えて」などと送信すると、今度は Slack / Google の認可リンクが表示される。同様に認可すると回答が返る
5. 2 回目以降の質問は認可なしで即座に回答が返る（Token Vault にサービスごとのトークンが保管済みのため）

うまく動かない場合は [docs/troubleshooting.md](docs/troubleshooting.md) を参照してください。

## 設計メモ: Slack ターゲットの注意点

- **Slack MCP サーバーはユーザートークン（`xoxp-`）必須**です。AgentCore Identity のビルトイン `SlackOauth2` ベンダーは標準の `oauth.v2.access` を使うためボットトークンが保存されてしまい、ツール呼び出しが Authorization error で拒否されます。このサンプルでは `CustomOauth2` ベンダーでユーザーフロー専用エンドポイント（`slack.com/oauth/v2_user/authorize` と `slack.com/api/oauth.v2.user.access`）を明示しています
- **ターゲットは静的ツールスキーマ（`McpToolSchema.InlinePayload`）で定義**しています。Gateway がターゲット同期（`resources/list` 等）を行わないため、これらのメソッドを実装していない Slack MCP サーバーでも Lambda プロキシなしで READY になります

## 設計メモ: Google カレンダーターゲット（OpenAPI）の注意点

- Google には公式リモート MCP サーバーがないため、**Gateway の OpenAPI ターゲット**（REST API をそのまま MCP ツール化する Gateway 本来の主用途）で Calendar API に接続しています。OpenAPI ターゲットも MCP サーバーターゲットと同じ 3LO（Authorization Code）に対応しています
- OpenAPI 定義（`amplify/google-calendar-openapi.json`）は Calendar API の Discovery ドキュメントからの自動変換ではなく、**使う読み取り系 3 操作だけを手書き**しています（静的ツールスキーマの「厳選」方針と同じ。`operationId` がそのままツール名になるため、description と合わせてモデルのツール選択精度に直結します）
- スキーマは self-contained である必要があります（`$ref` 禁止）
- Google のアクセストークンは 1 時間で失効するため、ターゲットの OAuth 設定に **`CustomParameters: { access_type: 'offline', prompt: 'consent' }`** を指定し、リフレッシュトークンの発行を認可 URL に要求しています

## 運用メモ

- エージェントの更新: コードを修正して push するだけです。CDK アセットのハッシュが変わるため、新しいイメージが自動でビルド・デプロイされます（sandbox は `touch amplify/backend.ts`）
- 公開ツールの変更: `amplify/github-mcp-tools.json` / `amplify/slack-mcp-tools.json` / `amplify/google-calendar-openapi.json` を編集して再デプロイします。MCP サーバーの実スキーマから再生成する場合は `scripts/fetch_mcp_tools.py` の `SERVERS` の pick を編集して下記を実行します（Google の OpenAPI 定義は手書きなので直接編集します）

  ```shell
  # GitHub（トークンは読み取りだけなので gh CLI のもので構いません）
  GITHUB_TOKEN=$(gh auth token) uv run --with mcp python scripts/fetch_mcp_tools.py github

  # Slack（Slack App をワークスペースにインストールして得た User OAuth Token を使用）
  SLACK_TOKEN=xoxp-... uv run --with mcp python scripts/fetch_mcp_tools.py slack

  # ツール名の一覧だけ確認する場合
  SLACK_TOKEN=xoxp-... uv run --with mcp python scripts/fetch_mcp_tools.py slack --list
  ```
- トークンの有効期限: GitHub OAuth App のトークンはデフォルトで無期限です。不要になったら Credential Provider やトークンの削除を忘れないでください

## リソースの削除

- Amplify アプリを削除（Hosting・Cognito・Session Binding API に加え、CDK 管理の Gateway・ターゲット・Credential Provider・Runtime もまとめて削除されます）
- sandbox は `pnpm ampx sandbox delete`
- Secrets Manager のシークレット（github-agent/oauth-client-secret、slack-agent/oauth-client-secret、google-agent/oauth-client-secret）
- GitHub OAuth App / Slack App / Google OAuth クライアント

## ドキュメント

| ドキュメント | 内容 |
|-------------|------|
| [docs/architecture.md](docs/architecture.md) | 3LO フローの詳細、設計判断の理由（JWT パススルー / 静的ツールスキーマ / Session Binding 方式） |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 実際に踏んだエラーと対処（デプロイ・実行時・開発時） |
| [agent/README.md](agent/README.md) | エージェントの構成と SSE イベント仕様 |
