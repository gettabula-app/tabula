// The demo build resolves the tracker's UI and data modules to this file (see demoConfigPlugin in
// vite.config.ts). The demo has no account, so none of them can run; keeping the real ones out
// keeps the single-file demo bundle under the limit scripts/check-demo-dist.mjs enforces.
const unavailable = (): never => { throw new Error('The tracker is not part of the demo.'); };

export const createTrackerStore = unavailable;
export const createHttpTrackerApi = unavailable;
export const mountTrackerShell = unavailable;
export const trackerViewerState = unavailable;
export const mountTrackerFrames = unavailable;
export const installTrackerLinkDialog = (): (() => void) => () => undefined;
export const installTrackerUnlinkConfirm = (): (() => void) => () => undefined;
