# Link cards

A link card puts a web address on the board as a small card with the page's title, a short description and a picture. Select it to move it, open it to read the page. It is an object like any other: you can resize it, put it in a frame, connect it and comment on it.

Link cards appear where your workspace has link previews turned on. Without previews you still get a card, but it shows only the address (see [When there is no preview](#when-there-is-no-preview)).

## Add a link

There are three ways.

- **Paste.** Copy a web address, then press `Ctrl+V` (`Cmd+V` on Mac) with the board in front. The card lands where your pointer is, or in the middle of your view. A short message says "Link added" and offers **Turn into text**.
- **Link.** Open the **Text**, **Markdown block** and **Link** group in the left toolbar, then choose **Link**. Type or paste the address and press `Enter` or **Add**.
- **Drop.** Drag a link from another browser tab onto the board. You get one card for each address, up to 10 at a time.

The card appears at once with the address and the site name. A thin line along its bottom edge runs while Tabula reads the page, usually for a second or two. Then the title, description and picture fill in. `Ctrl+Z` takes the whole card away again, not an empty card.

Only a single `http` or `https` address becomes a card. An address inside other text stays text, and so does anything with a user name or password in it (`https://name:password@…` cannot be added). To paste an address as plain text, press `Ctrl+Shift+V` (`Cmd+Shift+V` on Mac).

> Everyone who can open the board can see a link card and the address in it. If an address looks like it carries a secret, such as `?token=…`, Tabula asks first ("Add this link?") and shows the address with the secret cut out. Choose **Cancel** to leave it off the board.

Only people who can edit the board can add link cards.

## Open a link

A single click selects the card, so dragging a card never opens a tab. To open the page in a new tab:

- press `Enter` (or `Ctrl+Enter` / `Cmd+Enter`) on a selected card;
- double-click the card;
- hold `Ctrl` (`Cmd` on Mac) and click it; or
- choose **Open** in the quick-action bar.

Everyone who can see the board can open a card, including people who can only view it. Hover a card to see its address as a tooltip. If the address redirected somewhere else, the tooltip says where.

## The three sizes

The card's size picks its layout. Choose **Compact**, **Card** or **Large** in the quick-action bar to resize it to the standard size of each, or drag a corner.

| Layout | Shows |
|---|---|
| **Compact** | One line: the site's icon, the title (or the address) and the domain. |
| **Card** | The site name and icon, the title on up to two lines, a line of description, the domain, and the page's picture on the right. |
| **Large** | The picture across the top, then the site name, title, description and domain. |

Long titles and addresses are cut with "…" and never run outside the card.

## Change a card

Select a card to see its quick-action bar. People who can only view or comment see **Open** alone.

- **Refresh preview** reads the page again, for example when it has a new title. A title or description you edited yourself is kept.
- **Edit** turns the title and description into two text boxes on the card. Type, then click outside the card to save, or press `Esc` to cancel.
- **Turn into text** replaces the card with a text box that holds the address. `Ctrl+Z` brings the card back.
- A text or sticky note that holds only an address has **Turn into link card** in its bar.

On a phone, **Open** stays in the bar and the rest are in the **⋯** menu.

## When there is no preview

- **Loading preview…** The page is being read. It takes a few seconds at most.
- **No preview.** The page could not be read: the site did not answer in time, it is not an ordinary web page, it is too large, or it needs a sign-in. Point at the card to see the reason. The card is still a working link, and **Refresh preview** tries again.
- **Address only.** Your workspace has link previews turned off, or you are a guest on the board. The card shows the address and the domain, and **Open** works.

A page that is behind a sign-in (a shared document, a company tool) cannot be read by Tabula, because Tabula does not sign in anywhere. Such a card shows **No preview** and its address.

## Privacy

When you add or refresh a link card, **Tabula's server** reads the linked page once to get its title, description and picture. Nobody's browser contacts the site to draw the card. The linked site sees a request from Tabula's server, not from you, and not from anyone who looks at the board. The picture and the site's icon are saved with the board, like any image, and are shown from there. The page never sees who is looking at the board.

Whoever runs your workspace decides whether previews are on (see [Admin dashboard](admin.md)). A site owner who does not want Tabula to read their pages can turn it away: see [Link previews](link-previews.md).

## Export and other tools

- **PNG and SVG** exports draw the card with its picture. In an SVG, the card is a link that still opens the address when you open the file in a browser.
- The **Markdown summary** lists a card as `- [Title](address)`, or the address alone when there is no title.
- A **template** keeps a card's address, title and description, but not its picture or icon. It shows a letter in a colour until someone refreshes it.
- A card you copy to another board keeps its address and text. The picture belongs to the board that read the page, so on the new board it shows the site's first letter until you press **Refresh preview**.
- **AI tools** that read the board see a card as its address, title and description. They are text from the linked page, and are treated like any other text on the board.

## Related

- [Images](images.md)
- [Export and import](export-import.md)
- [Link previews: for site owners and admins](link-previews.md)
