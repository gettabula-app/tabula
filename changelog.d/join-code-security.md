section: Fixed

- Turning off join codes blocks existing guest sessions.
- Restores and volume adoption end guest sessions and revoke join codes.
- Guest presence and comments now show a guest label, and guests cannot change the identity shown to others.
- Join codes use a private instance key so a database copy alone cannot check code guesses.
- Existing join codes must be replaced after upgrading; guest sessions already issued still end at expiry or revocation.
