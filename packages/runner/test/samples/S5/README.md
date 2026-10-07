# S5

agc の codex_start/codex_done、MCP delegate、Codex native spawnAgent の
既存の記録形式から、本文を伏せて同じ親子を作る。
expected.json の parent/child は各入口の会話 ID を正規化した端点である。

intake-integration.test.ts で再送・再取り込み、逆順投影、台帳の再構築を試す。
agc は記録済みの実行を取り込み、native はホストが既に起動した子を観測する。
どちらも再取り込みで新しいホストを起動しない。
