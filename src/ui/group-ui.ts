import './group-ui.css';
import type { BoardApp } from '../app';
import { isConnector } from '../types';
import type { Group, Obj } from '../types';
import { h } from './dom';
import { PIN_R } from '../pins';
import { clampGroupChipPosition, doneChipText, groupChipText, groupPathLabel, placeEnteredGroupChips, showSelectedGroupChip } from './group-ui-logic';

/** The local group scope controls; outlines and dimming are renderer overlays. */
export function mountGroupUI(app: BoardApp, parent: HTMLElement) {
  const selectedChip = h('div', { class: 'group-chip', hidden: true, 'aria-hidden': 'true' });
  const chipBridge = h('div', { class: 'group-chip-bridge', hidden: true, 'aria-hidden': 'true' });
  const pathChip = h('div', { class: 'group-chip group-path-chip', hidden: true });
  const done = h('button', { class: 'group-done', type: 'button', hidden: true, onclick: () => app.leaveGroup() });
  parent.append(selectedChip, chipBridge, pathChip, done);

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
    if (enteredGroup && scopeBounds) {
      chipBridge.hidden = true;
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
      const nameRight = placement.name.x + pathChip.offsetWidth;
      const doneLeft = placement.done.x;
      const rowHeight = Math.max(pathChip.offsetHeight, done.offsetHeight);
      if (doneLeft > nameRight && app.r.pins.some((pin) => {
        if (pin.draft) return false;
        const at = app.r.toScreen({ x: pin.x, y: pin.y });
        const extent = pin.count > 1 ? PIN_R * 2 + 4 : PIN_R * 2;
        return at.x < doneLeft && at.x + extent > nameRight &&
          at.y - extent < placement.name.y + rowHeight && at.y > placement.name.y;
      })) {
        chipBridge.hidden = false;
        chipBridge.style.width = `${doneLeft - nameRight}px`;
        chipBridge.style.height = `${rowHeight}px`;
        positionAt(chipBridge, { x: nameRight, y: placement.name.y });
      }
    } else {
      pathChip.hidden = true;
      done.hidden = true;
      chipBridge.hidden = true;
    }
  };

  app.on('selection', place);
  app.on('objects', place);
  app.on('drag', place);
  app.on('comments', place);
  const offComments = app.comments.onChange(place);
  const offCamera = app.r.onCamera(place);
  const resize = new ResizeObserver(place);
  resize.observe(parent);
  app.onDestroy(() => {
    offComments();
    offCamera();
    resize.disconnect();
    selectedChip.remove();
    chipBridge.remove();
    pathChip.remove();
    done.remove();
  });
  place();
}
