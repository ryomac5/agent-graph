# S10

sessions.json は旧キットの会話 ID → 名前の辞書形式。レビューに記録された共有番号と枝番号の構造を残し、本文は含めない。

agent-graph と dotfiles の二つの登録プロジェクトを読む。delayed.sessions.json は遅延 hook より先の番号の更新、partial.sessions.json は更新途中の障害を表す。expected-ledger.json は別名の事実の固定部分、expected-projection.json は別名の投影。新しい採番との独立性と counter を読まず書かないことはテストで確認する。
