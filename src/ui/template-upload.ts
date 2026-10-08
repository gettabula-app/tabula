import { h } from './dom';
import { dialog, toast } from './common';
import { authState } from '../auth';
import { browserTemplates, templateStoreFor } from '../template-store';
import { markOfferShown, offerWasShown, shouldOfferUpload, uploadBrowserTemplates } from '../template-upload';

let asking = false;

const count = (n: number) => `${n} ${n === 1 ? 'template' : 'templates'}`;

/**
 * Once per browser, after signing in: offers to upload the templates saved in this browser to the account as personal
 * templates. Nothing is uploaded until the person clicks Upload; the offer is not made again whatever they answer.
 */
export async function offerTemplateUpload(): Promise<void> {
  if (asking || !shouldOfferUpload(authState().mode, offerWasShown(), 1)) return;
  asking = true;
  try {
    const saved = await browserTemplates().list();
    // Somebody who signed out meanwhile is not asked
    if (!shouldOfferUpload(authState().mode, offerWasShown(), saved.length)) return;
    markOfferShown();
    const n = saved.length;
    dialog('Upload your templates?', h('div', { class: 'stack' },
      h('p', null, `You saved ${count(n)} in this browser before you signed in. Upload ${n === 1 ? 'it' : 'them'} to your account?`),
      h('p', { class: 'muted small' }, 'They become personal templates that only you can see, and you can share them later. The copies in this browser stay where they are.'),
    ), [
      { label: 'Not now' },
      {
        label: n === 1 ? 'Upload template' : `Upload ${n} templates`, primary: true,
        onClick: async () => {
          const result = await uploadBrowserTemplates(browserTemplates(), templateStoreFor('signed-in'));
          if (!result.failed.length) toast(`Uploaded ${count(result.uploaded)} to your account.`);
          else toast(`Uploaded ${result.uploaded} of ${n}. “${result.failed[0].name}”: ${result.failed[0].message}`, 8000);
        },
      },
    ]);
  } finally {
    asking = false;
  }
}
