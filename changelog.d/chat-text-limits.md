section: Fixed

- Chat trims trailing whitespace in linear time. A message of a few thousand spaces followed by a letter kept the server
  busy for a second or more before it was refused, and the refusal came before the rate limit counted it.
- A chat message is held to 2,000 characters as it is stored: mentions of people who cannot read the channel become
  `@someone`, which is longer than a short `@{id}` token, and could take a message past the limit.
