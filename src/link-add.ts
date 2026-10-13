// Adding link cards to the open board (docs/link-cards.md, proto/designer-preview/link-cards/SPEC.md): from a paste, a drop, the rail's
// Link button, and Turn into link card. The card goes on the board at once and the preview fills in when the relay answers, written as
// a change that is not an undo step, so Undo takes the whole card back and never leaves an empty one.
import type { BoardApp } from './app';
import type { BaseObj, Point } from './types';
import { ApiError, api } from './api';
import { linkPreviewsAvailable } from './auth';
import { LINK_SIZES, type LinkLayout, failureOf, loneUrl, maskSecrets, normaliseUrl, openLink, parsePreview, secretLooking, urlsFromList } from './link-cards';
import { dialog, toast } from './ui/common';
import { h } from './ui/dom';

/** The write origin of a preview: not an undo step (the same as a picture's hash arriving, src/board-images.ts). */
const PREVIEW_ORIGIN = 'assets';
const MAX_PER_DROP = 10;
/** Cards of one drop are laid out down the page with this gap. */
const GAP = 16;

export class LinkCards {
  /** A Cmd/Ctrl+Shift+V just happened: the paste that follows is plain text. */
  private plainUntil = 0;

  constructor(private app: BoardApp) {}

  previewsOn(): boolean {
    return linkPreviewsAvailable();
  }

  /** Called on every keydown: remembers a "paste as plain text" so its paste event skips the card. */
  noteKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v') this.plainUntil = Date.now() + 800;
  }

  /** A paste of one web address makes a card, unless it was pasted as plain text. Returns true when it handled the paste. */
  pasteUrl(text: string): boolean {
    if (this.app.readOnly) return false;
    if (Date.now() < this.plainUntil) return false;
    const url = loneUrl(text);
    if (!url) return false;
    void this.addUrls([url], { at: this.pasteAt(), source: 'paste' });
    return true;
  }

  /** Addresses from a dragged link (`text/uri-list`): a card per address, at most ten. Returns true when it handled the drop. */
  dropUrls(list: string, at: Point): boolean {
    if (this.app.readOnly) return false;
    const urls = urlsFromList(list, MAX_PER_DROP);
    if (!urls.length) return false;
    void this.addUrls(urls, { at, source: 'drop' });
    return true;
  }

  private pasteAt(): Point {
    const vp = this.app.r.viewport();
    const p = this.app.pointerWorld();
    const inView = p.x >= vp.x && p.x <= vp.x + vp.w && p.y >= vp.y && p.y <= vp.y + vp.h;
    return inView ? p : { x: vp.x + vp.w / 2, y: vp.y + vp.h / 2 };
  }

  /** The cards for `urls`, centred on `at` (a column when there are several). Resolves to the ids made. */
  async addUrls(urls: string[], opts: { at?: Point; source: 'paste' | 'drop' | 'button' | 'convert'; replace?: string }): Promise<string[]> {
    if (this.app.readOnly) return [];
    const list: string[] = [];
    for (const raw of urls) {
      const n = normaliseUrl(raw);
      if (!n.ok) continue;
      // an address that looks like it carries a secret is confirmed first: everyone on the board will see it
      if (secretLooking(n.url) && !(await this.confirmSecret(n.url))) continue;
      list.push(n.url);
    }
    if (!list.length) return [];
    const on = this.previewsOn();
    const size = on ? LINK_SIZES.card : LINK_SIZES.compact;
    const at = opts.at ?? this.pasteAt();
    const total = list.length * size.h + (list.length - 1) * GAP;
    const made: BaseObj[] = list.map((url, i) => this.app.makeObj('link', {
      x: Math.round(at.x - size.w / 2),
      y: Math.round(at.y - total / 2 + i * (size.h + GAP)),
      w: size.w, h: size.h,
    }, { url, unfurl: on ? 'pending' : 'off' }));
    this.app.store.undo.stopCapturing();
    this.app.store.transact(() => {
      if (opts.replace) this.app.store.remove([opts.replace]);
      for (const o of made) this.app.store.create(o);
    });
    this.app.setSelection(made.map((o) => o.id));
    if (on) for (const o of made) void this.fetchPreview(o.id);
    this.announceAdded(made, opts.source);
    return made.map((o) => o.id);
  }

  /** The relay reads the page and answers; the card is filled in, or marked failed, without becoming an undo step. */
  async fetchPreview(id: string, refresh = false): Promise<void> {
    const o = this.app.store.get(id) as BaseObj | undefined;
    if (!o || o.type !== 'link' || typeof o.url !== 'string') return;
    let patch: Partial<BaseObj>;
    try {
      const p = parsePreview(await api.unfurl(this.app.conn.id, o.url, refresh));
      const edited = new Set(o.edited ?? []);
      patch = {
        unfurl: 'ok', unfurlError: undefined, finalUrl: p.finalUrl || undefined, fetchedAt: p.fetchedAt,
        siteName: p.siteName || undefined, image: p.image ?? undefined, imageW: p.imageW ?? undefined, imageH: p.imageH ?? undefined, icon: p.icon ?? undefined,
        ...(edited.has('title') ? {} : { title: p.title || undefined }),
        ...(edited.has('description') ? {} : { description: p.description || undefined }),
      };
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      const code = err instanceof ApiError ? err.code : '';
      // a network failure is not the site's: the card says the preview could not be taken, and Refresh tries again
      patch = failureOf(status, code);
    }
    this.apply(id, patch);
  }

  private apply(id: string, patch: Partial<BaseObj>): void {
    const o = this.app.store.get(id);
    if (!o || o.type !== 'link') return;
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) clean[k] = v;
    this.app.store.transactAs(() => this.app.store.update(id, clean as Partial<BaseObj>), PREVIEW_ORIGIN);
  }

  /** Resizes the card to the default of a layout, keeping its top-left corner (one undo step). */
  setLayout(id: string, layout: LinkLayout): void {
    const o = this.app.store.get(id) as BaseObj | undefined;
    if (!o || o.type !== 'link' || this.app.readOnly) return;
    const size = LINK_SIZES[layout];
    this.app.store.undo.stopCapturing();
    this.app.store.transact(() => this.app.store.update(id, { w: size.w, h: size.h }));
  }

  /** Reads the page again: the card shows "Loading preview…" until the relay answers; edited fields are kept. */
  refresh(id: string): void {
    const o = this.app.store.get(id) as BaseObj | undefined;
    if (!o || o.type !== 'link' || this.app.readOnly || !this.previewsOn() || o.unfurl === 'pending') return;
    this.apply(id, { unfurl: 'pending', unfurlError: undefined });
    void this.fetchPreview(id, true);
  }

  /** A text or sticky whose content is one address becomes a link card in its place (one undo step). */
  fromText(id: string): boolean {
    const o = this.app.store.get(id) as BaseObj | undefined;
    if (!o || (o.type !== 'text' && o.type !== 'sticky') || this.app.readOnly) return false;
    const url = loneUrl(o.text ?? '');
    if (!url) return false;
    void this.addUrls([url], { at: { x: o.x + o.w / 2, y: o.y + o.h / 2 }, source: 'convert', replace: id });
    return true;
  }

  /** Opens the card's address in a new tab, without opener or referrer. */
  open(id: string): boolean {
    const o = this.app.store.get(id) as BaseObj | undefined;
    return o?.type === 'link' ? openLink(o.url) : false;
  }

  private announceAdded(made: BaseObj[], source: string): void {
    if (made.length > 1) {
      toast(`${made.length} links added`, 6000);
      return;
    }
    const id = made[0].id;
    // a paste can be undone into plain text in one step; a button or a drop was asked for on purpose
    if (source === 'paste') toast('Link added', 6000, { label: 'Turn into text', onClick: () => this.toText(id) });
  }

  /** Replaces the card with a text box of its address: one undo step, and Undo brings the card back whole. */
  toText(id: string): boolean {
    const o = this.app.store.get(id) as BaseObj | undefined;
    if (!o || o.type !== 'link' || this.app.readOnly || typeof o.url !== 'string') return false;
    const box = this.app.textBoxAt(o.url, { x: o.x, y: o.y });
    this.app.store.undo.stopCapturing();
    this.app.store.transact(() => {
      this.app.store.remove([id]);
      this.app.store.create(box);
    });
    this.app.setSelection([box.id]);
    return true;
  }

  /** The warning before an address that looks like it carries a secret goes on a shared board. Resolves to whether to add it. */
  confirmSecret(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      let answered = false;
      const answer = (yes: boolean) => { if (!answered) { answered = true; resolve(yes); } };
      const code = h('code', { class: 'link-secret-url' });
      code.textContent = maskSecrets(url);
      const body = h('div', { class: 'link-secret' }, h('p', null, 'This link may contain a secret that everyone on the board will see.'), code);
      const d = dialog('Add this link?', body, [
        { label: 'Cancel', onClick: () => answer(false) },
        { label: 'Add anyway', primary: true, onClick: () => answer(true) },
      ], { className: 'link-secret-dialog', onClose: () => answer(false) });
      // a warning dialog: a screen reader announces it as one, and it starts on Cancel (the dialog puts focus on its main button a frame later)
      d.box.setAttribute('role', 'alertdialog');
      requestAnimationFrame(() => requestAnimationFrame(() => d.box.querySelector<HTMLButtonElement>('.modal-actions .btn')?.focus()));
    });
  }
}
