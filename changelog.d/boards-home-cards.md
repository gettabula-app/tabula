section: Changed
audience: dev

- TAB-375 slice 2, Boards home (accounts mode): the boards are cards in sections per team, Personal, Shared with you and this device, with Cards | List and Show previews in the toolbar. The card line shows the last editor the server names (agent marked), the people here and the unread count; the template cards replace the template strip on the first run. Real pictures come only from a dev manifest (src/ui/dev-board-images.ts, DEV builds), and Move to… and drag between sections are a dev stub (moveBoardStub in src/ui/home.ts, not saved on the server yet); production has neither. Delete is owner-only in the card menu.
