import type { AuthState } from './auth';
import { getUser } from './sync';

/**
 * The user as the board shows them. In accounts mode the id is the account's: the relay stamps and checks authorship with it
 * (createdBy, comment authors, awareness), so an object made under the device id would read as forged. Open mode keeps the device id.
 */
export function boardUser(auth: AuthState) {
  if (auth.mode === 'guest') return { ...getUser(), id: auth.guest.guestId, name: auth.guest.name, guest: true };
  const me = auth.mode === 'signed-in' || auth.mode === 'offline' ? auth.me : null;
  return me ? { ...getUser(), id: me.user.id, name: me.user.name, deviceId: getUser().id } : getUser();
}

/**
 * What a profile edit saves as this device's identity: the device's own id with the new name and colour. The board's user
 * (app.user) carries the account id in accounts mode and must never be saved as the device identity, or the next account
 * on this device would inherit it.
 */
export const deviceIdentity = (edit: { name: string; color: string }) => ({ ...getUser(), name: edit.name, color: edit.color });
