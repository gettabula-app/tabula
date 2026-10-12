section: Added
audience: dev

- Link previews, server side: `POST /api/boards/:id/unfurl` fetches a page once through the address guard and answers its title, description and site name, with a cache, rate limits, a workspace setting (`/api/admin/link-previews`) and the `TABULA_LINK_PREVIEWS` operator switch. There is no card in the app yet.
- The link preview user agent names the instance instead of tabula.app.
