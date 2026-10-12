// Link-preview tags for the app shell. A crawler runs no JavaScript and never sees a #fragment, so what it reads
// is whatever the server sends for the path. The text is the same for everyone: no board, team or inviter name.

export const OG_IMAGE_PATH = '/og/invite.png';
export const OG_IMAGE_SIZE = { width: 1200, height: 630 };

const JOIN_DESCRIPTION = {
  accounts: 'Open the link to join. You sign in with your email, no password.',
  open: 'Open the link to join. No account needed.',
};
const TEXT = {
  board: { title: 'Join a board on Tabula' },
  team: { title: 'Join a team on Tabula' },
  root: {
    title: 'Tabula',
    description: 'An infinite whiteboard for teams: sticky notes, diagrams and workshop templates. Open source.',
  },
};

const attr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 'board' for a join-code link (/join), 'team' for a team invite (?invite=1), 'root' for everything else, including /b/ board links, which members also use for tracker deep links. */
export function ogKind(pathname, searchParams) {
  if (pathname === '/join') return 'board';
  if (pathname === '/' && searchParams.get('invite') === '1') return 'team';
  return 'root';
}

/** `origin` is the configured public origin, or null when none is set: then no absolute URL is written. */
export function ogTags(kind, origin, accounts = false) {
  const base = TEXT[kind] ?? TEXT.root;
  const text = { title: base.title, description: base.description ?? JOIN_DESCRIPTION[accounts ? 'accounts' : 'open'] };
  const tags = [
    ['property', 'og:site_name', 'Tabula'],
    ['property', 'og:type', 'website'],
    ['property', 'og:title', text.title],
    ['property', 'og:description', text.description],
    ['name', 'twitter:title', text.title],
    ['name', 'twitter:description', text.description],
  ];
  if (origin) {
    const image = `${origin}${OG_IMAGE_PATH}`;
    tags.push(
      ['property', 'og:image', image],
      ['property', 'og:image:type', 'image/png'],
      ['property', 'og:image:width', String(OG_IMAGE_SIZE.width)],
      ['property', 'og:image:height', String(OG_IMAGE_SIZE.height)],
      ['property', 'og:image:alt', 'Tabula'],
      ['name', 'twitter:card', 'summary_large_image'],
      ['name', 'twitter:image', image],
    );
  } else {
    tags.push(['name', 'twitter:card', 'summary']);
  }
  return { title: text.title, description: text.description, block: tags.map(([k, n, v]) => `    <meta ${k}="${n}" content="${attr(v)}" />`).join('\n') };
}

/** Rewrites the title and description of the shell and adds the tags before </head>. */
export function withOgTags(html, kind, origin, accounts = false) {
  const { title, description, block } = ogTags(kind, origin, accounts);
  // The root page keeps its own title and description; only an invite page is retitled.
  const rewritten = kind === 'root' ? html : html
    .replace(/<title>[^<]*<\/title>/, `<title>${attr(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${attr(description)}" />`)
    ;
  return rewritten.replace('</head>', `${block}\n  </head>`);
}
