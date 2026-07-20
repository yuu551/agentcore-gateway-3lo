# agent — Strands エージェント

AgentCore Runtime 上で動く Strands エージェントです。Gateway に MCP で接続してツールを取得し、AgentCore Memoryの短期記憶をSession Manager経由で保存・復元しながら、GitHub アカウント・Slack ワークスペース・Google カレンダーに関する質問に回答します。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| main.py | エントリーポイント。JWT の取り出し、Gateway への MCP 接続、Memory Session Manager付きAgent生成、SSE ストリーミング |
| memory_session.py | Runtime session_idと検証済みJWTのCognito `sub`からAgentCore Memory設定を構成 |
| gateway_auth.py | 3LO の認可待ちを扱う strands フック（認可 URL の通知とリトライ） |
| tests/test_memory_session.py | JWT・ユーザー/会話分離・Session Manager設定の単体テスト |
| Dockerfile | ARM64 イメージ。CDK が backend.ts のデプロイ時にアセットとしてビルド・push する |
| pyproject.toml | 依存定義（uv 管理） |
| requirements.txt | uv export で生成（Dockerfile が参照） |

## 動作の概要

1. Runtimeから転送されたAuthorizationヘッダー（Cognitoアクセストークン）と`context.session_id`を受け取る
2. Runtime authorizerが検証したJWTの`sub`をactor_idにし、`MEMORY_ID`・`MEMORY_REGION`・Runtime session_idから`AgentCoreMemoryConfig`を構成する。リクエストpayloadのユーザーIDは使わない
3. `AgentCoreMemorySessionManager(async_mode=True, batch_size=1)`を`Agent`へ渡し、Agent生成時に同じactor/sessionの短期履歴を復元する
4. 同じJWTを付けてGatewayにMCPClientで接続し、`list_tools_sync()`でツールを取得してAgentを組み立てる（JWTパススルー）
5. `stream_async`のイベントをSSEとしてフロントエンドへ流し、各メッセージをAgentCore Memoryへ即時保存する

RuntimeのセッションIDと3LO認可用のSession Binding APIの`session_id`は別物です。RuntimeセッションはSession Binding APIがAgentCore Memoryの`conversation-index`セッションから取得・更新した会話UUIDを使い、Memoryでは同じ値をsession_id、Cognito JWTの`sub`をactor_idとして使います。会話UUIDはブラウザへ永続化せず、会話状態の保存先はAgentCore Memoryだけです。
エージェントが Gateway について知っているのは接続先 URL（環境変数 GATEWAY_URL）と認証ヘッダーだけで、GitHub / Slack / Google 用のツール実装はありません。ターゲットにツールが増えてもコード変更は不要です（Slack・Google カレンダーのターゲット追加時も、変わったのはシステムプロンプトの案内文だけでした）。

未認可時の扱いは gateway_auth.py の GatewayAuthHook に分離しています。Gateway が返す認可要求エラー（URL elicitation、strands の MCPClient が組み込みで解釈）を AfterToolCallEvent で検出し、認可 URL を一度だけフロントエンドへ通知したうえで、5 秒間隔で `event.retry = True` を立てて同じツール呼び出しをリトライさせます（タイムアウト 5 分）。リトライの実行自体は strands のフック機構に任せています。

## 環境変数

| 変数 | 内容 |
|------|------|
| GATEWAY_URL | Gateway の MCP エンドポイント。backend.ts が CloudFormation 参照で注入する |
| MEMORY_ID | CDKで作成した短期AgentCore MemoryのID |
| MEMORY_REGION | Memoryデータプレーンを呼び出すリージョン（通常はRuntimeと同じ） |

## SSE イベント仕様（フロントエンドとの契約）

`data: {...}` 行として下記の JSON を流します。

| type | ペイロード | 意味 |
|------|-----------|------|
| text | data: 文字列 | 回答テキストの断片 |
| tool_use | tool_name: 文字列 | ツール呼び出しの開始（toolUseId 単位で重複排除済み） |
| auth_required | auth_url: 文字列 | 外部サービス（GitHub / Slack / Google）の認可が必要。フロントは /auth/pending を記録して認可リンクを表示する |
| error | data: 文字列 | エージェント内のエラー（Memory設定・復元・保存エラーを含む） |

## 短期Memoryの設計

- Memoryは`memoryStrategies`なしで作成し、長期記憶の抽出は行いません
- 会話イベントはAgentCore Memoryに90日保持します。新しい会話へ切り替えても、以前のイベントをアプリから即時削除することはありません
- `batch_size=1`で保存するため、正常なターンが完了するとメッセージは即時に作成されます。`async_mode=True`により、各ターンのboto3呼び出しはイベントループを塞がないように処理します
- Memoryの設定不備、IAM拒否、復元・保存APIの失敗はステートレス回答へ黙ってフォールバックせず、SSEの`error`イベントとしてフロントエンドへ返します
- Runtime authorizerがJWTを検証済みであることを前提に、JWTを署名検証せずデコードして`sub`を取り出します。payloadに渡されたactor_idは使用しません

## 開発メモ

- 依存を変更したら requirements.txt を再生成してください:

  ```shell
  uv export --no-dev --no-hashes --no-emit-project \
    --format requirements-txt -o requirements.txt
  ```

- 単体テストは次で実行します:

  ```shell
  uv run python -m unittest discover -s tests -v
  ```

- .py ファイルを追加・リネームしたら Dockerfile の COPY 行も更新してください（忘れると Runtime が起動時にクラッシュします）
- デプロイは backend.ts 経由です。sandbox では amplify/ 配下しか監視されないため、このディレクトリだけ変更した場合は `touch ../amplify/backend.ts` で再デプロイをトリガーします
- ログは CloudWatch Logs（Runtime のロググループ）に出ます
