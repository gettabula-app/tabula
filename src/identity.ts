import type { User } from './types';

/**
 * Whether `id` (a createdBy) is this person's. In accounts mode objects made before the account id was stamped carry the
 * device id the browser picked, so that still counts as theirs on this device; nobody else can send it as an author.
 */
export type Who = string | Pick<User, 'id' | 'deviceId'>;

export const isOwnAuthor = (who: Who, id: string | undefined): boolean => {
  const user = typeof who === 'string' ? { id: who, deviceId: undefined } : who;
  return id !== undefined && id !== '' && (id === user.id || id === user.deviceId);
};
