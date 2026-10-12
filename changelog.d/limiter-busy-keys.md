section: Fixed

- The in-memory rate limits (sign-in links, MCP, chat and AI) now count a request as use of its key, so when a limiter
  holds its maximum of keys it forgets the key that has been idle longest. Before, it forgot the key it had seen first,
  which could be one still at its limit, and that person or address got a fresh count. Chat keeps each active count
  recent even when a different window refuses the request, without counting the refused request.
