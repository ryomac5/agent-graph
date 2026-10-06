# S12 runner の再起動

設計書の S12 の遷移を表す、本文と実機への依存を持たない構造標本。
実履歴の複製ではなく、ホストの契約を試すための入力である。

- `input.json`: 管理対象の Claude と Codex、観測だけの Codex、終了済みの Codex の事実と、再参加後の状態通知。
- `expected.json`: 追記する台帳の順序、実行と承認の投影、利用者に提示する再開操作。
- `recovery.test.ts`: 再送、順序の変更、SQLite の台帳からの再構築も確認する。

`Recovery.recover()` は旧実行の unknown 化と承認の失効を完了してから、
`AgentHost.resume()` を呼び、再参加した Codex のハンドルと Claude の resume 操作を返す。
Codex の `excludeTurns: true` はホスト側の契約実装が設定する。
再開時の入力は空にして元の依頼を再送しない。

返された `handles[].events` は監督側で消費する。
状態通知は台帳へ保存されてから消費側に渡り、その時点で unknown が解ける。
その他の出来事は消費側へ渡すため、通常の監督処理で保存する。
`actions` は再開操作を表示するための結果であり、Claude を自動で再起動しない。
同じ Recovery インスタンスの呼び出しは同じ結果を返す。
新しい runner の起動では新しいインスタンスを作る。

このタスクの scope は追加モジュールとテストだけである。
既存の `Supervisor` / CLI からの呼び出し接続は含めない。
