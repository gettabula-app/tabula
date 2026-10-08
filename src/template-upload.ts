// After signing in, the templates saved in this browser before can be uploaded to the account, once, and only when the
// person says so. This is the logic; src/ui/template-upload.ts is the question and the dialog.

import type { AuthState } from './auth';
import type { CustomTemplate } from './custom-templates';
import { newId } from './store';
import { withoutSharing } from './template-file';
import type { TemplateStore } from './template-store';
import { CATEGORIES, CUSTOM_CATEGORY } from './templates';

/** Set (to "1") once the offer was shown in this browser, whatever the answer was. */
export const UPLOAD_OFFER_KEY = 'driftboard:templates-upload-offered';

export interface UploadResult {
  uploaded: number;
  failed: { name: string; message: string }[];
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

const browserStorage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** Whether the offer was already shown here. Where storage is blocked it counts as shown: it cannot be remembered, so it is not made. */
export function offerWasShown(storage: Storage | null = browserStorage()): boolean {
  try {
    return storage === null || storage.getItem(UPLOAD_OFFER_KEY) !== null;
  } catch {
    return true;
  }
}

export function markOfferShown(storage: Storage | null = browserStorage()): void {
  try {
    storage?.setItem(UPLOAD_OFFER_KEY, '1');
  } catch {
    /* storage is unavailable: the offer is not made again in this session either way */
  }
}

/** Whether to ask: signed in to a workspace, not asked in this browser before, and templates saved here. */
export function shouldOfferUpload(mode: AuthState['mode'], alreadyShown: boolean, saved: number): boolean {
  return mode === 'signed-in' && !alreadyShown && saved > 0;
}

/** The template as a personal one for upload: a new id, nobody to share with, and a category the server knows. */
export function forUpload(t: CustomTemplate): CustomTemplate {
  const known = [...CATEGORIES, CUSTOM_CATEGORY].includes(t.category as typeof CUSTOM_CATEGORY);
  return { ...withoutSharing(t), id: newId(), category: known ? t.category : CUSTOM_CATEGORY, scope: 'personal', teamId: null };
}

/**
 * Uploads the browser's templates as personal templates, oldest first. The copies in the browser stay where they are.
 * A template the server refuses is reported and does not stop the others.
 */
export async function uploadBrowserTemplates(
  from: Pick<TemplateStore, 'list'>,
  to: Pick<TemplateStore, 'put'>,
  onProgress: (done: number, total: number) => void = () => undefined,
): Promise<UploadResult> {
  const list = [...(await from.list())].sort((a, b) => a.createdAt - b.createdAt);
  const result: UploadResult = { uploaded: 0, failed: [] };
  for (const [i, t] of list.entries()) {
    try {
      await to.put(forUpload(t));
      result.uploaded++;
    } catch (e) {
      result.failed.push({ name: t.name, message: (e as Error).message });
    }
    onProgress(i + 1, list.length);
  }
  return result;
}
