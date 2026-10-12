import { describe, expect, it } from 'vitest';
import { PRIVACY_COPY, privacyCategoryText, privacyEditState, privacyLastChangedBy, privacyModeIntro, privacySharingState, privacySwitchLabel, privacyStayOnHeading, privacyStayOnLead, privacyTimestamp } from '../src/ui/privacy-logic';

describe('Privacy panel copy and rules', () => {
  it('uses the required switch label and describes the hosted and self-hosted defaults', () => {
    expect(privacySwitchLabel('hosted')).toBe('Product analytics');
    expect(privacySwitchLabel('self')).toBe('Send telemetry to Tabula');
    expect(privacyModeIntro('hosted')).toBe('Hosted workspaces send product analytics by default. The owner can turn it off. Operating data and error reports stay on either way.');
    expect(privacyModeIntro('self')).toBe('Off by default. When on, this instance sends the items below to Tabula once an hour, and nowhere else.');
    expect(privacyStayOnHeading('hosted')).toBe('Stays on either way');
    expect(privacyStayOnLead('hosted')).toBe('We need these to run, back up and fix your workspace.');
    expect(privacyStayOnHeading('self')).toBe('Also sent when this is on');
    expect(privacyStayOnLead('self')).toBe('Operating data and error reports.');
    expect(PRIVACY_COPY.analyticsText).toBe('Sends counts and durations of feature use for this workspace to Tabula so we can see what is used and improve it. Never includes anything from your boards, comments or chat, and no names, email addresses or identifiers of people.');
    expect(privacySharingState(true)).toBe('On');
    expect(privacySharingState(false)).toBe('Off');
    expect(PRIVACY_COPY.saved).toBe('Saved.');
    expect(PRIVACY_COPY.hourlyNote).toBe('Nothing has been sent yet: sending starts in a later version. Turning this off stops collection at once, and data that was already sent can be deleted on request.');
    expect(PRIVACY_COPY.lastBuilt).toBe('Last report prepared');
    expect(PRIVACY_COPY.operationalLead).toBe('We need these to run, back up and fix your workspace.');
  });

  it('only lets owners change an unlocked setting', () => {
    expect(privacyEditState('owner', null)).toEqual({ disabled: false, reasons: [] });
    expect(privacyEditState('admin', null)).toEqual({ disabled: true, reasons: [PRIVACY_COPY.ownerOnly] });
    expect(privacyEditState('owner', 'env')).toEqual({ disabled: true, reasons: [PRIVACY_COPY.envLocked] });
    expect(privacyEditState('admin', 'env')).toEqual({ disabled: true, reasons: [PRIVACY_COPY.ownerOnly, PRIVACY_COPY.envLocked] });
  });

  it('renders category keys through the reviewed plain-language copy', () => {
    expect(privacyCategoryText('feature_counts')).toBe(PRIVACY_COPY.categories.feature_counts);
    expect(privacyCategoryText('workspace_scale')).toBe('sizes only: how many boards, members and items this workspace holds, never their content');
    expect(privacyCategoryText('error_codes')).toBe('Error reports are not collected yet. When they are added they will stay on and contain only an error code and the software version, never anything from your boards.');
    expect(privacyCategoryText('backup state')).toContain('approved error-code labels');
    expect(privacyCategoryText('performance')).toContain('current and hourly peak connection totals');
    expect(PRIVACY_COPY.categories.feature_counts).toContain('Counts of device types (phone, tablet, computer), browser families and operating systems, never the browser string itself.');
    expect(PRIVACY_COPY.categories.feature_counts).toContain('The raw User-Agent and browser strings are read on this instance and discarded.');
    expect(privacyCategoryText('unknown')).toBe('unknown');
  });

  it('keeps the never-sent catalogue and later-send explanation in the reviewed copy module', () => {
    expect(PRIVACY_COPY.neverSent).toHaveLength(5);
    expect(PRIVACY_COPY.neverSent).toEqual([
      'Anything you write or upload: board, card and ticket titles and text, comments, chat, file names and contents, search text, AI prompts and answers.',
      'Anything that identifies a person: names, email addresses, user ids, session ids, tokens, IP addresses, browser strings, cookies.',
      'Addresses of your content: board and ticket ids and keys, room ids, URLs and URL paths.',
      'Error text: messages, SQL, stack traces from outside Tabula code, request and response bodies, headers, environment variables.',
      'Server environment: anything from your own network or machine beyond the runtime version and operating-system family.',
    ]);
    expect(PRIVACY_COPY.neverHeading).toBe('What is never sent');
    expect(PRIVACY_COPY.noSent).toBe('Nothing has been sent yet.');
    expect(PRIVACY_COPY.previewButton).toBe('Show what would be sent');
    expect(PRIVACY_COPY.confirmSelfOnTitle).toBe('Send telemetry to Tabula?');
    expect(PRIVACY_COPY.confirmSelfOnText).toBe('This instance will send the items listed on this page to Tabula once an hour. You can turn it off at any time.');
    expect(PRIVACY_COPY.cancel).toBe('Cancel');
    expect(PRIVACY_COPY.turnOn).toBe('Turn on');
  });

  it('formats only valid report timestamps', () => {
    expect(privacyTimestamp(Date.UTC(2026, 9, 12, 9, 0))?.iso).toBe('2026-10-12T09:00:00.000Z');
    expect(privacyTimestamp(Number.NaN)).toBeNull();
  });

  it('formats the audit actor and timestamp when present', () => {
    expect(privacyLastChangedBy({ name: 'Owner', at: Date.UTC(2026, 9, 12, 9, 0) })).toContain('Last changed by Owner, ');
    expect(privacyLastChangedBy(null)).toBeNull();
    expect(privacyLastChangedBy({ name: ' ', at: Date.UTC(2026, 9, 12, 9, 0) })).toBeNull();
  });
});
