# Link previews

This page is for people who run a website or a Tabula server and want to know what a link preview request is.

## What the request is

When someone adds a link card to a Tabula board (or presses **Refresh preview** on one), the Tabula server that holds the board asks the linked page for its title, description and picture, so the card can show them. See [Link cards](link-cards.md) for what people see.

- The request comes from the **Tabula server**. It never comes from the browser of the person who added the link, or of anyone who looks at the board.
- It is made **once** when a link is added or refreshed, and the answer is stored with the board. Looking at a board makes no request to your site.
- It is a plain `GET`, with no cookies, no sign-in details and no `Referer`. Other requests may follow for the page's preview picture and its icon.
- It follows at most three redirects, gives up after five seconds, and reads at most the first 1 MB of the page (it stops once it has read the page's `<head>`).
- It sends this `User-Agent`, with the address of the Tabula server that made the request:

```
TabulaLinkPreview/1.0 (+https://<the Tabula server>/docs/link-previews)
```

On a hosted workspace the address is the workspace's own, for example `https://your-team.thetabula.cloud`.

## Keep Tabula out

A page that answers with an error, or does not answer, simply gets no preview: the card shows its address and still works as a link. To stop Tabula reading your pages, refuse requests whose `User-Agent` contains `TabulaLinkPreview` (for example with a rule in your web server or firewall). Tabula does not read `robots.txt` for these requests.

## For people who run a Tabula server

Link previews make your server request web pages on people's behalf, so they are off by default on a server you run yourself.

- **Turn them on or off** in **Admin > Privacy**, with the **Link previews** switch.
- **`TABULA_LINK_PREVIEWS`** is the operator's setting. `off` turns previews off for good and nobody can switch them on from Admin. `on` turns them on where they are otherwise off, including on a server without accounts (where there is no Admin page). Leave it unset to let admins decide.
- **Keep it away from your own network.** Tabula's server refuses addresses that are not on the public internet (private and local ranges, link-local, cloud metadata, multicast and similar), checks every redirect the same way, and connects only to the address it checked. If your server runs next to internal services on addresses that look public, list them in **`TABULA_LINK_PREVIEW_DENY`**: a comma-separated list of networks (for example `203.0.113.0/24`) and host names.
- **Limits.** A person can ask for about 30 previews a minute and 300 an hour, a workspace for 2,000 an hour, and a server runs at most four at a time. A page is read at most once a day for everyone on the server, unless someone presses **Refresh preview**.
- **Guests** on a board cannot create previews.

On a hosted workspace, previews are on by default, and an admin can turn them off in **Admin > Privacy**.

## Related

- [Link cards](link-cards.md)
- [Admin dashboard](admin.md)
