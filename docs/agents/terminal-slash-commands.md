# ダッシュボードの端末送信とスラッシュコマンド

2026-10-13。対象は api が PTY で保持する Claude Code / Codex と dashboard。
runner の SDK / app-server の `send` とは別の `session.send` 経路である。
投影版・schema 版・台帳の事実の型は変更しない。

## 原因

従来の `inputReady` は起動後の静穏時間だけで真になり、以後は戻らなかった。
そのため、コマンドが開いた画面にも Ctrl+U、bracketed paste、Enter を送り、成功を返していた。
jsonl に発言を書かないパネルは画面に届かず、その後の入力も失われた。
さらに SendWatch は `/` で始まる入力を無条件に除外していた。
resume の識別確認前に受けた送信も、保留配列に入れて先に成功を返し、後の失敗を捨てていた。

## 送信の契約

- api は PTY の全出力を `@xterm/headless` 6.0.0（MIT）に流す。サイズ変更も同期する。
- 描画を解釈し終えた画面で、現在のカーソルを含む会話入力欄を確かめる。履歴の `❯` だけでは認めない。
- 起動の静穏待ちは残すが、15 秒経過を入力可能の根拠にはしない。
- 送信は端末単位で直列化し、貼り付け前と Enter 前に確認する。
- 認識できない画面、パネル、選択画面は失敗 ack にする。本文を投げず、ブラウザは下書きを保持して同じ端末を開く。
- 貼り付け中に端末タブの入力や Interrupt が入った場合も Enter を送らない。
- resume の識別確認前も実際の送信まで待つ。保留配列への登録を配達成功とはしない。
- コマンド末尾を空白で確定し、Claude の曖昧一致メニューの先頭を Enter で誤実行しない。
- 通常の送信と skill の配達は引き続き SendWatch と jsonl で照合する。端末への書き込みだけでモデルの受信を保証しない。

## コマンド結果

`session.send` の ack.result に次を追加する。

- `command: { text, output, status: 'completed' | 'interactive' }`
- `terminalId`: 選択を続ける端末
- `conversationId`: `/clear` などで実際に変わった送信先
- `delivery: 'terminal'`: 画面の結果を取得した、または人に端末を引き継ぐ場合。jsonl に発言がないことによる誤った未配達表示を作らない

画面の結果は秘匿してから ack の再送用メモリに置く。台帳・検索・投影には追加せず、会話の一時表示にする。
同じ cmd_id の再送は既存の ack を返し、コマンドを再実行しない。
スラッシュの文字列だけでは SendWatch を除外しない。`<command-name>` / `<command-args>` は配達照合用に正規化する。

`/help`、`/cost`、`/usage`、`/context` は既知の読み取り画面の見出しも確認してから本文を取り、Esc を送る。
入力欄への復帰が確認できてから completed を返す。未知の画面やクローズ失敗は interactive とし、その端末を開く。
`/model` などの選択画面には Esc を送らない。

ChoiceMenu への写し替えは採用しない。Claude Code 2.1.296 の実機ではモデル選択に加え、左右キーによる effort、Enter による既定値保存、`s` による会話限定の選択がある。
端末タブへの引き継ぎを実装し、`s` で Haiku を選んで入力へ戻り、その後の `/cost` が成功することを確かめた。
端末の画面と操作の対応を作り直さず、実際の選択肢を保持できる。

`/clear` は同じ PTY の native session ID を変える。
送信前とホスト一覧の要求時、コマンドの実行後に ID を再確認し、古い ID 宛ての送信は拒否する。
ブラウザは返された ID の会話へ移動する。履歴は既存の jsonl 取り込みを使う。
`/compact` は既存の `compact_boundary` の投影を使い、会話を新設しない。

## 候補の取得範囲

`session.commands` は会話のホストの provider / cwd を優先し、未起動なら登録済み project から cwd を解決する。
候補表示のために TUI の入力や利用者の設定は変更しない。

- Claude の基本的な組み込みコマンドは、公式一覧に基づくカタログを持つ。
- `CLAUDE_CONFIG_DIR`（未指定なら `~/.claude`）の skills / commands を読む。
- cwd から Git 作業ツリーの根までの `.claude/skills` / `.claude/commands` を読む。
- 作業ツリーの根に skills がなければ、`.git` の commondir から本体の skills を読む。
- user / project / local の settings の enabledPlugins と installed_plugins.json を照合し、そのプロジェクトに適用される plugin だけを読む。
- plugin の skills、commands、manifest の追加ディレクトリ・ファイル・コマンド定義を読む。呼び出し名に plugin の namespace を付ける。
- symlink の skill、description の折り返し、argument-hint に対応する。user-invocable: false と skillOverrides: off は表示しない。
- personal を project より優先し、同じ名前では skill を legacy command より優先する。
- フォーカスを textarea に保ち、上下キー、Enter / Tab、クリックで補完する。Esc で候補を閉じ、Meta+Enter は送信する。

ローカルに読める設定からの候補であり、CLI が公開する完全な動的カタログではない。
認証・plan・CLI バージョンに依存する全コマンド、起動後に発見された nested skill、MCP prompt、クラウド同期の skill、管理者配布の独自配置は列挙しない。
SSH の会話にローカルの skill を混ぜない。SSH は組み込みカタログのみ。
Codex の skill 呼び出しは `$name` なので、この `/` 候補には Codex の組み込みだけを出す。

参照:
- [Claude commands](https://code.claude.com/docs/en/commands)
- [Claude skills](https://code.claude.com/docs/en/skills)
- [Plugin manifest](https://code.claude.com/docs/en/plugins-reference)
- [xterm buffer](https://xtermjs.org/docs/api/terminal/interfaces/ibuffer/)

## 実機と制限

状態と使い捨て会話の cwd を作業ツリー内の `.agents/slash-smoke` に隔離した。
本番の agent-graph の状態・socket・.endpoint と、既存会話は使用していない。

- Claude Code 2.1.296 / haiku: `/help`、`/cost` の本文取得とクローズを確認。
- `/model`: 選択を保持、次の通常文は即時エラー。端末で `s` を押すと復帰し、その後の `/cost` が成功。
- `/clear`: 新しい native ID への切り替えを確認。新しい jsonl に clear と次の通常文が記録された。
- `/compact`: `Not enough messages to compact.` を一時結果として取得し、新しい jsonl にコマンドが記録された。隔離環境から Keychain の認証情報を取得できず、モデルの応答は `Not logged in` となるため、正常な圧縮完了は確認できていない。
- 実機が生成した jsonl を隔離した observation service で取り込み、7 会話・24 メッセージを投影した。`/clear`・`/compact`・次の通常文の反映を確認。成功した compact_boundary はない。
- 別 port の作業ツリー api を programmatic に起動したが、`listen EPERM 127.0.0.1` で拒否された。そのため実機は同じ `createSessionHosts` を直接呼んで確認。ブラウザと実機を接続する e2e は未確認。
- Codex 0.160.1: 通常起動は `ps` の EPERM、`--no-daemon` も `account/read … workspace routing discovery failed` で失敗。実機のパネル挙動は未確認。
- Codex の観測会話も同じ PTY の送信経路であり、画面判定とエラー ack を共通で適用する。一方、runner が管理する Codex は app-server の `send` 経路で、TUI のメニューは経由しない。
- 未対応の TUI の版や画面は入力可能と推定せず失敗にする。画面判定の標本を更新する必要がある。
- 本検証の hosts は finally で閉じた。最初の画面調査用 probe 1 本だけは stdin が閉じ、別プロセスからの終了も EPERM となったため、終了を確認できていない。隔離した `.agents/slash-smoke/claude` を使うプロセスで、本番の会話ではない。

回帰試験は api の terminal-screen / session-hosts / slash-commands / send-watch と dashboard の slash-commands に置く。
旧 HEAD の hosts.ts を読み込み時にだけ差し替えると、パネル拒否・結果取得・選択保持の 3 件が失敗する。
旧 HEAD の ConversationPage.tsx を Vite の load で差し替えると、新しい画面試験 5 件が失敗する。作業ファイルは戻していない。

## 試験結果

- api 全体: 790 件中 769 成功、21 skip、失敗なし。socket を開けない環境の試験は既存の条件で skip。
- 最終の送信処理変更後の api 関連試験: 62 件中 60 成功、2 skip。その後追加したカタログ試験も全 3 件成功。
- dashboard 全体: 68 ファイル・832 件成功。最後のキー操作調整後も slash-commands の 5 件成功。
- api / dashboard の TypeScript 型検査、dashboard の production build、`git diff --check` が成功。
- 負荷による timeout は発生していない。試験の上限は緩めていない。

pnpm は指定どおり `npx --yes pnpm@10` を使用したが、後半は registry の DNS 解決が失敗した。
試験はインストール済みの同じ Node / TypeScript / Vitest / Vite を直接実行した。
再現ログと実機スクリプトは作業ツリー内の `.agents/slash-smoke/` に置いた（git 管理外）。
