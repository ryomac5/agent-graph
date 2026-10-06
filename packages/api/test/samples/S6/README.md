# S6（Codex 0.160.1）

session_meta / event_msg は architecture-review の rollout 構造、method / params の通知と collabAgentToolCall は app-server-spike-rerun の構造を写した架空標本。
通知は同じ読み取り境界に渡せる正規化済み JSONL として収録しており、実際の rollout に必ず保存されると主張するものではない。
二つの会話は独立に実行される。子の turn/started が spawnAgent の完了より先に届く。
長時間のターン、承認要求、waitingOnApproval、承認解除、turn 完了を含む。
テストで同じファイルを archived_sessions に移動し、sessions へ復帰して追記する。
すべての本文・識別子・パスは架空。PID は取り込まず、ホストの共有を会話の同一性や終了の根拠にしない。
