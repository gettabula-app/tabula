section: Added
audience: dev

- Connected apps can carry a ticket access ceiling (read or write), chosen at consent and stored on the grant as `tracker`; grants from before stay at none, and the grant lists return the value.
- Over OAuth, ticket tools follow that ceiling instead of the board scope, and a new consent for the same app replaces the earlier grant (TAB-365). The consent screen does not offer the choice yet.
