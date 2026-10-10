/**
 * A hash change fires both `hashchange` and `popstate`, so a route listener on both runs twice for one move (the
 * sign-in link was verified twice: the second call failed and showed "link expired" to a signed-in person). This
 * returns a handler that lets a location through once; `again()` forgets it for a deliberate re-route.
 */
export function onceForLocation(go: () => void, href: () => string): { handle: () => void; again: () => void } {
  let last: string | null = null;
  return {
    handle() {
      const now = href();
      if (now === last) return;
      last = now;
      go();
    },
    again() {
      last = null;
    },
  };
}
