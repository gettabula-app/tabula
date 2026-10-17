import type { UserRole } from '../api';

/** Copy used by the Privacy panel lives here so the disclosure stays reviewable in one place. */
export const PRIVACY_COPY = {
  tabLabel: 'Privacy',
  auditFilterLabel: 'Privacy',
  loading: 'Loading privacy settings…',
  loadFailed: 'Privacy settings could not be loaded. Check your connection and try again.',
  saveFailed: 'Could not save the privacy setting. Try again.',
  saved: 'Saved.',
  previewFailed: 'The report preview could not be loaded. Try again.',
  retry: 'Retry',
  switchLabel: 'Product analytics',
  selfSwitchLabel: 'Send telemetry to Tabula',
  hostedIntro: 'Product analytics is on by default for hosted workspaces. The owner can turn it off. Operating data stays on either way.',
  selfIntro: 'Off by default. When on, this server prepares operating data for Tabula once an hour: how the software runs, never how it is used. Nothing else. Sending starts in a later version.',
  ownerOnly: 'Only the owner can change this setting.',
  envLocked: 'This setting is locked by the operator environment setting TABULA_TELEMETRY.',
  enabled: 'On',
  disabled: 'Off',
  analyticsText: 'Sends counts and durations of feature use for this workspace to Tabula, which keeps them in PostHog (EU) for 12 months, so we can see what is used and improve it. Never includes anything from your boards, comments or chat, and no names, email addresses or identifiers of people.',
  analyticsNoticeTitle: 'Product analytics',
  analyticsNoticeText: 'Tabula now collects product analytics for hosted workspaces: counts of how features are used, per workspace, with no names and nothing from your boards. You can turn it off under Admin → Privacy.',
  analyticsNoticeReview: 'Review',
  analyticsNoticeDismiss: 'OK',
  hourlyNote: 'Nothing has been sent yet: sending starts in a later version. Turning this off stops it at once.',
  // Hosted workspaces send the report to Tabula once an hour (CGO-approved wording); a server you run still sends nothing yet.
  hourlyNoteHosted: 'Once an hour, the report shown below goes to Tabula. Turning this off stops product analytics at once, and the report of the current hour does not go. Operating data stays on either way. Usage counts are kept for 12 months and hourly operating figures for 13 months, then deleted.',
  workspaceIdInvalid: "This workspace's id is not valid for telemetry, so no report can be built. Ask whoever runs this server to check TABULA_CLOUD_WORKSPACE_ID.",
  noSentHosted: 'This is the report for the current hour. When the hour ends, it goes to Tabula as shown here.',
  previewButtonHosted: "Show this hour's report",
  categories: {
    feature_counts: 'Feature-use counts and durations: boards opened, polls run, timers, AI runs, and chat message counts. Counts of device types (phone, tablet, computer), browser families and operating systems, never the browser string itself. The raw User-Agent and browser strings are read on this instance and discarded.',
    performance: 'Request counts and durations by route template, current and hourly peak connection totals, and process resource use.',
    error_codes: 'Error reports (with an error code and the version; not collected yet)',
    'backup state': 'Backup and restore run counts, durations, bytes, and the outcome code of each run, never a message or a path.',
    workspace_scale: 'Sizes only: how many boards and members this workspace holds, never their content.',
  },
  coversHeading: 'What this switch covers',
  selfCoversHeading: 'Sent when this is on',
  stayOnHeading: 'Stays on either way',
  operationalLead: 'We need these to run, back up and fix your workspace.',
  neverHeading: 'What is never sent',
  neverSent: [
    'Anything you write or upload: board, card and ticket titles and text, comments, chat, file names and contents, search text, AI prompts and answers.',
    'Anything that identifies a person: names, email addresses, user ids, session ids, tokens, IP addresses, browser strings, cookies.',
    'Addresses of your content: board and ticket ids and keys, room ids, URLs and URL paths.',
    'Error text: messages, SQL, stack traces from outside Tabula code, request and response bodies, headers, environment variables.',
    'Server environment: anything from your own network or machine beyond the runtime version and operating-system family.',
  ],
  lastBuilt: 'Last report prepared',
  lastChangedBy: 'Last changed by',
  neverBuilt: 'None yet',
  previewButton: 'Show what would be sent',
  hidePreviewButton: 'Hide report preview',
  previewBuilt: 'Report time',
  previewAriaLabel: 'Telemetry report preview',
  noSent: 'Nothing has been sent yet.',
  copy: 'Copy',
  copied: 'Report copied to the clipboard.',
  copyUnavailable: 'Clipboard is not available here.',
  previewLoading: 'Loading the report preview…',
  catalogue: 'Read the telemetry data catalogue',
  catalogueHref: '/docs/telemetry',
  confirmSelfOnTitle: 'Send telemetry to Tabula?',
  confirmSelfOnText: 'This server will prepare the operating data listed on this page once an hour, and nothing else. Nothing is sent yet; sending starts in a later version. You can turn it off at any time.',
  cancel: 'Cancel',
  turnOn: 'Turn on',
} as const;

export interface PrivacyEditState {
  disabled: boolean;
  reasons: string[];
}

/** Only owners can change the setting; an operator environment lock applies to every role. */
export function privacyEditState(role: UserRole, locked: 'env' | null): PrivacyEditState {
  const reasons: string[] = [];
  if (role !== 'owner') reasons.push(PRIVACY_COPY.ownerOnly);
  if (locked === 'env') reasons.push(PRIVACY_COPY.envLocked);
  return { disabled: reasons.length > 0, reasons };
}

export function privacyModeIntro(mode: 'hosted' | 'self'): string {
  return mode === 'hosted' ? PRIVACY_COPY.hostedIntro : PRIVACY_COPY.selfIntro;
}

/** The note under the switch: hosted workspaces say what they send to Tabula; a server you run says nothing is sent yet. */
export function privacyHourlyNote(mode: 'hosted' | 'self'): string {
  return mode === 'hosted' ? PRIVACY_COPY.hourlyNoteHosted : PRIVACY_COPY.hourlyNote;
}

export function privacyNoReport(mode: 'hosted' | 'self'): string {
  return mode === 'hosted' ? PRIVACY_COPY.noSentHosted : PRIVACY_COPY.noSent;
}

export function privacyPreviewButton(mode: 'hosted' | 'self'): string {
  return mode === 'hosted' ? PRIVACY_COPY.previewButtonHosted : PRIVACY_COPY.previewButton;
}

export function privacySwitchLabel(mode: 'hosted' | 'self'): string {
  return mode === 'hosted' ? PRIVACY_COPY.switchLabel : PRIVACY_COPY.selfSwitchLabel;
}

export function privacyStayOnHeading(): string {
  return PRIVACY_COPY.stayOnHeading;
}

export function privacyStayOnLead(): string {
  return PRIVACY_COPY.operationalLead;
}

export function privacySharingState(enabled: boolean): string {
  return enabled ? PRIVACY_COPY.enabled : PRIVACY_COPY.disabled;
}

/** The reviewed sentence for a category key, or null for a key this build has no copy for (it is left out, never shown raw). */
export function privacyCategoryText(category: string): string | null {
  return Object.hasOwn(PRIVACY_COPY.categories, category) ? PRIVACY_COPY.categories[category as keyof typeof PRIVACY_COPY.categories] : null;
}

export function privacyCoversHeading(mode: 'hosted' | 'self'): string {
  return mode === 'hosted' ? PRIVACY_COPY.coversHeading : PRIVACY_COPY.selfCoversHeading;
}

export function privacyTimestamp(value: number): { iso: string; label: string } | null {
  const date = new Date(value);
  if (!Number.isFinite(value) || Number.isNaN(date.getTime())) return null;
  return {
    iso: date.toISOString(),
    label: date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
  };
}

export function privacyLastChangedBy(value: { name: string; at: number } | null | undefined): string | null {
  if (!value || typeof value.name !== 'string' || !value.name.trim()) return null;
  const timestamp = privacyTimestamp(value.at);
  return timestamp ? `${PRIVACY_COPY.lastChangedBy} ${value.name.trim()}, ${timestamp.label}` : null;
}
