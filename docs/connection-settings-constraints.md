# 連携設定の制約

## この文書の目的

連携設定では、接続確認は並列に動かせます。一方、OAuth 認可は同時に 1 件しか開始できません。画面だけを見ると同じ「外部サービスへの接続」に見えるため、この違いと変更時の注意点を残します。

対象は GitHub、Slack、Google カレンダーです。実装の全体像は [architecture.md](architecture.md)、画面設計は [connection-settings-design.md](connection-settings-design.md) を参照してください。

## 現在の動作

| 操作 | 同時実行 | 理由 |
|---|---|---|
| パネル初回表示の接続確認 | 3 サービスで可能 | `connection_check` は認可を始めず、各 Runtime 呼び出しが独立している |
| 手動の「確認」「再確認」 | 別サービスなら可能 | provider ごとに request と AbortController を分けている |
| 同じサービスの接続確認 | 不可 | 古いイベントによる上書きと重複呼び出しを防ぐ |
| 接続確認中のチャット送信 | 不可 | 短時間でも Runtime 呼び出し同士を競合させない |
| 「連携する」から始める OAuth 認可 | 1 サービスのみ | Session Binding の PENDING レコードがユーザーごとに 1 件 |
| 認可中のチャット送信 | 不可 | 同じユーザーの認可フローと通常のツール実行を競合させない |

接続確認には `connection_check`、認可には `connection_probe` を使います。名前は似ていますが、終了条件が違います。

`connection_check` は読み取りツールを 1 回だけ呼びます。未連携なら認可 URL を捨てて `not_connected` を返すため、3 サービスを並列実行しても Session Binding のレコードは作られません。

`connection_probe` は未連携時に認可 URL を返し、認可完了を最大 5 分待ちます。フロントエンドは URL を表示する前に `POST /auth/pending` を呼び、コールバックでは `POST /auth/complete` を呼びます。

## 認可を並列化していない理由

Session Binding 用 DynamoDB テーブルのパーティションキーは `userId` です。`POST /auth/pending` は次の形で 1 レコードを保存します。

```text
userId = Cognito JWT の sub
status = PENDING
ttl = 現在時刻 + 15分
```

同じユーザーが別サービスの認可を始めると、後から書いた PENDING が前のレコードを上書きします。コールバック側も `userId` だけでレコードを探すため、どの認可 URL から戻ったのかを DynamoDB 上で区別できません。

この状態で複数の `connection_probe` を許可すると、次の問題が起きます。

- 先に開いた認可フローが、後から始めたフローの PENDING を使って完了する
- 一方の完了でレコードが `COMPLETED` になり、もう一方が 403 になる
- 失敗時の PENDING へのロールバックが、別サービスの状態を上書きする

フロントエンドのボタン制御だけの問題ではありません。認可を並列化する場合は、Session Binding のデータモデルから変更する必要があります。

## 並列認可へ変更する条件

最小構成は、DynamoDB のキーを `userId + sessionId` または `userId + flowId` に変える方法です。

1. `auth_required` の URL から `request_uri` を取り出す
2. `POST /auth/pending` にフローを識別する値を渡す
3. DynamoDB へユーザーとフローの組み合わせで PENDING を保存する
4. `/callback` の `session_id` と一致するレコードだけを `COMPLETED` にする
5. 失敗時も同じレコードだけを PENDING へ戻す

この変更では既存テーブルのキー構成が変わるため、CloudFormation 上はテーブルの置換になります。PENDING は 15 分で失効する一時データですが、デプロイ中の認可フローは完了できなくなります。

フロントエンド側では `connection_probe` の全体ロックを外し、provider ごとの状態と request を使います。Runtime 呼び出しはすでに provider ごとの session ID と AbortController を持つため、土台は流用できます。

実装後は最低でも、2 サービスの PENDING が共存すること、一方の完了・失敗・期限切れが他方へ影響しないこと、同じ `session_id` を再利用できないことをテストします。

## コールバックタブの自動クローズ

`POST /auth/complete` が成功した場合だけ、完了表示の 1 秒後に `window.close()` を呼びます。失敗時は原因を確認できるようタブを閉じません。

ブラウザは、スクリプトから開かれていないタブの `window.close()` を拒否することがあります。通常の導線では認可リンクを `target="_blank"` で開くため自動クローズの対象になりやすいものの、ブラウザのポリシーや URL の開き方によっては閉じられません。

自動クローズに失敗しても認可処理は完了しています。画面には「このタブを閉じる」ボタンと、元の画面へ戻る案内を残します。

## 接続状態キャッシュの境界

ブラウザへ保存するのは `connected` または `not_connected` と確認時刻だけです。保存先は `sessionStorage`、有効期間は 5 分で、Cognito のユーザー ID が一致する場合だけ読み込みます。

OAuth トークン、認可 URL、provider のレスポンス本文、エラー本文は保存しません。キャッシュ値は `前回: 連携済み` のように表示し、パネルを開いたときに最新状態へ置き換えます。外部サービス側で認可が取り消されても、前回値を確定情報として表示し続けないためです。

## 変更時の確認項目

- 別サービスの「再確認」を続けて押すと、両方が `確認中` になる
- 1 件の確認失敗が、他サービスの結果を上書きしない
- 認可中は別サービスの「連携する」を開始できない
- `/auth/complete` が成功した場合だけコールバックタブを閉じる
- 自動で閉じられない場合も完了状態と手動ボタンが残る
- ブラウザへトークンや認可 URL が保存されていない
