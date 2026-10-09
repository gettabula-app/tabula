section: Security

- The SVG policy for icons, stickers and templates reads only tab, line feed, carriage return and space as whitespace
  inside a tag, as browsers do. A no-break space or another Unicode space before an attribute value hid the rest of the
  tag from the scan (`title=<no-break space>"x onclick=alert(1) y"` passed as one quoted title, while a browser reads an
  onclick handler). Such a body is now refused as a whole. The app's Content Security Policy already blocked the handler
  in the browser and the desktop app; exported SVG files carry no such policy.
