# トラブルシューティング

構築中に実際に踏んだエラーと対処のまとめです。症状から引けるように、デプロイ時・実行時・開発時に分けています。

## デプロイ時のエラー

### `Required property [JsonKey] not found`（Credential Provider の事前検証で失敗）

Secrets Manager のシークレットをプレーン文字列で登録していると、CloudFormation の事前検証（VALIDATION_FAILED）でスタックごと CREATE_FAILED になります。CFN スキーマ上、EXTERNAL の SecretReference は SecretId と JsonKey の両方が必須です。

対処: シークレットを JSON 形式（`{"client_secret": "..."}`）で登録し直し、ClientSecretConfig に `JsonKey: 'client_secret'` を指定します（backend.ts は対応済み）。

### `mcpToolSchema must be an object with 'tools' array`（ターゲットの CREATE_FAILED）

mcpToolSchema の InlinePayload にツール定義の配列を直接渡すと発生します。`{"tools": [...]}` 形式のオブジェクトでラップしてください。あわせて inputSchema に使えるキーは type / properties / required / items / description のみで、enum や default が残っていると弾かれます。

### 事前検証エラーの詳細が `describe-stack-events` に出ない

スタックレベルの「Validation failure detected」しか出ず、どのリソースのどのプロパティかが分かりません。新しい describe-events API で VALIDATION_ERROR イベントとして取得できます。

```shell
aws cloudformation describe-events \
  --stack-name <ネストスタックのARN> \
  --filters '{"FailedEvents": true}'
```

### ルートスタックが ROLLBACK_COMPLETE で止まった

一度も作成に成功していないスタックであれば、ampx（CDK）が次のデプロイで自動的に削除して作り直すため、手動削除は不要です。

### `FailedToBundleAsset` / `Command "esbuild" not found`

pnpm 利用時は esbuild と @types/node を devDependencies に明示的に追加する必要があります（ampx が `pnpm exec esbuild` で Lambda をバンドルするため）。package.json は対応済みです。ampx の実行は `pnpm ampx sandbox` を使います（`pnpm dlx` は不可）。

### CircularDependencyError（Lambda とカスタムスタックの相互参照）

defineFunction の Lambda と backend.ts で作るカスタムリソースが別スタックに配置されると循環参照になります。defineFunction に `resourceGroupName` を指定して同一スタックへ同居させ、backend.ts 側は `Stack.of(backend.sessionBinding.resources.lambda)` でそのスタックを取得しています。`backend.createStack` で同名のスタックを作ろうとすると「already been created」で衝突する点にも注意してください。

## 実行時のエラー

### `not authorized to perform GetWorkloadAccessTokenForJWT`（403）

Gateway ロールに `bedrock-agentcore:GetWorkloadAccessToken` しか付与していないと、ユーザー JWT を渡すアウトバウンド認証で 403 になります。JWT 用の別アクション `GetWorkloadAccessTokenForJWT` が必要です（`GetWorkloadAccessTokenForUserId` も合わせて付与。backend.ts は対応済み）。

### `kms:decrypt ... 403`（アウトバウンドのトークン交換で失敗）

アカウントの Token Vault（default）にカスタマーマネージド KMS キーが設定されていると発生します。過去にコンソールのクイックスタートを実行した場合などに設定されていることがあります。

```shell
# 確認
aws bedrock-agentcore-control get-token-vault
# サービス管理キーに戻す
aws bedrock-agentcore-control set-token-vault-cmk \
  --kms-configuration keyType=ServiceManagedKey
```

CMK 運用を続ける場合は、Gateway ロール等にそのキーの kms 権限を付与してください。

### /auth/complete が AccessDeniedException（GetSecretValue）で失敗

CompleteResourceTokenAuth の内部で Identity が呼び出し元（= Session Binding の Lambda）の権限でクライアントシークレットを取得します。Gateway ロールだけでなく Lambda にも EXTERNAL シークレットの `secretsmanager:GetSecretValue` が必要です（backend.ts は対応済み）。

### 認可は成功しているのにコールバック画面が「連携に失敗しました」になる（ローカル開発時）

React StrictMode（開発モード）で useEffect が二重実行され、/auth/complete が 2 連発します。1 回目は成功しますが、2 回目が DynamoDB のワンタイム遷移条件（PENDING → COMPLETED は一度だけ）に弾かれ、失敗表示で上書きされます。Binding 自体は成功しています。Callback.tsx では useRef の実行済みガードで対処済みです。Lambda のログに同時刻の 2 呼び出しが残るのが見分けるポイントです。

### Slack の認可は成功するのにツール呼び出しが Authorization error になる

ビルトインの `SlackOauth2` ベンダーで Credential Provider を作っていると発生します。認可フロー自体は正常に完了するのに、Token Vault に保存されるのがボットトークンのため、ユーザートークン必須の Slack MCP サーバーに拒否されます。`CustomOauth2` ベンダーでユーザーフロー専用エンドポイントを明示してください（backend.ts は対応済み。経緯は [architecture.md](architecture.md) の Slack ターゲットの節を参照）。

原因の切り分けには Gateway のログ配信が役立ちました。Gateway はデフォルトでログを出さないので、CloudWatch Logs の vended logs 配信（`put-delivery-source` / `put-delivery-destination` / `create-delivery`）を設定すると、アウトバウンド呼び出しの失敗理由（`MCP invocation failed: Authorization error ...` など）が確認できます。

### 認可済みのはずなのに再度認可を求められる

- Credential Provider を共有していても、ターゲットの初回呼び出しで再認可（-32042）が発生するケースを確認しています（トークンの紐付けがターゲット単位である可能性）
- 認可 URL（request_uri）の有効期限は 10 分です。期限切れの場合は新しいメッセージを送って認可リンクを再取得してください

## 開発時の注意

### agent/ を変更したのに sandbox が再デプロイされない

`ampx sandbox` のファイル監視はデフォルトで amplify/ 配下のみです。`touch amplify/backend.ts` で再デプロイをトリガーするか、`--dir-to-watch` を指定してください。

### エージェントのファイル構成を変えたら Runtime が即クラッシュする

`agent/` 内に .py ファイルを追加・リネームしたら Dockerfile の `COPY main.py gateway_auth.py memory_session.py ./` も忘れずに更新してください。

### Gateway のエラーがエージェントに届かないように見える

Gateway はアウトバウンド認証系の失敗を MCP プロトコルエラー（McpError）ではなく、ツール結果の isError=true + テキストで返すことがあります。現在の実装（strands の MCPClient）はどちらも吸収しますが、MCP SDK を直接使う場合は McpError の捕捉だけでは見逃します。また、`async with`（ClientSession / streamablehttp_client）の外まで McpError を伝播させると anyio の TaskGroup が ExceptionGroup に包むため `except McpError` にマッチしません。call_tool の直近で捕捉してください。

### デバッグの手掛かり

- Gateway のレスポンス詳細化: backend.ts で `ExceptionLevel: 'DEBUG'` を設定済み。エラーの詳細メッセージがツール結果で返ります
- エージェントのログ: CloudWatch Logs（Runtime のロググループ）
- Session Binding の状態: `aws dynamodb scan --table-name <TABLE_NAME>` で PENDING / COMPLETED と boundAt を確認できます
- Gateway 単体の疎通: ワークスペースの setup/test_gateway.py で、ツール一覧の取得と未認可時の elicitation エラーを直接確認できます

## AgentCore Memoryの実行時エラー

### `MEMORY_ID is not configured` / `MEMORY_REGION is not configured`

Runtimeの環境変数へMemoryのIDとリージョンが渡っていません。backend.tsのRuntime定義に`MEMORY_ID: memory.memoryId`と`MEMORY_REGION: stack.region`があること、デプロイ済みRuntimeの環境変数が古いままでないことを確認してください。Session Binding API Lambdaにも同じ環境変数が必要です。agent/だけを変更した場合と同様に、sandboxでは`touch amplify/backend.ts`で再デプロイをトリガーします。

### `AgentCore Memoryから会話セッションを取得できませんでした`

ブラウザ再読み込み時の`GET /conversation/session`、または「新しい会話」の`POST /conversation/session`が失敗しています。Session Binding APIの実行ロールにMemoryの`CreateEvent` / `ListEvents`権限があること、`conversation-index`セッションの短期イベントをMemory APIで取得できることを確認してください。会話UUIDはブラウザやDynamoDBには保存していません。

### `not authorized to perform CreateEvent` / `ListEvents`

Session Managerは短期Memoryへイベントを作成し、Agent生成時に履歴を一覧取得します。Runtime実行ロールへ次の権限が必要です。

- `memory.grantWrite(runtime)` — `bedrock-agentcore:CreateEvent`
- `memory.grantReadShortTermMemory(runtime)` — `GetEvent` / `ListEvents` / `ListActors` / `ListSessions`
- `memory.grantDeleteShortTermMemory(runtime)` — legacy移行・メッセージ置換時の`DeleteEvent`

CDKのgrantを追加した後にRuntimeが更新されているか、CloudWatch LogsのAccessDeniedメッセージと合わせて確認してください。

### `A Runtime session ID of 33-100 valid characters is required`

HTTP呼び出しに`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`が付いていないか、短すぎる値が渡されています。SPAはSession Binding APIからAgentCore Memoryの現在ポインタを取得し、そのUUIDを同ヘッダーへ設定します。UUIDは36文字なのでRuntimeとMemoryのsession ID制約を満たします。「新しい会話」ではMemory内ポインタが別UUIDへ更新されます。

### `A valid Bearer Authorization header is required` / `does not contain a valid Cognito sub`

RuntimeのCognito認証・Authorizationヘッダー転送を確認してください。Runtime authorizerがJWTを検証したうえで、backend.tsの`RequestHeaderAllowlist`に`Authorization`を含める必要があります。actor_idはpayloadではなく、検証済みJWTの`sub`からのみ導出されます。

### Memory APIの429 / 409 / 5xx

AgentCore MemoryのCreateEvent/ListEventsがスロットリングや一時的な競合・サービスエラーを返すことがあります。Session Managerとboto3のログをCloudWatch Logsで確認し、同じ会話の再送で再試行してください。現在は記憶なしで続行するフォールバックを設けていないため、ユーザーにはSSEの`error`イベントが表示されます。

## 動作確認済みのバージョン

| パッケージ | バージョン |
|-----------|-----------|
| bedrock-agentcore | 1.15.1 |
| strands-agents | 1.45.0 |
| mcp | 1.28.1 |
| aws-cdk-lib（2.255.0 以上必須） | 2.261.0 |
