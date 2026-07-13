# agent — Strands エージェント

AgentCore Runtime 上で動く Strands エージェントです。Gateway に MCP で接続してツールを取得し、GitHub アカウント・Slack ワークスペース・Google カレンダーに関する質問に回答します。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| main.py | エントリーポイント。JWT の取り出し、Gateway への MCP 接続、SSE ストリーミング |
| gateway_auth.py | 3LO の認可待ちを扱う strands フック（認可 URL の通知とリトライ） |
| Dockerfile | ARM64 イメージ。CDK が backend.ts のデプロイ時にアセットとしてビルド・push する |
| pyproject.toml | 依存定義（uv 管理） |
| requirements.txt | uv export で生成（Dockerfile が参照） |

## 動作の概要

1. Runtime に転送された Authorization ヘッダー（ユーザーの Cognito アクセストークン）を `context.request_headers` から取り出す
2. 同じ JWT を付けて Gateway に MCPClient で接続し、`list_tools_sync()` でツールを取得して Agent を組み立てる（JWT パススルー）
3. `stream_async` のイベントを SSE としてフロントエンドへ流す

エージェントが Gateway について知っているのは接続先 URL（環境変数 GATEWAY_URL）と認証ヘッダーだけで、GitHub / Slack / Google 用のツール実装はありません。ターゲットにツールが増えてもコード変更は不要です（Slack・Google カレンダーのターゲット追加時も、変わったのはシステムプロンプトの案内文だけでした）。

未認可時の扱いは gateway_auth.py の GatewayAuthHook に分離しています。Gateway が返す認可要求エラー（URL elicitation、strands の MCPClient が組み込みで解釈）を AfterToolCallEvent で検出し、認可 URL を一度だけフロントエンドへ通知したうえで、5 秒間隔で `event.retry = True` を立てて同じツール呼び出しをリトライさせます（タイムアウト 5 分）。リトライの実行自体は strands のフック機構に任せています。

## 環境変数

| 変数 | 内容 |
|------|------|
| GATEWAY_URL | Gateway の MCP エンドポイント。backend.ts が CloudFormation 参照で注入する |

## SSE イベント仕様（フロントエンドとの契約）

`data: {...}` 行として下記の JSON を流します。

| type | ペイロード | 意味 |
|------|-----------|------|
| text | data: 文字列 | 回答テキストの断片 |
| tool_use | tool_name: 文字列 | ツール呼び出しの開始（toolUseId 単位で重複排除済み） |
| auth_required | auth_url: 文字列 | 外部サービス（GitHub / Slack / Google）の認可が必要。フロントは /auth/pending を記録して認可リンクを表示する |
| error | data: 文字列 | エージェント内のエラー |

## 開発メモ

- 依存を変更したら requirements.txt を再生成してください:

  ```shell
  uv export --no-dev --no-hashes --no-emit-project \
    --format requirements-txt -o requirements.txt
  ```

- .py ファイルを追加・リネームしたら Dockerfile の COPY 行も更新してください（忘れると Runtime が起動時にクラッシュします）
- デプロイは backend.ts 経由です。sandbox では amplify/ 配下しか監視されないため、このディレクトリだけ変更した場合は `touch ../amplify/backend.ts` で再デプロイをトリガーします
- ログは CloudWatch Logs（Runtime のロググループ）に出ます
