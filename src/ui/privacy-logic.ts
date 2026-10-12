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
  hostedIntro: 'Hosted workspaces send product analytics by default. The owner can turn it off. Operating data and error reports stay on either way.',
  selfIntro: 'Off by default. When on, this instance sends the items below to Tabula once an hour, and nowhere else.',
  ownerOnly: 'Only the owner can change this setting.',
  envLocked: 'This setting is locked by the operator environment setting TABULA_TELEMETRY.',
  enabled: 'On',
  disabled: 'Off',
  analyticsText: 'Sends counts and durations of feature use for this workspace to Tabula so we can see what is used and improve it. Never includes anything from your boards, comments or chat, and no names, email addresses or identifiers of people.',
  hourlyNote: 'Nothing has been sent yet: sending starts in a later version. Turning this off stops collection at once, and data that was already sent can be deleted on request.',
  categories: {
    feature_counts: 'Feature-use counts and durations: boards opened, polls run, timers, AI runs, and chat message counts. Counts of device types (phone, tablet, computer), browser families and operating systems, never the browser string itself. The raw User-Agent and browser strings are read on this instance and discarded.',
    performance: 'Request counts and durations by route template, current and hourly peak connection totals, and process resource use.',
    error_codes: 'Error reports are not collected yet. When they are added they will stay on and contain only an error code and the software version, never anything from your boards.',
    'backup state': 'Backup and restore run counts, durations, bytes, and approved error-code labels.',
    workspace_scale: 'sizes only: how many boards, members and items this workspace holds, never their content',
  },
  stayOnHeading: 'Stays on either way',
  operationalLead: 'We need these to run, back up and fix your workspace.',
  selfAlsoHeading: 'Also sent when this is on',
  selfAlsoLead: 'Operating data and error reports.',
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
  confirmSelfOnText: 'This instance will send the items listed on this page to Tabula once an hour. You can turn it off at any time.',
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

export function privacySwitchLabel(mode: 'hosted' | 'self'): string {
  return mode === 'hosted' ? PRIVACY_COPY.switchLabel : PRIVACY_COPY.selfSwitchLabel;
}

export function privacyStayOnHeading(mode: 'hosted' | 'self'): string {
  return mode === 'hosted' ? PRIVACY_COPY.stayOnHeading : PRIVACY_COPY.selfAlsoHeading;
}

export function privacyStayOnLead(mode: 'hosted' | 'self'): string {
  return mode === 'hosted' ? PRIVACY_COPY.operationalLead : PRIVACY_COPY.selfAlsoLead;
}

export function privacySharingState(enabled: boolean): string {
  return enabled ? PRIVACY_COPY.enabled : PRIVACY_COPY.disabled;
}

export function privacyCategoryText(category: string): string {
  return PRIVACY_COPY.categories[category as keyof typeof PRIVACY_COPY.categories] ?? category;
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
