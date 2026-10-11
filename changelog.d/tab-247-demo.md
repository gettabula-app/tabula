section: Added
audience: dev

- TAB-247 adds an ephemeral, static landing-page demo build at `/demo/`, with an in-memory board, network and storage guards, a disclosure banner and `script-src 'self'`. The demo limits Fontshare requests to its built-in font allowlist, skips catalogue loading, explains export and reload behavior, and opens on a readable intro view on desktop and phones.
- The landing-page demo now opens as a plain board: no dot vote or poll is running, and "Try dot voting" in the menu starts one. On a phone it opens on the title, one hint and a group of four notes at about 100% zoom, with a one-line banner, only the menu in the top bar, six tools and a minus/percent/plus zoom control. The other frames sit below the first screen.
