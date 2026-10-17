import { describe, expect, it } from 'vitest';
import { PRIVACY_COPY, privacyCategoryText, privacyEditState, privacyLastChangedBy, privacyModeIntro, privacySharingState, privacySwitchLabel, privacyStayOnHeading, privacyStayOnLead, privacyTimestamp, privacyHourlyNote, privacyNoReport, privacyPreviewButton } from '../src/ui/privacy-logic';

describe('Privacy panel copy and rules', () => {
  it('uses the required switch label and describes the hosted and self-hosted defaults', () => {
    expect(privacySwitchLabel('hosted')).toBe('Product analytics');
    expect(privacySwitchLabel('self')).toBe('Send telemetry to Tabula');
    expect(privacyModeIntro('hosted')).toBe('Product analytics is on by default for hosted workspaces. The owner can turn it off. Operating data stays on either way.');
    expect(privacyModeIntro('self')).toBe('Off by default. When on, this server prepares operating data for Tabula once an hour: how the software runs, never how it is used. Nothing else. Sending starts in a later version.');
    expect(privacyStayOnHeading()).toBe('Stays on either way');
    expect(privacyStayOnLead()).toBe('We need these to run, back up and fix your workspace.');
    expect(PRIVACY_COPY.analyticsText).toBe('Sends counts and durations of feature use for this workspace to Tabula, which keeps them in PostHog (EU) for 12 months, so we can see what is used and improve it. Never includes anything from your boards, comments or chat, and no names, email addresses or identifiers of people.');
    expect(privacySharingState(true)).toBe('On');
    expect(privacySharingState(false)).toBe('Off');
    expect(PRIVACY_COPY.saved).toBe('Saved.');
    expect(PRIVACY_COPY.hourlyNote).toBe('Nothing has been sent yet: sending starts in a later version. Turning this off stops it at once.');
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
    expect(privacyCategoryText('workspace_scale')).toBe('Sizes only: how many boards and members this workspace holds, never their content.');
    expect(privacyCategoryText('error_codes')).toBe('Error reports (with an error code and the version; not collected yet)');
    expect(privacyCategoryText('backup state')).toBe('Backup and restore run counts, durations, bytes, and the outcome code of each run, never a message or a path.');
    expect(privacyCategoryText('performance')).toContain('current and hourly peak connection totals');
    expect(PRIVACY_COPY.categories.feature_counts).toContain('Counts of device types (phone, tablet, computer), browser families and operating systems, never the browser string itself.');
    expect(PRIVACY_COPY.categories.feature_counts).toContain('The raw User-Agent and browser strings are read on this instance and discarded.');
    // a key this build has no sentence for is not shown
    expect(privacyCategoryText('unknown')).toBeNull();
    expect(privacyCategoryText('device_class')).toBeNull();
    expect(privacyCategoryText('constructor')).toBeNull();
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
    // hosted workspaces send the hourly report to Tabula (CGO-approved wording); a server you run sends nothing yet
    expect(PRIVACY_COPY.hourlyNoteHosted).toBe('Once an hour, the report shown below goes to Tabula. Turning this off stops product analytics at once, and the report for the hour in progress is not sent. Operating data stays on either way. Usage counts are kept for 12 months and hourly operating figures for 13 months, then deleted.');
    expect(PRIVACY_COPY.noSentHosted).toBe('This is the report for the current hour. When the hour ends, it goes to Tabula as shown here.');
    expect(PRIVACY_COPY.previewButtonHosted).toBe("Show this hour's report");
    expect([privacyHourlyNote('hosted'), privacyHourlyNote('self')]).toEqual([PRIVACY_COPY.hourlyNoteHosted, PRIVACY_COPY.hourlyNote]);
    expect([privacyNoReport('hosted'), privacyNoReport('self')]).toEqual([PRIVACY_COPY.noSentHosted, PRIVACY_COPY.noSent]);
    expect([privacyPreviewButton('hosted'), privacyPreviewButton('self')]).toEqual(["Show this hour's report", 'Show what would be sent']);
    expect(PRIVACY_COPY.confirmSelfOnTitle).toBe('Send telemetry to Tabula?');
    expect(PRIVACY_COPY.confirmSelfOnText).toBe('This server will prepare the operating data listed on this page once an hour, and nothing else. Nothing is sent yet; sending starts in a later version. You can turn it off at any time.');
    expect(PRIVACY_COPY.cancel).toBe('Cancel');
    expect(PRIVACY_COPY.turnOn).toBe('Turn on');
  });

  it('keeps the product analytics notice copy in the reviewed module', () => {
    expect(PRIVACY_COPY.analyticsNoticeTitle).toBe('Product analytics');
    expect(PRIVACY_COPY.analyticsNoticeText).toBe('Tabula now collects product analytics for hosted workspaces: counts of how features are used, per workspace, with no names and nothing from your boards. You can turn it off under Admin → Privacy.');
    expect(PRIVACY_COPY.analyticsNoticeReview).toBe('Review');
    expect(PRIVACY_COPY.analyticsNoticeDismiss).toBe('OK');
  });

  it('has no self-hosted also-sent copy and never says data is deleted on request', () => {
    expect(PRIVACY_COPY).not.toHaveProperty('selfAlsoHeading');
    expect(PRIVACY_COPY).not.toHaveProperty('selfAlsoLead');
    const strings = (value: unknown): string[] => {
      if (typeof value === 'string') return [value];
      if (value !== null && typeof value === 'object') return Object.values(value).flatMap(strings);
      return [];
    };
    expect(strings(PRIVACY_COPY).filter((text) => text.includes('deleted on request'))).toEqual([]);
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
