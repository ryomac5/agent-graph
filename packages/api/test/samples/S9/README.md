# S9（Codex 0.160.1）

architecture-review のメタのみの paginated と、従来の legacy（history_mode 省略）を写した架空標本。
作成時刻には session_meta.payload.timestamp を使用する。
メタのみの paginated は所属付きの本文取得不能レコードにし、空の本文に置き換えない。
future は未対応形式の検出専用の架空標本。
本文・識別子はすべて架空。

本文の到着後、取得不能の印は `body_state: omitted` に更新する。
この本文のないレコードと所属は、取得不能だったことを追える監査用の印として残る。
新たに届いた本文は別の native ID の発言として保存される。
