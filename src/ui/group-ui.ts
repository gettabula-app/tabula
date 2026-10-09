import './group-ui.css';
import type { BoardApp } from '../app';
import { isConnector } from '../types';
import type { Group, Obj } from '../types';
import { h } from './dom';
import type { PinView } from '../pins';
import { pinMarkup } from '../render';
import { clampGroupChipPosition, doneChipText, groupChipText, groupPathLabel, placeEnteredGroupChips, placeEnteredGroupPins, showSelectedGroupChip, type EnteredChipPinBox } from './group-ui-logic';

/** The local group scope controls; outlines and dimming are renderer overlays. */
export function mountGroupUI(app: BoardApp, parent: HTMLElement) {
  const selectedChip = h('div', { class: 'group-chip', hidden: true, 'aria-hidden': 'true' });
  const pathChip = h('div', { class: 'group-chip group-path-chip', hidden: true });
  const done = h('button', { class: 'group-done', type: 'button', hidden: true, onclick: () => app.leaveGroup() });
  const pinOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  pinOverlay.setAttribute('class', 'group-pin-overlay');
  pinOverlay.setAttribute('aria-hidden', 'true');
  pinOverlay.setAttribute('preserveAspectRatio', 'none');
  parent.append(selectedChip, pathChip, done, pinOverlay);

  let adjustedPins: PinView[] | null = null;
  let adjustedPinOffsets = new Map<string, number>();
  let updatingPins = false;

  const sourcePins = (): PinView[] => {
    const current = app.r.pins;
    if (current !== adjustedPins) return current;
    return current.map((pin) => {
      const offset = adjustedPinOffsets.get(pin.id) ?? 0;
      return offset ? { ...pin, y: pin.y - offset } : pin;
    });
  };

  const applyPinLayout = (chips: readonly EnteredChipPinBox[] | null) => {
    const currentPins = app.r.pins;
    const basePins = sourcePins();
    if (!chips) {
      app.r.setPromotedPinIds([]);
      pinOverlay.innerHTML = '';
      if (currentPins === adjustedPins) {
        updatingPins = true;
        app.r.setPins(basePins);
        updatingPins = false;
      }
      adjustedPins = null;
      adjustedPinOffsets.clear();
      return;
    }

    const rootRect = app.r.root.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const offset = { x: parentRect.left - rootRect.left, y: parentRect.top - rootRect.top };
    const screenPins = basePins.map((pin) => {
      const screen = app.r.toScreen(pin);
      return { ...pin, x: screen.x - offset.x, y: screen.y - offset.y };
    });
    const placements = placeEnteredGroupPins(screenPins, chips);
    const placed = new Map(placements.map((position) => [position.id, position]));
    const nextPins = basePins.map((pin) => {
      const position = placed.get(pin.id);
      if (!position?.moved) return pin;
      const world = app.r.toWorld(position.x + offset.x, position.y + offset.y);
      return { ...pin, x: world.x, y: world.y };
    });
    const changed = nextPins.some((pin, index) => pin.x !== currentPins[index]?.x || pin.y !== currentPins[index]?.y);
    app.r.setPromotedPinIds(placements.filter((position) => position.promoted).map((position) => position.id));
    pinOverlay.innerHTML = placements.filter((position) => position.promoted).map((position) => {
      const pin = screenPins.find((item) => item.id === position.id);
      return pin ? pinMarkup(pin, position, (value) => value) : '';
    }).join('');
    if (changed) {
      adjustedPins = nextPins;
      adjustedPinOffsets = new Map(nextPins
        .map((pin, index): [string, number] => [pin.id, pin.y - basePins[index].y])
        .filter(([, dy]) => dy !== 0));
      updatingPins = true;
      app.r.setPins(nextPins);
      updatingPins = false;
    } else if (currentPins !== adjustedPins) {
      adjustedPins = null;
      adjustedPinOffsets.clear();
    }
  };

  const hasWithheldMember = (member: Obj): boolean => {
    if (member.type === 'sticky' && app.r.isHidden(member)) return true;
    if (!isConnector(member)) return false;
    return [member.from, member.to].some((end) => {
      if (end.kind !== 'bound') return false;
      const target = app.store.get(end.id);
      return target?.type === 'sticky' && app.r.isHidden(target);
    });
  };

  const memberCount = (group: Group) => app.store.childrenOf(group.id)
    .filter((member) => member.parent === group.id && !hasWithheldMember(member)).length;

  const pathFor = (group: Group) => {
    const chain: Group[] = [];
    const seen = new Set<string>();
    let at: Group | undefined = group;
    while (at && !seen.has(at.id)) {
      seen.add(at.id);
      chain.push(at);
      const parentGroup: Obj | undefined = at.parent ? app.store.get(at.parent) : undefined;
      at = parentGroup?.type === 'group' ? parentGroup as Group : undefined;
    }
    return groupPathLabel(chain.reverse().map((item) => item.name));
  };

  const positionChip = (chip: HTMLElement, x: number, y: number, topInset: number, viewport: { width: number; height: number }) => {
    chip.hidden = false;
    const position = clampGroupChipPosition(
      x,
      y,
      { width: chip.offsetWidth || 44, height: chip.offsetHeight || 20 },
      viewport,
      topInset,
    );
    chip.style.transform = `translate(${position.x}px, ${position.y}px)`;
  };
  const positionAt = (chip: HTMLElement, position: { x: number; y: number }) => {
    chip.style.transform = `translate(${position.x}px, ${position.y}px)`;
  };

  const place = () => {
    const viewportRect = parent.getBoundingClientRect();
    const viewport = { width: viewportRect.width || 1, height: viewportRect.height || 1 };
    const topInset = parseFloat(getComputedStyle(parent).getPropertyValue('--panel-top')) || 72;
    const toChipPoint = (bounds: { x: number; y: number; w: number; h: number }) => {
      const topLeft = app.r.toScreen({ x: bounds.x, y: bounds.y });
      const bottomRight = app.r.toScreen({ x: bounds.x + bounds.w, y: bounds.y + bounds.h });
      return { left: topLeft.x - 6, top: topLeft.y - 32, right: bottomRight.x + 6 };
    };

    const selected = app.selected();
    const group = selected.length === 1 && selected[0].type === 'group' ? selected[0] as Group : undefined;
    const selectedBounds = group && app.r.bounds(group);
    const showSelected = showSelectedGroupChip(!!group, app.dragging, app.dragging, app.zoom);
    if (group && selectedBounds && showSelected) {
      selectedChip.textContent = groupChipText(group.name, memberCount(group));
      const point = toChipPoint(selectedBounds);
      positionChip(selectedChip, point.left, point.top, topInset, viewport);
    } else {
      selectedChip.hidden = true;
    }

    const scope = app.scope ? app.store.get(app.scope) : undefined;
    const enteredGroup = scope?.type === 'group' ? scope as Group : undefined;
    const scopeBounds = enteredGroup ? app.r.bounds(enteredGroup) : null;
    let pinChips: EnteredChipPinBox[] | null = null;
    if (enteredGroup && scopeBounds) {
      const path = pathFor(enteredGroup);
      pathChip.textContent = path.text;
      pathChip.title = path.full;
      pathChip.setAttribute('aria-label', path.full);
      pathChip.hidden = false;
      const point = toChipPoint(scopeBounds);
      positionChip(pathChip, point.left, point.top, topInset, viewport);

      const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
      done.textContent = doneChipText(coarse);
      done.setAttribute('aria-label', `Done editing ${path.full}`);
      done.hidden = false;
      const placement = placeEnteredGroupChips(
        { x: point.left, y: point.top },
        { x: point.right - (done.offsetWidth || (coarse ? 48 : 76)), y: point.top },
        { width: pathChip.offsetWidth || 120, height: pathChip.offsetHeight || 20 },
        { width: done.offsetWidth || (coarse ? 48 : 76), height: done.offsetHeight || (coarse ? 28 : 20) },
        viewport,
        topInset,
      );
      positionAt(pathChip, placement.name);
      positionAt(done, placement.done);
      const chipBox = (position: { x: number; y: number }, size: { width: number; height: number }): EnteredChipPinBox => ({
        box: { x: position.x, y: position.y, w: size.width, h: size.height },
        text: {
          x: position.x + 9,
          y: position.y + (size.height - 11) / 2,
          w: Math.max(0, size.width - 18),
          h: 11,
        },
      });
      pinChips = [
        chipBox(placement.name, { width: pathChip.offsetWidth, height: pathChip.offsetHeight }),
        chipBox(placement.done, { width: done.offsetWidth, height: done.offsetHeight }),
      ];
    } else {
      pathChip.hidden = true;
      done.hidden = true;
    }
    applyPinLayout(pinChips);
  };

  app.on('selection', place);
  app.on('objects', place);
  app.on('drag', place);
  app.on('comments', place);
  const offComments = app.comments.onChange(place);
  const offCamera = app.r.onCamera(place);
  const offPins = app.r.onPins(() => { if (!updatingPins) place(); });
  const resize = new ResizeObserver(place);
  resize.observe(parent);
  app.onDestroy(() => {
    offComments();
    offCamera();
    offPins();
    resize.disconnect();
    const pins = sourcePins();
    app.r.setPromotedPinIds([]);
    if (app.r.pins === adjustedPins) {
      updatingPins = true;
      app.r.setPins(pins);
      updatingPins = false;
    }
    selectedChip.remove();
    pathChip.remove();
    done.remove();
    pinOverlay.remove();
  });
  place();
}
