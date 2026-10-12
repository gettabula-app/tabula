section: Added
audience: dev

- Boards page, client side of "Here now": a cell on each board row with who else has the board open (squares in their colours, You, +N, the names on a phone, the full list on hover or keyboard focus), fed over the chat socket or by polling `GET /api/boards/presence`. It shows nothing until the server sends presence.
