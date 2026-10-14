section: Added

- Each agent token can make up to 120 ticket updates, state changes and comments an hour by default, with a separate count for each kind, and create up to 60 new tickets an hour. A call over the limit is refused with a retry time and changes nothing.
- The server records the name of the agent token behind each ticket change. The name is not shown in the app or the API.
