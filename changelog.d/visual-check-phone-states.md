section: Fixed
audience: dev

- `npm run visual` runs the four kanban list-sheet states (`kanban-sheet-filter`, `kanban-sheet-adding`, `kanban-moveto`, `kanban-moveto-full`) only at widths under 600 px. They drive the phone sheet, which a wide screen shows as a side panel instead, so at 1024 or 1280 they used to time out and be reported as failures.
