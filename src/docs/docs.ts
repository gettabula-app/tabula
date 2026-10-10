import './docs.css';
import { applyTheme, getStoredTheme } from '../themes';

// The theme is stored by the app in the same origin; the guide only reads it.
applyTheme(getStoredTheme());

interface Entry {
  url: string;
  title: string;
  headings: { text: string; id: string }[];
  text: string;
}
interface Hit {
  href: string;
  title: string;
  heading: string;
}

const input = document.querySelector<HTMLInputElement>('#docs-search');
const list = document.querySelector<HTMLUListElement>('#docs-results');
const menu = document.querySelector<HTMLButtonElement>('.docs-menu');
const nav = document.querySelector<HTMLElement>('#docs-nav');

let index: Promise<Entry[]> | null = null;
let hits: Hit[] = [];
let active = -1;

const load = () => (index ??= fetch(input?.dataset.search || '/docs/search.json').then((r) => (r.ok ? (r.json() as Promise<Entry[]>) : [])).catch(() => []));

function search(entries: Entry[], query: string): Hit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: Hit[] = [];
  for (const e of entries) {
    const heading = e.headings.find((h) => h.text.toLowerCase().includes(q));
    if (e.title.toLowerCase().includes(q)) out.push({ href: e.url, title: e.title, heading: '' });
    else if (heading) out.push({ href: `${e.url}#${heading.id}`, title: e.title, heading: heading.text });
    else if (e.text.toLowerCase().includes(q)) out.push({ href: e.url, title: e.title, heading: '' });
    if (out.length >= 10) break;
  }
  return out;
}

function select(i: number) {
  if (!list) return;
  active = i;
  [...list.children].forEach((li, n) => {
    li.setAttribute('aria-selected', String(n === i));
    if (n === i) li.scrollIntoView({ block: 'nearest' });
  });
}

function render() {
  if (!list || !input) return;
  list.replaceChildren(
    ...hits.map((hit) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      const a = document.createElement('a');
      a.href = hit.href;
      const t = document.createElement('span');
      t.className = 'docs-hit-title';
      t.textContent = hit.title;
      a.append(t);
      if (hit.heading) {
        const s = document.createElement('span');
        s.className = 'docs-hit-heading';
        s.textContent = hit.heading;
        a.append(s);
      }
      li.append(a);
      return li;
    }),
  );
  if (!hits.length && input.value.trim()) {
    const li = document.createElement('li');
    li.className = 'docs-none';
    li.textContent = 'No results';
    list.append(li);
  }
  list.hidden = !list.children.length;
  active = -1;
}

async function update() {
  if (!input) return;
  const entries = await load();
  hits = search(entries, input.value);
  render();
}

function clear() {
  if (!input) return;
  input.value = '';
  hits = [];
  render();
}

if (input && list) {
  input.addEventListener('focus', () => void load());
  input.addEventListener('input', () => void update());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clear();
    } else if (e.key === 'ArrowDown' && hits.length) {
      e.preventDefault();
      select((active + 1) % hits.length);
    } else if (e.key === 'ArrowUp' && hits.length) {
      e.preventDefault();
      select((active - 1 + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      const hit = hits[active >= 0 ? active : 0];
      if (hit) location.href = hit.href;
    }
  });
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      input.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.docs-search')) list.hidden = true;
  });
  input.addEventListener('focus', () => {
    if (list.children.length) list.hidden = false;
  });
}

if (menu && nav) {
  menu.addEventListener('click', () => {
    const open = !nav.classList.contains('open');
    nav.classList.toggle('open', open);
    menu.setAttribute('aria-expanded', String(open));
  });
}
