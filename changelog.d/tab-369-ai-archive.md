section: Changed

- AI tools can archive and restore tickets, and restore (but not archive) projects and milestones; they still cannot delete anything from the tracker. Linking tickets now has the same hourly limit as editing them.
- AI tools get one `ticket_meta` call for the workflow states, labels and the people a ticket can be assigned to, and the `delete_saved_view` tool is gone from the AI tool set.
