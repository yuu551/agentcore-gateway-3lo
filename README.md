# 3LO Agent — AgentCore Gateway 3LO フルサーバーレスサンプル

Amazon Bedrock AgentCore Gateway のアウトバウンド認証（ユーザー委任型認可 / 3LO）で、GitHub・Slack・Google カレンダーに接続するチャットエージェントです。Cognito でログインしたユーザーが「私のリポジトリを教えて」「Slackで自分のメッセージを検索して」「今日の予定を教えて」のように話しかけると、初回だけチャット内に各サービスの認可リンクが出て、認可を済ませるとエージェントが自動で処理を再開します。

1 つの Gateway に 3 つのターゲットを集約していて、公式リモート MCP サーバーがある GitHub / Slack は MCP サーバーターゲット、公式 MCP がない Google カレンダーは OpenAPI ターゲットで繋いでいます。この 2 方式の使い分けがこのリポジトリの見どころです。

| ターゲット | 接続方式 | 接続先 |
|-----------|---------|--------|
| GitHub | MCP サーバーターゲット（静的ツールスキーマ） | GitHub 公式リモート MCP サーバー |
| Slack | MCP サーバーターゲット（静的ツールスキーマ） | Slack 公式リモート MCP サーバー |
| Google カレンダー | OpenAPI ターゲット | Google Calendar API（REST） |

各サービスのアクセストークンは Gateway と Token Vault の間で完結するので、エージェントのコードにも Runtime のコンテナにもフロントエンドにも現れません。インフラは Amplify Gen 2 の backend.ts に集約してあり、シークレット登録さえ済ませておけばデプロイ 1 回で全リソースが立ち上がります。

## アーキテクチャ

![アーキテクチャ図](images/gateway-3lo-multi-target.drawio.png)

PNG には draw.io の XML を埋め込んであるので、draw.io で開けばそのまま編集できます。

| コンポーネント | 使用サービス | 役割 |
|---------------|-------------|------|
| フロントエンド | Amplify Hosting（React SPA） | チャット UI と OAuth コールバック画面 |
| ユーザー認証 | Amazon Cognito（Amplify Auth） | アプリへのログイン。アクセストークンを Runtime・Gateway の呼び出しにも利用 |
| エージェント | AgentCore Runtime + Strands Agents | Gateway の MCP ツールを呼び出すエージェント |
| ツール基盤 | AgentCore Gateway | GitHub / Slack の公式リモート MCP サーバーの中継と Google Calendar API のツール化を担い、アウトバウンド認証（3LO）でトークンを付与 |
| 認可基盤 | AgentCore Identity | GitHub / Slack / Google 用の Credential Provider と Token Vault |
| Session Binding API | API Gateway + Lambda + DynamoDB + AgentCore Memory | 認可フローの記録と Session Binding の完了、現在の会話UUIDのMemory保存・復元 |
| 会話メモリ | AgentCore Memory + Strands Session Manager | Cognitoユーザー・会話単位の短期会話履歴を90日保持・復元 |

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
│   ├── main.py                     # エントリーポイント（MCPClient / Session Manager）
│   ├── memory_session.py           # JWT actor_idとAgentCore Memoryセッションの構成
│   ├── gateway_auth.py             # 3LO 認可待ちを扱う strands フック（プロバイダー非依存）
│   └── Dockerfile                  # ARM64 イメージ（CDK がアセットとしてビルド）
├── scripts/
│   └── fetch_mcp_tools.py          # MCPサーバーから静的ツールスキーマを生成（github / slack）
├── src/                            # React SPA
│   ├── App.tsx                     # チャット UI（SSE / 会話セッション / 認可カード）
│   ├── conversationSession.ts      # AgentCore Memoryの会話セッションAPIクライアント
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

このほかに、GitHub アカウント、App をインストールできる Slack ワークスペース、OAuth クライアントを作成できる GCP プロジェクトが必要です。Amazon Bedrock で Claude モデルを有効化しておいてください。Hosting へデプロイする場合は、接続する GitHub リポジトリも用意します。

## セットアップ

### 1. GitHub OAuth App の作成

1. GitHub の Settings → Developer settings → OAuth Apps から「New OAuth App」を押下
2. Application name と Homepage URL は任意、Authorization callback URL は仮の URL で作成（手順 7 で差し替えます）
3. Client ID を控え、「Generate a new client secret」で Client Secret を控える（生成直後しか表示されません）

### 2. Slack App の作成

1. https://api.slack.com/apps → 「Create New App」→ From scratch でアプリを作成
2. OAuth & Permissions → Scopes の User Token Scopes（Bot Token Scopes ではない方）に `channels:history` / `channels:read` / `chat:write` / `search:read.public` / `users:read` を追加
3. Bot Token Scopes にも `users:read` を 1 つだけ追加してボットユーザーを作成する。ボット自体は使いませんが、これがないと認可画面が「doesn't have a bot user to install」エラーになります
4. アプリ設定の App Assistant ページ（`https://api.slack.com/apps/<APP_ID>/app-assistant`）で MCP サーバーアクセスを有効化する。無効のままだと Gateway からの呼び出しが 400 エラーになります
5. Basic Information → App Credentials の Client ID / Client Secret を控える

> [!WARNING]
> OAuth & Permissions の PKCE 設定は有効化しないでください。この構成はクライアントシークレットを使うコンフィデンシャルクライアントなので PKCE は不要です。有効化するとアプリが「パブリッククライアント」としてマークされ、Slack サポートに連絡しないと戻せなくなります。

### 3. Google OAuth クライアントの作成

1. GCP コンソールで Google Calendar API を有効化する（API とサービス → ライブラリ）
2. OAuth 同意画面を設定する。User Type は External、公開ステータスは「テスト」のままにし、テストユーザーに自分の Google アカウントを追加。スコープに `https://www.googleapis.com/auth/calendar.readonly` を追加
3. 認証情報 → OAuth クライアント ID から、種類「ウェブアプリケーション」で作成（リダイレクト URI は仮で OK、手順 7 で登録します）
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

## 会話の短期記憶

このサンプルはAgentCore Memoryの短期記憶だけを使用します。長期記憶の抽出戦略は設定していません。

- ブラウザには会話UUIDを保存しません。認証済みのSession Binding APIがAgentCore Memory内の`conversation-index`セッションへ現在の会話UUIDを保存・復元します
- Cognito JWTの`sub`をMemoryの`actorId`に使うため、ユーザーごとに現在の会話ポインタと会話イベントが分離されます
- ブラウザ再読み込み時はMemory APIから現在のUUIDを取得し、Runtime呼び出しの`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`へ設定します
- AgentCore Memoryのイベントは90日保持され、Strandsの`AgentCoreMemorySessionManager`がRuntime invocation間の履歴を復元・保存します
- 「新しい会話」ではMemory内の現在ポインタを新しいUUIDへ更新します。過去会話一覧は提供せず、旧イベントは保持期間で失効します

Runtimeセッションと、3LO認可用のSession Binding APIで扱う`session_id`は別物です。前者は会話の実行環境・短期記憶の識別、後者はOAuth認可フローのワンタイム紐付けに使います。Session Binding APIの会話用エンドポイントは、後者のOAuth状態とは別に、AgentCore Memoryだけを会話状態の保存先として使います。

## Slack ターゲットの設計メモ

Slack MCP サーバーはユーザートークン（`xoxp-`）でしか呼び出せません。ところが AgentCore Identity のビルトイン `SlackOauth2` ベンダーは標準の `oauth.v2.access` を使うため、Token Vault にボットトークンが保存されてしまい、ツール呼び出しが Authorization error で拒否されます。実際にここで一度はまりました。このサンプルでは `CustomOauth2` ベンダーでユーザーフロー専用エンドポイント（`slack.com/oauth/v2_user/authorize` と `slack.com/api/oauth.v2.user.access`）を明示することで回避しています。

また、ターゲットは静的ツールスキーマ（`McpToolSchema.InlinePayload`）で定義しています。Gateway がターゲット同期（`resources/list` 等）を行わなくなるので、これらのメソッドを実装していない Slack MCP サーバーでも Lambda プロキシを挟まずに READY になります。

## Google カレンダーターゲットの設計メモ

Google には公式リモート MCP サーバーがないため、Gateway の OpenAPI ターゲット（REST API をそのまま MCP ツール化する機能）で Calendar API に接続しています。OpenAPI ターゲットも MCP サーバーターゲットと同じ 3LO（Authorization Code）に対応しています。

OpenAPI 定義（`amplify/google-calendar-openapi.json`）は Calendar API の Discovery ドキュメントから自動変換したものではなく、使う読み取り系 3 操作だけを手書きしたものです。`operationId` がそのままツール名になり、description と合わせてモデルのツール選択精度に直結するので、静的ツールスキーマと同じ「厳選」方針を採っています。なお、スキーマは self-contained である必要があります（`$ref` は使えません）。

Google のアクセストークンは 1 時間で失効します。そこでターゲットの OAuth 設定に `CustomParameters: { access_type: 'offline', prompt: 'consent' }` を指定し、リフレッシュトークンの発行を認可 URL に要求しています。

## 運用メモ

エージェントを更新するときは、コードを修正して push するだけです。CDK アセットのハッシュが変わるため、新しいイメージが自動でビルド・デプロイされます（sandbox は `touch amplify/backend.ts`）。

公開ツールを変えたいときは `amplify/github-mcp-tools.json` / `amplify/slack-mcp-tools.json` / `amplify/google-calendar-openapi.json` を編集して再デプロイします。Google の OpenAPI 定義は手書きなので直接編集してください。GitHub / Slack を MCP サーバーの実スキーマから再生成する場合は、`scripts/fetch_mcp_tools.py` の `SERVERS` の pick を編集して下記を実行します。

```shell
# GitHub（トークンは読み取りだけなので gh CLI のもので構いません）
GITHUB_TOKEN=$(gh auth token) uv run --with mcp python scripts/fetch_mcp_tools.py github

# Slack（Slack App をワークスペースにインストールして得た User OAuth Token を使用）
SLACK_TOKEN=xoxp-... uv run --with mcp python scripts/fetch_mcp_tools.py slack

# ツール名の一覧だけ確認する場合
SLACK_TOKEN=xoxp-... uv run --with mcp python scripts/fetch_mcp_tools.py slack --list
```

GitHub OAuth App のトークンはデフォルトで無期限です。不要になったら Credential Provider やトークンの削除を忘れないでください。

## リソースの削除

Amplify アプリを削除すると、Hosting・Cognito・Session Binding API に加え、CDK 管理のGateway・ターゲット・Credential Provider・Runtime・AgentCore Memoryもまとめて消えます。sandbox は `pnpm ampx sandbox delete` です。

以下は手動で削除します。

- Secrets Manager のシークレット（github-agent/oauth-client-secret、slack-agent/oauth-client-secret、google-agent/oauth-client-secret）
- GitHub OAuth App / Slack App / Google OAuth クライアント

## ドキュメント

| ドキュメント | 内容 |
|-------------|------|
| [docs/architecture.md](docs/architecture.md) | 3LO フローと短期Memoryの詳細、設計判断の理由（JWT パススルー / actor・session分離 / 静的ツールスキーマ / Session Binding 方式） |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 実際に踏んだエラーと対処（デプロイ・実行時・開発時） |
| [agent/README.md](agent/README.md) | エージェントの構成と SSE イベント仕様 |
