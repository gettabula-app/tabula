section: Changed
audience: user

- AI tools (MCP) can no longer move or re-parent kanban cards, lanes and containers or delete lanes and kanbans through the generic object tools; use the kanban card tools.
- Deleting a group now fails with a conflict if any member in its cascade is locked; unlock the member before deleting the group.
- Generic object updates now return `not_found` for hidden and private cards, cards in hidden lanes, and hidden lanes or kanbans.
