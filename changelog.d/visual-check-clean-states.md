section: Fixed

- `npm run visual` starts each state on an idle seeded board: a session, vote, poll or dots left running by an earlier state are ended and cleared first (developer tooling). Before, `vote-setup` at 360 failed when it ran after `vote-running` (its button ended the running vote instead of opening the panel), and the chat shots showed a vote bar the state never started, hiding the chat composer. Shots of states that ran after a vote no longer carry the bar, so compare new shots with old ones with that in mind.
