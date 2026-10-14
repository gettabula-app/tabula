import './privacy-admin.css';
import { ApiError, api, type AdminPrivacy, type AdminPrivacyPreview, type Me } from '../api';
import { setSignedOut } from '../auth';
import { dialog } from './common';
import { h } from './dom';
import { PRIVACY_COPY, privacyCategoryText, privacyCoversHeading, privacyEditState, privacyHourlyNote, privacyLastChangedBy, privacyNoReport, privacyPreviewButton, privacyModeIntro, privacySharingState, privacyStayOnHeading, privacyStayOnLead, privacySwitchLabel, privacyTimestamp } from './privacy-logic';

const PREVIEW_ID = 'privacy-preview-content';

/** Workspace privacy and telemetry controls. Admins can read the setting; only the owner can change it. */
export function privacyAdminPanel(me: Me): HTMLElement {
  const root = h('div', { class: 'privacy-admin' });
  let saved: AdminPrivacy | null = null;
  let loadFailed = false;
  let busy = false;
  let pendingEnabled: boolean | null = null;
  let outcome = '';
  let previewOpen = false;
  let previewLoading = false;
  let previewFailed = false;
  let previewReply: AdminPrivacyPreview | null = null;
  let copyOutcome = '';
  let previewRun = 0;

  const leaveOnAuthError = (error: unknown): boolean => {
    if (!(error instanceof ApiError)) return false;
    if (error.status === 401) {
      setSignedOut();
      location.hash = '#/signin';
      return true;
    }
    if (error.status === 403) {
      location.replace('#/');
      return true;
    }
    return false;
  };

  const load = () => {
    loadFailed = false;
    render();
    void api.adminPrivacy().then((state) => {
      saved = state;
      render();
    }, (error: unknown) => {
      if (leaveOnAuthError(error)) return;
      loadFailed = true;
      render();
    });
  };

  const save = async (enabled: boolean) => {
    if (!saved || busy || privacyEditState(me.user.role, saved.locked).disabled) return;
    pendingEnabled = enabled;
    busy = true;
    outcome = '';
    render();
    try {
      saved = await api.setAdminPrivacy(enabled);
      outcome = PRIVACY_COPY.saved;
    } catch (error) {
      if (!leaveOnAuthError(error)) outcome = PRIVACY_COPY.saveFailed;
    } finally {
      busy = false;
      pendingEnabled = null;
      render();
    }
  };

  const loadPreview = () => {
    previewOpen = true;
    previewLoading = true;
    previewFailed = false;
    copyOutcome = '';
    const mine = ++previewRun;
    render();
    void api.adminPrivacyPreview().then((reply) => {
      if (mine !== previewRun || !root.isConnected || !previewOpen) return;
      previewReply = reply;
      previewLoading = false;
      render();
    }, (error: unknown) => {
      if (mine !== previewRun || !root.isConnected || !previewOpen || leaveOnAuthError(error)) return;
      previewLoading = false;
      previewFailed = true;
      render();
    });
  };

  const togglePreview = () => {
    if (previewOpen) {
      previewOpen = false;
      previewRun++;
      previewLoading = false;
      render();
    } else {
      loadPreview();
    }
  };

  const copyPreview = async () => {
    const payload = previewReply?.preview;
    if (!payload) return;
    const text = JSON.stringify(payload, null, 2);
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard?.writeText) throw new Error('clipboard_unavailable');
      await clipboard.writeText(text);
      copyOutcome = PRIVACY_COPY.copied;
    } catch {
      copyOutcome = PRIVACY_COPY.copyUnavailable;
    }
    render();
  };

  function render() {
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement && root.contains(active) ? active.dataset.focus : undefined;
    if (!saved) {
      if (loadFailed) {
        root.replaceChildren(h('div', { class: 'admin-state admin-error', role: 'alert' },
          h('span', null, PRIVACY_COPY.loadFailed),
          h('button', { class: 'btn', type: 'button', 'data-focus': 'retry', onclick: load }, PRIVACY_COPY.retry)));
      } else {
        root.replaceChildren(h('p', { class: 'admin-state muted', role: 'status' }, PRIVACY_COPY.loading));
      }
      if (focusKey) root.querySelector<HTMLElement>(`[data-focus="${focusKey}"]`)?.focus();
      return;
    }

    const edit = privacyEditState(me.user.role, saved.locked);
    const checked = pendingEnabled ?? saved.enabled;
    const stateText = privacySharingState(checked);
    const helpId = 'privacy-setting-help';
    const accessId = 'privacy-setting-access';
    const reasonText = edit.reasons.join(' ');
    const lastPreparedAt = previewReply?.builtAt ?? saved.lastBuiltAt;
    const timestamp = lastPreparedAt === null ? null : privacyTimestamp(lastPreparedAt);
    const toggle = h('label', { class: 'check privacy-toggle' },
      h('input', {
        type: 'checkbox',
        checked,
        disabled: edit.disabled,
        'aria-describedby': reasonText ? `${helpId} ${accessId}` : helpId,
        'data-focus': 'toggle',
        onchange: (event: Event) => {
          const input = event.currentTarget as HTMLInputElement;
          if (busy) {
            render();
            return;
          }
          if (saved?.mode === 'self' && !saved.enabled && input.checked) {
            render();
            dialog(PRIVACY_COPY.confirmSelfOnTitle, h('p', null, PRIVACY_COPY.confirmSelfOnText), [
              { label: PRIVACY_COPY.cancel },
              { label: PRIVACY_COPY.turnOn, primary: true, onClick: () => save(true) },
            ], { className: 'privacy-confirm' });
            return;
          }
          void save(input.checked);
        },
      }),
      h('span', null, privacySwitchLabel(saved.mode)));

    // a key this build has no sentence for (a newer server) is left out rather than shown as an internal name
    const categoryLines = (keys: readonly string[]) => keys.flatMap((key) => {
      const text = privacyCategoryText(key);
      return text === null ? [] : [h('li', null, text)];
    });
    const previewText = previewReply?.preview ? JSON.stringify(previewReply.preview, null, 2) : '';
    const previewBuilt = previewReply ? privacyTimestamp(previewReply.builtAt) : null;
    const lastChangedBy = privacyLastChangedBy(saved.lastChangedBy);
    const previewBody = previewLoading
      ? h('p', { class: 'admin-state muted', role: 'status' }, PRIVACY_COPY.previewLoading)
      : previewFailed
        ? h('div', { class: 'admin-state admin-error', role: 'alert' },
          h('span', null, PRIVACY_COPY.previewFailed),
          h('button', { class: 'btn', type: 'button', 'data-focus': 'preview', onclick: loadPreview }, PRIVACY_COPY.retry))
        : previewReply?.problem === 'workspace_id'
          ? h('p', { class: 'privacy-note', role: 'status' }, PRIVACY_COPY.workspaceIdInvalid)
        : previewReply?.preview === null
          ? h('p', { class: 'privacy-note', role: 'status' }, privacyNoReport(saved.mode))
          : previewReply
            ? h('div', null,
              previewBuilt ? h('p', { class: 'privacy-preview-time' }, `${PRIVACY_COPY.previewBuilt}: `, h('time', { datetime: previewBuilt.iso }, previewBuilt.label)) : null,
              h('div', { class: 'privacy-actions' }, h('button', { class: 'btn', type: 'button', 'data-focus': 'copy', onclick: () => void copyPreview() }, PRIVACY_COPY.copy)),
              h('pre', { class: 'privacy-json', tabindex: '0', 'aria-label': PRIVACY_COPY.previewAriaLabel }, previewText),
              h('p', { class: 'privacy-outcome', role: 'status', 'aria-live': 'polite' }, copyOutcome))
            : null;

    root.setAttribute('aria-busy', String(busy));
    root.replaceChildren(
      h('p', { class: 'privacy-intro' }, privacyModeIntro(saved.mode)),
      toggle,
      h('p', { class: 'privacy-description' }, PRIVACY_COPY.analyticsText),
      h('p', { id: helpId, class: 'privacy-state-note', role: 'status', 'aria-live': 'polite' }, h('strong', null, stateText), ' ', privacyHourlyNote(saved.mode)),
      h('p', { id: accessId, class: 'privacy-access' }, reasonText),
      ...(lastChangedBy ? [h('p', { class: 'privacy-last-changed' }, lastChangedBy)] : []),
      h('section', { class: 'privacy-section', 'aria-labelledby': 'privacy-covers-heading' },
        h('h3', { class: 'privacy-subhead', id: 'privacy-covers-heading' }, privacyCoversHeading(saved.mode)),
        h('ul', { class: 'privacy-list' }, categoryLines(saved.categories))),
      h('section', { class: 'privacy-section', 'aria-labelledby': 'privacy-operational-heading' },
        h('h3', { class: 'privacy-subhead', id: 'privacy-operational-heading' }, privacyStayOnHeading(saved.mode)),
        h('p', { class: 'privacy-lead' }, privacyStayOnLead(saved.mode)),
        h('ul', { class: 'privacy-list' }, categoryLines(saved.operational))),
      h('details', { class: 'privacy-section' },
        h('summary', null, PRIVACY_COPY.neverHeading),
        h('ul', { class: 'privacy-list' }, PRIVACY_COPY.neverSent.map((item) => h('li', null, item)))),
      h('dl', { class: 'privacy-facts' },
        h('div', { class: 'privacy-fact' },
          h('dt', null, PRIVACY_COPY.lastBuilt),
          h('dd', null, timestamp ? h('time', { datetime: timestamp.iso }, timestamp.label) : PRIVACY_COPY.neverBuilt))),
      h('div', { class: 'privacy-section' },
        h('div', { class: 'privacy-actions' },
          h('button', {
            class: 'btn',
            type: 'button',
            'data-focus': 'preview',
            'aria-expanded': String(previewOpen),
            'aria-controls': PREVIEW_ID,
            onclick: togglePreview,
          }, previewOpen ? PRIVACY_COPY.hidePreviewButton : privacyPreviewButton(saved.mode)),
          h('a', { class: 'privacy-doc-link', href: PRIVACY_COPY.catalogueHref }, PRIVACY_COPY.catalogue)),
        h('div', { id: PREVIEW_ID, class: 'privacy-preview', hidden: !previewOpen }, previewBody)),
      h('p', { class: 'privacy-outcome', role: outcome === PRIVACY_COPY.saveFailed ? 'alert' : 'status', 'aria-live': 'polite' }, outcome),
    );
    if (focusKey) root.querySelector<HTMLElement>(`[data-focus="${focusKey}"]`)?.focus();
  }

  load();
  return root;
}
