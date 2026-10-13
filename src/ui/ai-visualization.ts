import './ai-visualization.css';
import type Websandbox from '@jetbrains/websandbox';
import { isVisualization, type Visualization } from '../../shared/ai-visualization';
import { dialog } from './common';
import { h } from './dom';

const FRAME_PATH = '/api/ai/visual-frame';
const MESSAGE_TYPE = 'tabula-visualization';
let current: { close(): void } | null = null;
let sequence = 0;

interface VisualizationOptions {
  onRetry: () => void;
  onClose?: () => void;
  cut?: boolean;
}

/** Completed generated UI stays in its own opaque iframe. It receives no board API, storage, credentials or host actions. */
export function showVisualization(visualization: Visualization, options: VisualizationOptions): { close(): void } {
  if (!isVisualization(visualization)) throw new Error('Invalid visualization');
  current?.close();
  const descriptionId = `visualization-description-${++sequence}`;
  const description = h('p', { id: descriptionId, class: 'ai-visualization-description' }, visualization.description);
  const status = h('p', { class: 'ai-visualization-status', role: 'status' }, 'Opening visualization…');
  const surface = h('div', { class: 'ai-visualization-surface', 'aria-busy': 'true' });
  const body = h('div', { class: 'ai-visualization-content' },
    description,
    options.cut ? h('p', { class: 'ai-visualization-note' }, 'Some board content was left out.') : null,
    status,
    surface,
  );
  let sandbox: Websandbox | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failed = false;
  const cleanup = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    window.removeEventListener('message', onMessage);
    sandbox?.destroy();
    sandbox = null;
    if (current === modal) current = null;
    options.onClose?.();
  };
  const modal = dialog(visualization.title, body, [
    { label: 'Retry', onClick: () => { modal.close(); options.onRetry(); return false; } },
    { label: 'Close' },
  ], { className: 'ai-visualization', onClose: cleanup });
  current = modal;
  modal.box.setAttribute('aria-describedby', descriptionId);

  const fail = () => {
    if (closed || failed) return;
    failed = true;
    if (timer) clearTimeout(timer);
    surface.setAttribute('aria-busy', 'false');
    sandbox?.destroy();
    sandbox = null;
    surface.hidden = true;
    status.hidden = false;
    status.setAttribute('role', 'alert');
    status.textContent = 'Could not open this visualization. Try again.';
  };
  function onMessage(event: MessageEvent) {
    if (closed || event.source !== sandbox?.iframe.contentWindow || event.origin !== 'null') return;
    const message = event.data;
    if (!message || typeof message !== 'object' || message.type !== MESSAGE_TYPE) return;
    if (message.action === 'escape') modal.close();
    else if (message.action === 'error') fail();
    else if (message.action === 'resize' && typeof message.height === 'number' && Number.isFinite(message.height)) {
      sandbox!.iframe.style.height = `${Math.max(240, Math.min(2000, Math.ceil(message.height)))}px`;
    }
  }
  window.addEventListener('message', onMessage);
  // A denied or missing frame never handshakes. This is a failure watchdog, not a generation deadline.
  timer = setTimeout(fail, 15_000);
  async function initialize() {
    // The package reads browser globals at import time. Load it only when this browser surface actually opens.
    const { default: Sandbox } = await import('@jetbrains/websandbox');
    if (closed || failed) return;
    sandbox = Sandbox.create({}, {
      frameContainer: surface,
      frameSrc: FRAME_PATH,
      sandboxAdditionalAttributes: '',
      allowAdditionalAttributes: '',
    });
    sandbox.iframe.title = visualization.title;
    sandbox.iframe.setAttribute('tabindex', '0');
    sandbox.iframe.style.height = `${visualization.initialHeight}px`;
    let loaded = false;
    sandbox.iframe.addEventListener('load', () => {
      if (loaded) fail();
      loaded = true;
    });
    void mount(sandbox).catch(fail);
  }
  void initialize().catch(fail);

  async function mount(frame: Websandbox) {
    await frame.promise;
    if (closed || failed) return;
    const theme = getComputedStyle(modal.box);
    const colors = ['--tray', '--tray-2', '--tray-text', '--tray-muted', '--tray-line', '--signal', '--on-signal']
      .map((name) => `${name}:${theme.getPropertyValue(name).trim()};`).join('');
    await frame.run(`
      window.addEventListener('error', function () { parent.postMessage({type:${JSON.stringify(MESSAGE_TYPE)}, action:'error'}, '*'); });
      window.addEventListener('unhandledrejection', function () { parent.postMessage({type:${JSON.stringify(MESSAGE_TYPE)}, action:'error'}, '*'); });
      window.addEventListener('keydown', function (event) {
        if (event.isTrusted && event.key === 'Escape') parent.postMessage({type:${JSON.stringify(MESSAGE_TYPE)}, action:'escape'}, '*');
      });
      document.body.innerHTML = ${JSON.stringify(visualization.html)};
      var themeStyle = document.createElement('style');
      themeStyle.textContent = ${JSON.stringify(`:root{${colors}}html{color-scheme:${theme.colorScheme};}body{margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;background:var(--tray);color:var(--tray-text);}button,input,select,textarea{font:inherit;}*:focus-visible{outline:2px solid var(--tray-text);outline-offset:3px;}`)};
      document.head.appendChild(themeStyle);
      var generatedStyle = document.createElement('style');
      generatedStyle.textContent = ${JSON.stringify(visualization.css)};
      document.head.appendChild(generatedStyle);
    `);
    if (closed || failed) return;
    if (visualization.jsFunctions) await frame.run(visualization.jsFunctions);
    for (const expression of visualization.jsExpressions) {
      if (closed || failed) return;
      await frame.run(expression);
    }
    if (closed || failed) return;
    await frame.run(`
      function reportVisualizationHeight() {
        parent.postMessage({type:${JSON.stringify(MESSAGE_TYPE)}, action:'resize', height:document.body.scrollHeight + 32}, '*');
      }
      new ResizeObserver(reportVisualizationHeight).observe(document.body);
      reportVisualizationHeight();
    `);
    if (closed || failed) return;
    if (timer) clearTimeout(timer);
    surface.setAttribute('aria-busy', 'false');
    status.hidden = true;
  }
  return { close: modal.close };
}
