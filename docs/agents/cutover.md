# v2 の常駐と接続への切り替え

## 手順

新しい画面の一覧と会話と受け箱と Changes が利用できることを切り替え前に確認する。
切り替えに使う作業コピーでは依存の導入と新しい画面のビルドをあらかじめ完了させておく。
旧い作りで動いている委譲はすべて完了させてから常駐と接続の切り替えの手順を開始する。
最初に次の dry-run を実行して常駐の登録先と接続先と移行対象の旧い DB を確認する。

```bash
bash scripts/setup.sh --v2 --dry-run
bash scripts/setup.sh --v2
```

導入は旧い daemon の登録を外してから新しい api による画面の配信を開始する。
旧い DB は api の migrate によって読み取り専用で開かれた後に新しい台帳へ移される。
再実行したときも同じ旧い事実は新しい台帳で重複しないため失敗後は同じ導入をやり直す。
旧い repos のうち作業ツリーと一時の場所を除いた通常のリポジトリだけを登録する。
Git の共通ディレクトリが一致する登録先は新しい台帳で一つのプロジェクトにまとめる。
Claude と Codex の接続設定は新しい hook と shim の接続先へ切り替わる。
既存の Claude と Codex の会話は切り替えを反映するために導入が完了してから開き直す。

## 確認

次の診断コマンドで runner と api の常駐状態と両クライアントの接続先を確認する。

```bash
bash scripts/setup.sh --doctor
launchctl print "gui/$(id -u)/dev.agent-graph.runner"
launchctl print "gui/$(id -u)/dev.agent-graph.api"
launchctl print "gui/$(id -u)/dev.agent-graph.daemon"
open http://127.0.0.1:7420/
```

旧い daemon の確認が未登録になり新しい二つの常駐が稼働していることを確認する。
診断結果では Claude と Codex のすべての接続設定が v2 を向くことを確認する。
新しい画面で登録したプロジェクトと移した会話を確認してから新しい会話を一つ開始する。
旧キットの counter の更新時刻が変わらないことを切り替え後の確認項目に含める。
状態の置き場は XDG_STATE_HOME の指定先にある専用のディレクトリになる。

```text
~/.local/state/agent-graph/agent-graph.db
~/.local/state/agent-graph/runner.sock
~/.local/state/agent-graph/outbox/
~/.local/state/agent-graph/run/runner/daemon.stderr.log
~/.local/state/agent-graph/run/api/daemon.stderr.log
~/.local/state/agent-graph/cutover-v1-daemon.plist
```

稼働中の runner の設定が変わる場合は実行を終えて停止した後に同じ導入を再実行する。
api だけの更新では runner を再起動しないため動いているエージェントの実行は続く。

## 戻し方

旧いコードが残っている間は次の dry-run で復元対象を確認してから v1 へ戻せる。

```bash
bash scripts/setup.sh --rollback-v1 --dry-run
bash scripts/setup.sh --rollback-v1
bash scripts/setup.sh --doctor
open http://127.0.0.1:7420/
```

戻す操作は v2 の常駐を外してから保存しておいた旧い daemon の登録内容を復元する。
Claude と Codex の接続設定は旧い hook と shim の接続先へ戻される。
戻す操作を終えた後は既存の Claude と Codex の会話を開き直して旧い接続先を使う。
旧い DB と旧いコードは切り替えの導入でも戻す操作でも削除せずにそのまま保持する。
新しい台帳は戻す操作の後も残るため問題を調査する際の記録として引き続き利用できる。
新しい台帳に追記された事実は旧い DB へ反映されないため旧い画面からは閲覧できない。
