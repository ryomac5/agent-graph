# S19

再実行報告の実測した通知の形を使った、識別子と本文を固定した標本。
子の thread/started と parentThreadId は届かない。
子の本文が確定した後に、親の spawnAgent item が届く順序を再現する。
PARENT と PARENT_TURN は偽サーバーが実行中の識別子で置き換える。
期待値: 子の会話・本文・実行を先に残し、後で delegated/confirmed を一件追記する。
wait と closeAgent から関係は追加しない。
