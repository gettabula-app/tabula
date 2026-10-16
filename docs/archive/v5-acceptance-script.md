# v5 kanban MCP acceptance script

Run this against a scratch board in the hosted Tabula workspace:

```sh
TABULA_TOKEN_WRITE='<board-limited write token>' \
TABULA_TOKEN_READ='<board-limited read token>' \
npm run qa:v5 -- --url https://tabulahq.thetabula.cloud --board <boardId>
```

Both tokens must come from the app's AI tool access dialog. The script reads them only from the environment, never prints them, and requires `--board`. The board should contain a kanban with lanes in the `todo`, `doing`, and `done` stages. Pass `--kanban <containerId>` to select a kanban when the board has more than one. Add `--json` for a JSON report, `--pause-for-watch` to print the live-watch message and wait five seconds before the first card appears, or `--keep` to leave the script-created cards on the board.

The check creates cards titled with the unique prefix `v5-accept <runId>`, exercises add, update, and move operations, and deletes only the explicit card IDs returned by its own successful creates. By default it deletes those cards and confirms they are gone. It does not change or delete any existing card.
