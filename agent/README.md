# agent — Strands エージェント

AgentCore Runtime 上で動く Strands エージェントです。Gateway に MCP で接続してツールを取得し、AgentCore Memoryの短期記憶をSession Manager経由で保存・復元しながら、GitHub アカウント・Slack ワークスペース・Google カレンダーに関する質問に回答します。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| main.py | エントリーポイント。`chat` / `connection_check` / `connection_probe` を分岐。JWT の取り出し、Gateway への MCP 接続、Memory Session Manager付きAgent生成、SSE ストリーミング |
| connections.py | 接続確認専用。`connection_check`（1回確認）と `connection_probe`（認可待ち）。LLM / Memory は使わない |
| memory_session.py | Runtime session_idと検証済みJWTのCognito `sub`からAgentCore Memory設定を構成 |
| gateway_auth.py | 3LO の認可待ちを扱う strands フック（認可 URL の通知とリトライ、provider 付きイベント） |
| tests/ | 接続プローブと認可フックの単体テスト |
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

チャット経路では、エージェントが Gateway について知っているのは接続先 URL（環境変数 GATEWAY_URL）と認証ヘッダーだけです。GitHub / Slack / Google 用のツール実装は持たず、Gateway の `list_tools_sync()` で取得したツールをそのまま Strands Agent に渡します。ターゲットにツールが増えても、チャット経路のコード変更は不要です（案内が必要ならシステムプロンプトだけ更新します）。

一方、接続確認経路（`connection_check` / `connection_probe`）では `connections.py` に provider と読み取りツール名の対応を固定しています。こちらは LLM を使わず決定的にツールを呼ぶため、ターゲット追加やツール名変更時は mapping の更新が必要です。

- `connection_check`: ツールを 1 回だけ呼び、成功なら `connected`、elicitation なら認可 URL を返さず `not_connected` で終了する（パネル自動確認用）
- `connection_probe`: 未連携時に `auth_required` を返し、認可完了まで最大 5 分リトライする（ユーザーが「連携する」を選んだとき）

未認可時の扱いは gateway_auth.py の GatewayAuthHook に分離しています。Gateway が返す認可要求エラー（URL elicitation）を AfterToolCallEvent で検出し、tool name から解決した provider 付きで認可 URL を一度だけフロントエンドへ通知したうえで、5 秒間隔で `event.retry = True` を立てて同じツール呼び出しをリトライさせます（タイムアウト 5 分、provider ごと）。認可後に同じ provider のツールが成功すると `connection_status: connected` を送ります。

接続確認は connections.py が MCPClient.call_tool_async を直接呼び、同様の再試行を行います。

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
| text | data: 文字列 | 回答テキストの断片（chat のみ） |
| tool_use | tool_name: 文字列 | ツール呼び出しの開始（chat のみ） |
| auth_required | provider: 文字列, auth_url: 文字列 | 外部サービスの認可が必要。フロントは /auth/pending を記録してから認可リンクを表示する |
| connection_status | provider: 文字列, status: checking \| connected \| not_connected | 接続確認の進行・結果 |
| error | data: 文字列, scope?: chat \| connection, provider?: 文字列, code?: 文字列 | エラー |

### Request payload

```json
{ "prompt": "..." }
```

または明示的に:

```json
{ "operation": "chat", "prompt": "..." }
```

状態確認のみ（認可待ちなし）:

```json
{ "operation": "connection_check", "provider": "github" }
```

認可開始を含む接続プローブ:

```json
{ "operation": "connection_probe", "provider": "github" }
```

`provider` は `github` / `slack` / `google_calendar` のみ。ブラウザから tool name は渡せません。`connection_check` / `connection_probe` では Strands Agent・LLM・Memory を起動しません。

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
