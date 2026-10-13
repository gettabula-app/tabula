// Unified per-person notification endpoints (docs/notifications.md). The switches (notification-prefs.mjs) are for signed-in
// accounts only: a guest session is limited to one board and has no notification list of its own.

import { NotificationPrefsInputError } from './notification-prefs.mjs';

export const NOTIFICATIONS_BODY_LIMIT = 8 * 1024;
const READ_IDS_MAX = 100;

/**
 * @param {{ notifications: any, digest?: { get: (userId: string) => unknown, set: (userId: string, patch: unknown) => unknown } | null, compile: Function, errors: any }} options
 */
export function createNotificationRoutes({ notifications, digest = null, compile, errors }) {
  const { badRequest, forbidden, invalidInput } = errors;
  const prefs = notifications.prefs;
  const accountOnly = (user) => {
    if (!user || user.guest === true || user.role === 'guest') throw forbidden('Notification settings are for signed-in accounts');
  };

  return [
    compile('GET', 'notifications', {}, ({ user, query }) => {
      const rawLimit = query.get('limit');
      if (rawLimit !== null && rawLimit !== '' && !/^\d{1,4}$/u.test(rawLimit)) throw badRequest('limit must be a whole number');
      const before = query.get('before');
      try {
        return [200, notifications.list({
          user,
          limit: rawLimit == null || rawLimit === '' ? 30 : Number(rawLimit),
          before: before || null,
          unreadOnly: query.get('unread') === '1',
        })];
      } catch (error) {
        if (error instanceof TypeError && /cursor/u.test(error.message)) throw badRequest('before must be a valid notification cursor');
        throw error;
      }
    }),

    compile('GET', 'notifications/unread', {}, ({ user }) => [200, notifications.unread(user)]),

    compile('POST', 'notifications/read', { body: true, maxBody: NOTIFICATIONS_BODY_LIMIT, readOnlyOk: true }, ({ user, body }) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Body must be an object');
      for (const key of Object.keys(body)) if (key !== 'ids' && key !== 'all') throw badRequest(`Unknown field: ${key.slice(0, 40)}`);
      const all = body.all === true;
      if (all) {
        if (body.ids !== undefined) throw badRequest('Provide ids or all, not both');
      } else if (body.all !== undefined || !Array.isArray(body.ids) || body.ids.length > READ_IDS_MAX
        || body.ids.some((id) => typeof id !== 'string' || !id || id.length > 128)) {
        throw badRequest(`ids must be an array of up to ${READ_IDS_MAX} notification ids, or set all to true`);
      }
      return [200, notifications.markRead({ user, ids: body.ids ?? [], all })];
    }),

    compile('GET', 'notifications/prefs', {}, ({ user }) => {
      accountOnly(user);
      return [200, { prefs: prefs.get(user.id) }];
    }),

    compile('PUT', 'notifications/prefs', { body: true, maxBody: NOTIFICATIONS_BODY_LIMIT, readOnlyOk: true }, ({ user, body }) => {
      accountOnly(user);
      try {
        return [200, { prefs: prefs.set(user.id, body) }];
      } catch (error) {
        if (error instanceof NotificationPrefsInputError) throw invalidInput(error.message);
        throw error;
      }
    }),

    // The email digest (docs/notifications.md, Digest): off until switched on, one mail a day at the chosen hour.
    // GET always answers: `digest: null` tells the dialog this instance sends no email, so it hides the section.
    compile('GET', 'notifications/digest', {}, ({ user }) => {
      accountOnly(user);
      return [200, { digest: digest ? digest.get(user.id) : null }];
    }),
    ...(digest ? [

      compile('PUT', 'notifications/digest', { body: true, maxBody: NOTIFICATIONS_BODY_LIMIT, readOnlyOk: true }, ({ user, body }) => {
        accountOnly(user);
        try {
          return [200, { digest: digest.set(user.id, body) }];
        } catch (error) {
          if (error instanceof NotificationPrefsInputError) throw invalidInput(error.message);
          throw error;
        }
      }),
    ] : []),
  ];
}
