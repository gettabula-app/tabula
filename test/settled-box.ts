import type { Locator } from 'playwright';

/**
 * Waits until a popover, menu, dialog or sheet has finished its entrance before a test reads its box.
 *
 * The entrance animations (popover-in, modal-in, the phone sheet's slide) scale or move the box for 120 to 200 ms,
 * so a bounding box read during them is transient. This waits for every finite animation or transition that is
 * running on the element, on its ancestors or on its descendants, then for the box to be identical over two
 * animation frames with nothing still running. Infinite animations (such as the link preview's `.link-seg`) never
 * finish and are not waited for; the box check still covers what they draw.
 *
 * It throws with the boxes it saw when the box keeps moving, so an instability is reported rather than hidden.
 * Use it only before a read that is meant to see the settled state, and keep the assertions themselves strict.
 */
export async function settledBox(target: Locator, timeoutMs = 5_000): Promise<void> {
  await target.evaluate(async (element, timeout) => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const box = () => {
      const r = element.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map((value) => Math.round(value * 100) / 100).join(', ');
    };
    const related = () => document.getAnimations().filter((animation) => {
      const node = (animation.effect as KeyframeEffect | null)?.target;
      if (!(node instanceof Element)) return false;
      if (!(node === element || node.contains(element) || element.contains(node))) return false;
      return animation.effect!.getComputedTiming().endTime !== Infinity;
    });
    const running = (animation: Animation) => animation.playState !== 'finished' && animation.playState !== 'idle' && animation.playState !== 'paused';
    const started = performance.now();
    let previous: string | null = null;
    for (;;) {
      await Promise.all(related().filter(running).map((animation) => animation.finished.catch(() => undefined)));
      await frame();
      const now = box();
      const idle = !related().some(running);
      if (idle && now === previous) return;
      if (performance.now() - started > timeout) {
        throw new Error(`the box did not settle within ${timeout} ms: last ${now}, before that ${previous ?? 'none'}`);
      }
      previous = now;
    }
  }, timeoutMs);
}
