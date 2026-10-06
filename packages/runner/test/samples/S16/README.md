# S16

ターミナルの Claude の native ID を planner が環境から受け取る構造標本。
会話を受理の前に観測する場合と、受理の後に観測する場合を input.json に持つ。
期待する台帳の関係と投影は expected.json に持ち、intake.test.ts で両方を検証する。
入力の再送、観測の再送、順序の逆転、台帳からの再構築も検証する。
