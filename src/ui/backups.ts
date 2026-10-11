import './backups.css';
import { ApiError, api, type BackupBoard, type BackupList, type BackupPreview, type BackupSummary, type BoardCopy, type Me, type TrackerCheckState, type TrackerReadinessReport } from '../api';
import { setSignedOut } from '../auth';
import { freeWorkspaceNote, portalTarget } from '../cloud-logic';
import { countLabel, matchesQuery } from './admin-logic';
import {
  ATTESTATION_DISCLAIMER, CONFIRM_WORD, EPOCH_CONFIRM_WORD, EPOCH_WARNING_COPY, LIST_CAP, checkStateSentence, errorSentence, formatSize, formatUtc, gateBannerSentence,
  confirmMatches, boardsFailedSentence, lastRestoreSentence, manifestTime, nextScreen, noteOf, readinessOverallLabel, relativeTime, restoreGate, selectable, shortKey, statusRows, submitOutcome,
  trackerCheckLabel, validateDrillRecord, type Screen, type ScreenEvent, type StatusRow,
} from './backups-logic';
import { h, icon } from './dom';
import { showRestoring } from './restoring';
import type { AdminKit } from './tokens';

// The Backups tab of the admin dashboard (owner only): the state of the backups, the list, one backup in detail, a board
// restored as a copy, the whole workspace restored, and the screen that waits for the server. docs/backups.md, "In the app".

/** Where the self-hosted "not set up" state sends the owner: the part of the user guide that names the TABULA_BACKUP_* settings. */
export const BACKUP_DOCS = '/docs/admin#backups';

const COLUMNS = 'minmax(0, 1.6fr) 64px 80px 100px minmax(0, 1.5fr) auto';

/** An API failure whose message is the plain sentence for its code, so the dashboard's error line never shows a code. */
function plain(e: unknown): unknown {
  return e instanceof ApiError ? new ApiError(e.status, e.code, errorSentence(e.code, e.facts), e.facts) : e;
}

const fail = (e: unknown): never => {
  throw plain(e);
};

/** The sentence to show for anything that went wrong. */
function sentenceOf(e: unknown): string {
  return e instanceof ApiError ? errorSentence(e.code, e.facts) : errorSentence(undefined);
}

/** A dead session goes to sign-in. Returns true when it did. */
function signedOut(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 401) return false;
  setSignedOut();
  location.hash = '#/signin';
  return true;
}

const cellLabel = (label: string) => h('span', { class: 'admin-cell-label' }, `${label} `);
const badge = (text: string, tone?: 'bad') => h('span', { class: tone === 'bad' ? 'admin-badge backups-badge bad' : 'admin-badge backups-badge' }, text);

type Loaded = { off: true } | { off: false; data: BackupList };

function loadListing(): Promise<Loaded> {
  return api.adminBackups().then(
    (data): Loaded => ({ off: false, data }),
    (e: unknown): Loaded => {
      if (e instanceof ApiError && e.code === 'backups_off') return { off: true };
      return fail(e);
    },
  );
}

const timeOf = (b: { name: string; createdAt: number | null }) => b.createdAt ?? manifestTime(b.name);

/** The children that exist: replaceChildren takes no null. */
const nodes = (...children: (Node | null)[]): Node[] => children.filter((n): n is Node => n !== null);

/** The body of the admin dashboard's Backups tab. Owners only: the tab is not listed for anyone else. */
export function backupsAdminPanel(me: Me, kit: AdminKit): HTMLElement {
  const root = h('div', { class: 'backups' });
  const hosted = me.workspace !== undefined;
  let readOnly = me.workspace?.readOnly === true;
  let screen: Screen = { name: 'list' };
  let listing: BackupList | null = null;
  let focusRow: string | null = null;
  let readiness: TrackerReadinessReport | null = null;
  let readinessError: unknown = null;
  let readinessActionError: unknown = null;
  let readinessUnavailable = false;
  let readinessAuthFailed = false;
  let readinessLoading = false;
  let readinessRequested = false;
  let readinessRun = 0;
  let readinessSection: HTMLElement | null = null;
  let epochTyped = '';
  let epochBusy = false;
  let drillJson = '';
  let drillIssue = '';
  let drillBusy = false;
  let cutoverDate = '';
  let cutoverAccepted = false;
  let cutoverBusy = false;

  const go = (event: ScreenEvent) => {
    const next = nextScreen(screen, event);
    if (next === screen) return;
    if (screen.name === 'detail' && event.type === 'back') focusRow = screen.manifest;
    screen = next;
    render();
  };

  /** A screen below the list: a way back, a title the focus lands on, and a body that loads on its own. */
  const frame = (title: string, back: string, body: HTMLElement): HTMLElement =>
    h('div', { class: 'backups-screen' },
      h('button', { class: 'backups-back', onclick: () => go({ type: 'back' }) }, icon('prev', 16), h('span', null, back)),
      h('h3', { class: 'admin-sub', tabindex: -1, 'data-screen-focus': '' }, title),
      body);

  const errorBox = (e: unknown) => h('div', { class: 'admin-state admin-error', role: 'alert' }, h('span', null, sentenceOf(e)));
  const textError = (sentence: string) => h('div', { class: 'admin-state admin-error', role: 'alert' }, h('span', null, sentence));

  function checkStateLabel(state: TrackerCheckState): string {
    switch (state) {
      case 'pass': return 'Pass';
      case 'fail': return 'Fail';
      case 'unknown': return 'Unknown';
      case 'na': return 'Not applicable';
    }
  }

  const CHECK_ORDER: Record<TrackerCheckState, number> = { fail: 0, unknown: 1, pass: 2, na: 3 };
  let ownerActionsOpen = false;

  function readinessCheckRow(check: TrackerReadinessReport['checks'][number]): HTMLElement {
    const stateIcon = check.state === 'pass' ? icon('check', 14) : check.state === 'fail' ? icon('close', 14) : check.state === 'unknown' ? icon('timer', 14) : null;
    return h('div', { class: 'backups-readiness-row', 'data-check-id': check.id },
      h('div', { class: 'backups-readiness-name' },
        h('strong', null, trackerCheckLabel(check.id, check.label)),
        h('span', { class: `admin-badge backups-badge backups-check-state ${check.state === 'fail' ? 'bad' : ''}` }, stateIcon, h('span', null, checkStateLabel(check.state)))),
      // the badge already says Pass; the sentence is for the checks that need a second look
      check.state === 'fail' || check.state === 'unknown' ? h('p', { class: 'backups-readiness-sentence' }, checkStateSentence(check.state)) : null,
      check.detail === undefined ? null : h('p', { class: 'muted small backups-readiness-detail' }, check.detail));
  }

  function renderReadinessSection(): void {
    if (!readinessSection) return;
    if (readinessUnavailable) {
      readinessSection.replaceChildren(h('p', { class: 'muted small' }, 'Tracker readiness is not available on this server yet.'));
      return;
    }
    if (readinessAuthFailed) {
      readinessSection.replaceChildren();
      return;
    }

    const refresh = h('button', {
      class: 'btn', disabled: readinessLoading,
      onclick: () => void refreshReadiness(true),
    }, readinessLoading ? 'Refreshing…' : 'Refresh');
    const body: Node[] = [
      h('div', { class: 'backups-readiness-heading' }, h('h3', { class: 'admin-sub' }, 'Tracker readiness'), refresh),
    ];
    if (readinessLoading) body.push(h('p', { class: 'muted small', role: 'status' }, readiness ? 'Refreshing the readiness report…' : 'Loading tracker readiness…'));
    if (readinessError) body.push(errorBox(readinessError));
    if (readiness) {
      const overallLabel = readinessOverallLabel(readiness.overall);
      const overallIcon = readiness.overall === 'go' ? 'check' : readiness.overall === 'no_go' ? 'close' : 'timer';
      body.push(h('div', { class: 'backups-readiness-overall' },
        h('span', { class: `admin-badge backups-badge ${readiness.overall === 'no_go' ? 'bad' : ''}`, 'aria-label': `Overall readiness: ${overallLabel}` }, icon(overallIcon, 16), h('span', null, overallLabel)),
        h('p', { class: 'muted small' }, `Targets: ${readiness.targets.rpoMinutes} ${readiness.targets.rpoMinutes === 1 ? 'minute' : 'minutes'} RPO, ${readiness.targets.rtoHours} ${readiness.targets.rtoHours === 1 ? 'hour' : 'hours'} RTO, ${readiness.targets.retentionDays} days retained.`)));
      if (readiness.gate) body.push(h('p', { class: 'backups-notice backups-readiness-gate' }, gateBannerSentence(readiness.gate, Date.now())));
      body.push(h('div', { class: 'backups-readiness-checks' }, [...readiness.checks].sort((x, y) => CHECK_ORDER[x.state] - CHECK_ORDER[y.state]).map(readinessCheckRow)));
      const owner = h('details', { class: 'backups-readiness-owner', open: ownerActionsOpen || Boolean(drillIssue || readinessActionError || epochBusy) },
        h('summary', null, 'Owner records and actions'),
        epochForm(), drillRecordForm(), cutoverRecordForm());
      owner.addEventListener('toggle', () => { ownerActionsOpen = (owner as HTMLDetailsElement).open; });
      body.push(owner);
    } else if (!readinessError && !readinessLoading) {
      body.push(h('p', { class: 'muted small', role: 'status' }, 'Loading tracker readiness…'));
    }
    if (readinessActionError) body.push(errorBox(readinessActionError));
    readinessSection.replaceChildren(...body);
  }

  function createReadinessSection(): HTMLElement | null {
    if (me.tracker !== true) return null;
    readinessSection = h('section', { class: 'backups-readiness', 'aria-label': 'Tracker readiness' });
    renderReadinessSection();
    return readinessSection;
  }

  function refreshReadiness(force: boolean): Promise<void> {
    if (me.tracker !== true || readinessLoading || (!force && readinessRequested)) return Promise.resolve();
    readinessRequested = true;
    readinessLoading = true;
    readinessError = null;
    readinessActionError = null;
    readinessUnavailable = false;
    readinessAuthFailed = false;
    const mine = ++readinessRun;
    renderReadinessSection();
    return api.adminTrackerReadiness().then(
      (report) => {
        if (mine !== readinessRun) return;
        readiness = report;
        readinessError = null;
        readinessUnavailable = false;
        readinessLoading = false;
        renderReadinessSection();
      },
      (e: unknown) => {
        if (mine !== readinessRun) return;
        readinessLoading = false;
        if (signedOut(e)) {
          readinessAuthFailed = true;
          readinessError = null;
        } else if (e instanceof ApiError && (e.status === 404 || e.code === 'not_found')) {
          readiness = null;
          readinessError = null;
          readinessUnavailable = true;
        } else {
          readinessError = e;
        }
        renderReadinessSection();
      },
    );
  }

  function epochForm(): HTMLElement {
    const problem = h('div', { class: 'backups-readiness-form-error' });
    const submit = h('button', {
      class: 'btn', disabled: epochBusy || readinessLoading || !confirmMatches(epochTyped, EPOCH_CONFIRM_WORD),
      'aria-describedby': 'tracker-epoch-warning',
      onclick: () => void submitEpoch(),
    }, epochBusy ? 'Moving counters…' : 'Move counters forward');
    const input = h('input', {
      class: 'input', id: 'tracker-epoch-confirm', type: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
      value: epochTyped, 'aria-describedby': 'tracker-epoch-warning',
      oninput: (event: Event) => {
        epochTyped = (event.currentTarget as HTMLInputElement).value;
        submit.disabled = epochBusy || readinessLoading || !confirmMatches(epochTyped, EPOCH_CONFIRM_WORD);
      },
    });
    return h('div', { class: 'backups-readiness-form' },
      h('h4', { class: 'admin-kicker' }, 'Move the tracker counter epoch'),
      h('p', { class: 'muted small', id: 'tracker-epoch-warning' }, EPOCH_WARNING_COPY),
      h('label', { class: 'backups-label', for: 'tracker-epoch-confirm' }, `Type ${EPOCH_CONFIRM_WORD} to confirm`),
      input,
      h('div', { class: 'btn-row backups-actions' }, submit),
      problem);
  }

  async function submitEpoch(): Promise<void> {
    if (epochBusy || readinessLoading || !confirmMatches(epochTyped, EPOCH_CONFIRM_WORD)) return;
    epochBusy = true;
    readinessActionError = null;
    renderReadinessSection();
    try {
      await api.adminTrackerKeyEpoch();
      epochTyped = '';
      await refreshReadiness(true);
    } catch (e) {
      if (signedOut(e)) return;
      readinessActionError = e;
    } finally {
      epochBusy = false;
      renderReadinessSection();
    }
  }

  function drillRecordForm(): HTMLElement {
    const problem = h('div', { class: 'backups-readiness-form-error' }, drillIssue ? textError(drillIssue) : null);
    async function submitDrill(): Promise<void> {
      if (drillBusy || readinessLoading) return;
      const result = validateDrillRecord(drillJson);
      if ('reason' in result) {
        drillIssue = result.reason;
        problem.replaceChildren(textError(drillIssue));
        return;
      }
      drillIssue = '';
      problem.replaceChildren();
      drillBusy = true;
      readinessActionError = null;
      renderReadinessSection();
      try {
        await api.adminTrackerDrillRecord(result.record);
        drillJson = '';
        await refreshReadiness(true);
      } catch (e) {
        if (signedOut(e)) return;
        readinessActionError = e;
      } finally {
        drillBusy = false;
        renderReadinessSection();
      }
    }
    const onSubmit = (event: Event) => {
      event.preventDefault();
      void submitDrill();
    };
    const submit = h('button', {
      class: 'btn', type: 'submit', disabled: drillBusy || readinessLoading,
      onclick: onSubmit,
    }, drillBusy ? 'Saving drill record…' : 'Save drill record');
    return h('form', {
      class: 'backups-readiness-form',
      onsubmit: onSubmit,
    },
      h('h4', { class: 'admin-kicker' }, 'Record a restore drill'),
      h('p', { class: 'muted small' }, ATTESTATION_DISCLAIMER),
      h('label', { class: 'backups-label', for: 'tracker-drill-json' }, 'Paste the drill JSON'),
      h('textarea', {
        class: 'input backups-readiness-json', id: 'tracker-drill-json', rows: 8, value: drillJson,
        oninput: (event: Event) => {
          drillJson = (event.currentTarget as HTMLTextAreaElement).value;
          if (drillIssue) {
            drillIssue = '';
            problem.replaceChildren();
          }
        },
      }),
      h('div', { class: 'btn-row backups-actions' }, submit),
      problem);
  }

  function cutoverRecordForm(): HTMLElement {
    let submit: HTMLButtonElement | null = null;
    const updateSubmit = () => {
      if (submit) submit.disabled = cutoverBusy || readinessLoading || !cutoverDate || !cutoverAccepted;
    };
    async function submitCutover(): Promise<void> {
      if (cutoverBusy || readinessLoading || !cutoverDate || !cutoverAccepted) return;
      cutoverBusy = true;
      readinessActionError = null;
      renderReadinessSection();
      try {
        await api.adminTrackerCutoverRecord({ importVerifiedAt: cutoverDate, lossReportAccepted: true });
        await refreshReadiness(true);
      } catch (e) {
        if (signedOut(e)) return;
        readinessActionError = e;
      } finally {
        cutoverBusy = false;
        renderReadinessSection();
      }
    }
    const onSubmit = (event: Event) => {
      event.preventDefault();
      void submitCutover();
    };
    submit = h('button', {
      class: 'btn', type: 'submit', disabled: cutoverBusy || readinessLoading || !cutoverDate || !cutoverAccepted,
      onclick: onSubmit,
    }, cutoverBusy ? 'Saving cutover check…' : 'Save cutover check');
    return h('form', { class: 'backups-readiness-form', onsubmit: onSubmit },
      h('h4', { class: 'admin-kicker' }, 'Record the cutover check'),
      h('p', { class: 'muted small' }, ATTESTATION_DISCLAIMER),
      h('label', { class: 'backups-label', for: 'tracker-import-verified-at' }, 'Import verified at'),
      h('input', {
        class: 'input', id: 'tracker-import-verified-at', type: 'date', value: cutoverDate,
        oninput: (event: Event) => {
          cutoverDate = (event.currentTarget as HTMLInputElement).value;
          updateSubmit();
        },
      }),
      h('label', { class: 'backups-readiness-checkbox' },
        h('input', {
          type: 'checkbox', checked: cutoverAccepted,
          onchange: (event: Event) => {
            cutoverAccepted = (event.currentTarget as HTMLInputElement).checked;
            updateSubmit();
          },
        }),
        h('span', null, 'I accepted the loss report')),
      h('div', { class: 'btn-row backups-actions' }, submit));
  }

  // ------------------------------------------------------------ not set up

  function offView(): Node[] {
    const lead = hosted
      ? 'This workspace has no backups yet. Backups copy everything to storage away from the server on a schedule, encrypted before it leaves, so a deleted board or a mistake can be undone.'
      : 'Backups are off on this server. When they are on, Tabula copies everything to an S3-compatible bucket on a schedule, encrypted before it leaves the server, and you can bring back one board or the whole workspace from here. They are turned on with the TABULA_BACKUP_* settings of the server.';
    return [
      h('h3', { class: 'admin-sub' }, 'Not set up'),
      h('p', { class: 'backups-lead' }, lead),
      hosted ? (freeWorkspaceNote(me) ? h('p', { class: 'muted' }, freeWorkspaceNote(me)) : addBackups()) : h('a', { class: 'btn', href: BACKUP_DOCS }, 'How to turn on backups'),
      ...nodes(readinessSection),
    ];
  }

  /** The billing portal, by the same owner flow the Overview uses. */
  function addBackups(): HTMLElement {
    const button = h('button', { class: 'btn primary' }, 'Add backups');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await kit.change(async () => {
          const { url } = await api.billingPortal();
          const target = portalTarget(url);
          if (!target) throw new Error('The billing portal address was not valid');
          location.assign(target);
        }, 'Opening billing…');
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  // ------------------------------------------------------------ the list

  const statusList = (rows: StatusRow[]) =>
    h('dl', { class: 'admin-facts' }, rows.map((r) =>
      h('div', { class: 'admin-fact' },
        h('dt', null, r.label),
        h('dd', null, r.badge ? [badge(r.badge, r.badge === 'Failed' ? 'bad' : undefined), ' '] : null, r.value, r.note ? h('div', { class: 'muted small' }, r.note) : null))));

  function backupRow(b: BackupSummary, now: number): HTMLElement {
    const at = timeOf(b);
    const when = at === null ? 'Unknown time' : formatUtc(at);
    const open = selectable(b)
      ? h('button', {
        class: 'btn', 'data-focus': `${b.name}:open`, 'aria-label': `Details of the backup of ${when}`,
        onclick: () => go({ type: 'open', manifest: b.name }),
      }, 'Details')
      : null;
    const note = noteOf(b);
    const cell = (label: string, ...content: (Node | string | null)[]) => h('div', { class: 'admin-cell', role: 'cell' }, cellLabel(label), ...content);
    return h('div', { class: b.readable ? 'admin-row backups-row' : 'admin-row backups-row unreadable', role: 'row', 'aria-disabled': b.readable ? undefined : 'true' },
      h('div', { class: 'admin-cell backups-when', role: 'cell' },
        h('span', { class: 'admin-name' }, when),
        at === null ? null : h('span', { class: 'muted small' }, relativeTime(at, now))),
      h('div', { class: 'backups-meta', role: 'presentation' },
        cell('Files', b.readable ? String(b.files ?? 0) : '–'),
        cell('Size', b.readable ? formatSize(b.bytes) : '–'),
        cell('Key', b.readable ? shortKey(b.keyId) : '–')),
      h('div', { class: 'admin-cell backups-note', role: 'cell' }, note),
      h('div', { class: 'btn-row admin-actions', role: 'cell' }, open));
  }

  function table(data: BackupList, now: number): HTMLElement {
    const box = h('div', { class: 'admin-box backups-table', style: `--cols: ${COLUMNS}` });
    if (!data.backups.length) {
      box.append(kit.emptyLine('No backups yet. The first one is made a few minutes after the server starts.'));
      return box;
    }
    box.setAttribute('role', 'table');
    box.setAttribute('aria-label', 'Backups');
    const header = kit.head(['When', 'Files', 'Size', 'Key', 'Notes', '']);
    header.setAttribute('role', 'row');
    [...header.children].forEach((cell, i) => {
      cell.setAttribute('role', 'columnheader');
      if (i === 5) cell.setAttribute('aria-label', 'Actions');
    });
    box.append(header, ...data.backups.map((b) => backupRow(b, now)));
    return box;
  }

  function listView(data: BackupList): Node[] {
    const now = Date.now();
    const busy = data.restore.inProgress !== null || data.restore.maintenance;
    const last = lastRestoreSentence(data.restore.last);
    const failedBoards = boardsFailedSentence(data.restore.last);
    return nodes(
      busy ? h('p', { class: 'backups-notice', role: 'status' }, 'A restore is running right now. Nothing else can be restored until it is done.') : null,
      h('h3', { class: 'admin-sub' }, 'Status'),
      statusList(statusRows(data.status, now)),
      last ? h('p', { class: 'backups-last' }, last) : null,
      failedBoards ? h('p', { class: 'backups-notice', role: 'status' }, failedBoards) : null,
      h('h3', { class: 'admin-sub' }, countLabel(data.backups.length, 'backup', 'backups')),
      table(data, now),
      data.truncated ? h('p', { class: 'muted small backups-more', role: 'status' }, `Showing the newest ${LIST_CAP} backups. Older ones are not listed.`) : null,
      readinessSection);
  }

  function listScreen(): HTMLElement {
    const box = h('div', { class: 'backups-screen' });
    createReadinessSection();
    if (me.tracker === true) void refreshReadiness(false);
    kit.loadList(box, loadListing, (loaded) => {
      if (loaded.off) {
        listing = null;
        box.replaceChildren(...offView());
        return;
      }
      listing = loaded.data;
      box.replaceChildren(...listView(loaded.data));
      if (focusRow) {
        const key = `${focusRow}:open`;
        focusRow = null;
        [...box.querySelectorAll<HTMLElement>('[data-focus]')].find((el) => el.dataset.focus === key)?.focus();
      }
    });
    return box;
  }

  // ------------------------------------------------------------ one backup

  const fact = (label: string, ...value: (Node | string | null)[]) => h('div', { class: 'admin-fact' }, h('dt', null, label), h('dd', null, ...value));

  function detailBody(p: BackupPreview): Node[] {
    const now = Date.now();
    const at = p.createdAt ?? manifestTime(p.name);
    const until = listing?.backups.find((b) => b.name === p.name)?.protectedUntil;
    const running = listing !== null && (listing.restore.inProgress !== null || listing.restore.maintenance);
    return nodes(
      h('dl', { class: 'admin-facts' },
        fact('Created', at === null ? 'unknown' : `${formatUtc(at)} · ${relativeTime(at, now)}`),
        fact('App version', p.appVersion ?? 'unknown'),
        fact('Files', String(p.files)),
        fact('Boards', String(p.boards)),
        fact('Size', formatSize(p.bytes)),
        fact('Key', shortKey(p.keyId)),
        p.protected ? fact('Protected', typeof until === 'number' ? `Kept from pruning until ${formatUtc(until)}` : 'Kept from pruning') : null,
        fact('Disk space', `${formatSize(p.space.free)} free, ${formatSize(p.space.needed)} needed for a whole restore`,
          h('div', { class: 'muted small' }, p.space.enough ? 'Enough room.' : 'Not enough room.')),
        fact('Old data', `Kept ${p.keepOldFor} after a whole restore`, h('div', { class: 'muted small' }, p.reason))),
      running ? h('p', { class: 'backups-notice', role: 'status' }, 'A restore is running right now, so nothing can be restored until it is done.') : null,
      h('div', { class: 'btn-row backups-actions' },
        h('button', { class: 'btn primary', disabled: running, onclick: () => go({ type: 'copy' }) }, 'Restore a board as a copy'),
        h('button', { class: 'btn', disabled: running, onclick: () => go({ type: 'whole' }) }, 'Restore the whole workspace')),
      h('p', { class: 'muted small' }, 'A board copy adds one board to your workspace and changes nothing else. A whole restore replaces everything.'));
  }

  function detailScreen(manifest: string): HTMLElement {
    const body = h('div', null);
    const at = manifestTime(manifest);
    kit.loadList(body, () => api.adminBackup(manifest).catch(fail), (p) => body.replaceChildren(...detailBody(p)));
    return frame(at === null ? 'Backup' : formatUtc(at), 'All backups', body);
  }

  // ------------------------------------------------------------ one board, as a copy

  function boardScreen(manifest: string): HTMLElement {
    let boards: BackupBoard[] = [];
    let cut = false;
    let query = '';
    let picked: string | null = null;
    let busy = false;
    const body = h('div', null);
    const rows = h('div', { class: 'admin-box backups-pick', role: 'radiogroup', 'aria-label': 'Boards in this backup', style: '--cols: minmax(0, 1fr)' });
    const count = h('p', { class: 'muted small admin-count' });
    const chosen = h('p', { class: 'backups-chosen', id: 'backups-chosen' });
    const why = h('p', { class: 'muted small', id: 'backups-copy-why' });
    const make = h('button', { class: 'btn primary', 'aria-describedby': 'backups-copy-why' }, 'Make a copy');
    const done = h('div', { class: 'backups-result', role: 'status', 'aria-live': 'polite' });
    const problem = h('div', { class: 'backups-problem' });

    const shown = () => boards.filter((b) => matchesQuery(query, [b.title, b.teamName ?? 'Personal']));
    const pickedBoard = () => boards.find((b) => b.id === picked) ?? null;

    const sync = () => {
      const board = pickedBoard();
      chosen.textContent = board ? `Selected: ${board.title}` : 'Pick a board to copy.';
      const reason = readOnly
        ? 'This workspace is read-only, so a copy cannot be added right now. Check billing to make it writable again.'
        : !board
            ? 'Pick a board to enable the button.'
            : '';
      why.textContent = reason;
      // while the copy is being made the button is marked busy, not disabled, so keyboard focus stays on it
      make.disabled = readOnly || !board;
      if (busy) {
        make.setAttribute('aria-busy', 'true');
        make.setAttribute('aria-disabled', 'true');
      } else {
        make.removeAttribute('aria-busy');
        make.removeAttribute('aria-disabled');
      }
      for (const row of rows.children) row.classList.toggle('on', (row as HTMLElement).dataset.id === picked);
    };

    const paint = () => {
      const list = shown();
      count.textContent = query.trim() ? `${list.length} of ${boards.length}` : countLabel(boards.length, 'board', 'boards');
      if (!boards.length) {
        rows.replaceChildren(kit.emptyLine('No board of this backup can be restored. A board needs saved content in the backup.'));
      } else if (!list.length) {
        rows.replaceChildren(kit.emptyLine(`Nothing matches “${query.trim()}”.`));
      } else {
        rows.replaceChildren(...list.map((b) => h('label', { class: 'admin-row backups-pick-row', 'data-id': b.id },
          h('input', {
            type: 'radio', name: 'backup-board', value: b.id, checked: picked === b.id, 'aria-label': `${b.title}, ${b.teamName ?? 'Personal'}${b.deleted ? ', deleted' : ''}`,
            onchange: () => {
              picked = b.id;
              sync();
            },
          }),
          h('span', { class: 'backups-pick-text' },
            h('span', null, h('span', { class: 'admin-name' }, b.title), b.deleted ? [' ', badge('Deleted')] : null),
            h('span', { class: 'muted small' }, b.teamName ?? 'Personal')))));
      }
      sync();
    };

    const submit = async () => {
      const board = pickedBoard();
      if (!board || busy || readOnly) return;
      busy = true;
      done.replaceChildren();
      problem.replaceChildren();
      sync();
      try {
        done.replaceChildren(copyResult(await api.restoreBackupBoard(manifest, board.id)));
      } catch (e) {
        if (signedOut(e)) return;
        if (e instanceof ApiError && e.code === 'read_only') readOnly = true;
        problem.replaceChildren(errorBox(e));
      } finally {
        busy = false;
        sync();
      }
    };
    make.addEventListener('click', () => void submit());

    kit.loadList(body, () => api.adminBackupBoards(manifest).catch(fail), (data) => {
      boards = data.boards;
      cut = data.truncated;
      body.replaceChildren(...nodes(
        h('p', { class: 'backups-lead' }, 'Pick one board. It is added to your workspace as a new board named “Restored”, followed by its title and today’s date, and you own it. The board you have now, its history and everything else stay as they are. The copy starts without version history.'),
        h('div', { class: 'admin-toolbar' },
          h('div', { class: 'admin-search' }, icon('search'), h('input', {
            class: 'input', type: 'search', placeholder: 'Search boards', 'aria-label': 'Search the boards of this backup',
            oninput: (e: Event) => {
              query = (e.currentTarget as HTMLInputElement).value;
              paint();
            },
          })),
          count),
        rows,
        cut ? h('p', { class: 'muted small backups-more' }, 'Only the 500 boards edited most recently are listed.') : null,
        chosen,
        h('div', { class: 'btn-row backups-actions' }, make),
        why,
        done,
        problem));
      paint();
    });
    return frame('Restore a board as a copy', 'Back to the backup', body);
  }

  function copyResult(copy: BoardCopy): HTMLElement {
    return h('div', null,
      h('p', null, 'The copy is ready: ', h('a', { class: 'backups-link', href: `#/b/${copy.boardId}` }, copy.title), '.'),
      copy.fallback === 'personal' && copy.message ? h('p', { class: 'muted' }, copy.message) : null);
  }

  // ------------------------------------------------------------ the whole workspace

  function steps(p: BackupPreview): HTMLElement {
    const items: [string, string?][] = [
      ['Everybody is signed out and has to sign in again. Access tokens and invite links are revoked.'],
      ['The workspace is unavailable for about a minute while the server restarts.'],
      ['A safety backup of the current data is made first. If it fails, nothing changes.'],
      [`The current data is moved aside, not deleted. It is kept ${p.keepOldFor}.`, p.reason],
      ['Edits made after this backup was taken are not in it. They exist only in that old-data folder.'],
    ];
    return h('ol', { class: 'backups-steps' }, items.map(([text, note]) => h('li', null, h('span', null, text, note ? h('span', { class: 'muted small' }, note) : null))));
  }

  function confirmBody(manifest: string, p: BackupPreview): Node[] {
    let typed = '';
    let busy = false;
    const at = p.createdAt ?? manifestTime(p.name);
    const why = h('p', { class: 'muted small', id: 'backups-restore-why' });
    const problem = h('div', { class: 'backups-problem' });
    const go_ = h('button', { class: 'btn', 'aria-describedby': 'backups-restore-why' }, 'Restore this backup');
    const input = h('input', {
      class: 'input', id: 'backups-confirm', type: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
      'aria-describedby': 'backups-restore-why',
      oninput: (e: Event) => {
        typed = (e.currentTarget as HTMLInputElement).value;
        sync();
      },
    });
    const sync = () => {
      const gate = restoreGate(typed, p);
      go_.disabled = !gate.allowed;
      input.readOnly = busy;
      why.textContent = gate.reason;
      // marked busy, not disabled, so keyboard focus stays on the button when the restore is refused
      if (busy) {
        go_.setAttribute('aria-busy', 'true');
        go_.setAttribute('aria-disabled', 'true');
      } else {
        go_.removeAttribute('aria-busy');
        go_.removeAttribute('aria-disabled');
      }
    };
    go_.addEventListener('click', async () => {
      if (busy || !restoreGate(typed, p).allowed) return;
      busy = true;
      problem.replaceChildren();
      sync();
      try {
        await api.restoreBackup(manifest, typed);
        takeOver();
      } catch (e) {
        if (signedOut(e)) return;
        const outcome = e instanceof ApiError ? submitOutcome(e.status, e.code, e.facts.restarting === true) : 'error';
        if (outcome === 'watch') {
          takeOver();
          return;
        }
        problem.replaceChildren(errorBox(e));
        busy = false;
        sync();
      }
    });
    const body = nodes(
      h('p', { class: 'backups-lead' }, `You are about to replace everything in this workspace with the backup of ${at === null ? 'an unknown time' : formatUtc(at)}. People, teams, boards, rooms, history and settings all come from it.`),
      h('p', { class: 'admin-kicker' }, 'What will happen'),
      steps(p),
      h('div', { class: 'backups-confirm' },
        h('label', { class: 'backups-label', for: 'backups-confirm' }, `Type ${p.confirmWord || CONFIRM_WORD} to confirm`),
        input,
        h('div', { class: 'btn-row backups-actions' }, go_),
        why,
        problem));
    sync();
    return body;
  }

  function confirmScreen(manifest: string): HTMLElement {
    const body = h('div', null);
    kit.loadList(body, () => api.adminBackup(manifest).catch(fail), (p) => body.replaceChildren(...confirmBody(manifest, p)));
    return frame('Restore the whole workspace', 'Back to the backup', body);
  }

  /** The request went out (or may have): nothing here is safe to touch any more, so the restoring screen takes over. */
  function takeOver() {
    go({ type: 'restoring' });
    showRestoring();
  }

  // ------------------------------------------------------------ screens

  function render() {
    let view: HTMLElement;
    switch (screen.name) {
      case 'list':
        view = listScreen();
        break;
      case 'detail':
        view = detailScreen(screen.manifest);
        break;
      case 'board':
        view = boardScreen(screen.manifest);
        break;
      case 'confirm':
        view = confirmScreen(screen.manifest);
        break;
      case 'restoring':
        view = h('div', { class: 'backups-screen' }, h('p', { class: 'backups-notice', role: 'status' }, 'Restoring…'));
        break;
    }
    root.replaceChildren(view);
    if (screen.name !== 'list' && screen.name !== 'restoring') view.querySelector<HTMLElement>('[data-screen-focus]')?.focus();
  }

  render();
  return root;
}
