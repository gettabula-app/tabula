import './kanban.css';
import type { BoardApp } from '../app';
import type { Id } from '../types';
import { addCard, addRefusal } from '../containers';
import { fontFamily } from '../fonts';
import { addRow, laneCards } from './kanban-logic';

// The DOM side of the kanban on the canvas (docs/kanban.md, slice 2): the inline "+ Add card" input. Moves are announced
// through the board's announcer (BoardApp.announce, src/ui/announce.ts). The board itself is SVG (src/markup.ts).

/**
 * Typing a card's title in place at the bottom of a lane: Enter adds the card and starts the next one, Esc stops
 * (docs/kanban.md, Cards). Title only in this slice; the card dialog is slice 3.
 */
export class CardInput {
  private wrap: HTMLDivElement;
  private input: HTMLInputElement;
  private lane: Id | null = null;
  private stopCam: (() => void) | null = null;
  private stopStore: (() => void) | null = null;

  constructor(private app: BoardApp) {
    this.wrap = document.createElement('div');
    this.wrap.className = 'k-input-wrap';
    this.input = document.createElement('input');
    this.input.className = 'k-input';
    this.input.type = 'text';
    this.input.maxLength = 200;
    this.input.setAttribute('aria-label', 'New card title');
    const hint = document.createElement('span');
    hint.className = 'k-input-hint';
    hint.textContent = 'Enter adds · Esc stops';
    hint.setAttribute('aria-hidden', 'true');
    this.wrap.append(this.input, hint);
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.add();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.stop();
      }
    });
    // leaving the input keeps what was typed, as leaving a field does everywhere else in the app
    this.input.addEventListener('blur', () => {
      if (!this.lane) return;
      this.add();
      this.stop();
    });
    app.r.root.appendChild(this.wrap);
  }

  get active(): Id | null {
    return this.lane;
  }

  /** Opens the input at the end of a lane. */
  start(laneId: Id) {
    const { app } = this;
    if (app.readOnly || app.store.get(laneId)?.type !== 'lane') return;
    if (this.lane) this.stop();
    const refused = addRefusal(app.store, laneId);
    if (refused) {
      app.notify(refused);
      return;
    }
    this.lane = laneId;
    app.r.setKanbanState({ addingLane: laneId });
    this.input.value = '';
    this.input.style.fontFamily = fontFamily(app.store.getMeta().bodyFont);
    this.wrap.style.setProperty('--k-font', fontFamily(app.store.getMeta().bodyFont));
    this.wrap.classList.add('show');
    this.stopCam = app.r.onCamera(() => this.place());
    this.stopStore = app.store.onChange(() => {
      if (!this.lane) return;
      if (app.store.get(this.lane)?.type !== 'lane' || app.readOnly) this.stop();
      else requestAnimationFrame(() => this.place());
    });
    this.place();
    this.input.focus({ preventScroll: true });
  }

  /** Closes the input without adding anything more. */
  stop() {
    if (!this.lane) return;
    this.lane = null;
    this.stopCam?.();
    this.stopStore?.();
    this.stopCam = this.stopStore = null;
    this.wrap.classList.remove('show');
    this.app.r.setKanbanState({ addingLane: null });
    if (document.activeElement === this.input) this.input.blur();
  }

  private add() {
    const lane = this.lane;
    const title = this.input.value.trim();
    if (!lane || !title) return;
    const { app } = this;
    const id = addCard(app.store, lane, title, { createdBy: app.user.id, font: app.store.getMeta().bodyFont });
    if (!id) {
      const refused = addRefusal(app.store, lane);
      if (refused) app.notify(refused);
      return;
    }
    this.input.value = '';
    app.announce(`Added to ${(app.store.get(lane) as { name?: string }).name || 'lane'}: ${title}`);
  }

  /** Lays the input over the lane's add-card row, scaled with the camera. */
  private place() {
    const { app } = this;
    const lane = this.lane ? app.store.getPlaced(this.lane) : undefined;
    const layout = lane?.parent ? app.store.containerLayout(lane.parent) : null;
    if (!lane || !layout || lane.type !== 'lane') return;
    const row = addRow(lane, laneCards(layout, lane.id));
    const s = app.r.toScreen({ x: row.x, y: row.y });
    this.wrap.style.width = `${row.w}px`;
    this.wrap.style.transform = `translate(${s.x}px, ${s.y}px) scale(${app.zoom})`;
  }
}
