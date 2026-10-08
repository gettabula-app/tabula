// HTTP routes of the AI settings and keys (docs/ai.md, "Endpoints"), registered by api.mjs in accounts mode, plus the one
// route open mode has. A key travels only in the body of the request that stores it. No response, log line or audit
// row ever carries it, and a provider error is mapped to a code before it gets this far.

import { FEATURES, aiEnabledFor, personalKeysFor, readAiSettings, validateAdminAi, validateKeyBody, writeAiSettings } from './settings.mjs';
import { AiError, describeError } from './errors.mjs';
import { createKeyRing } from './keys.mjs';
import { createProvider } from './providers.mjs';

const UNCONFIGURED = 'AI keys cannot be saved because the server has no TABULA_AI_SECRET. Set it (32 random bytes as base64) and restart.';

/** The answer of GET /api/ai/config in open mode: on only with the operator's key and TABULA_AI_OPEN=1. */
export function openAiConfig(config) {
  const on = config.ai.open !== null;
  return { enabled: on, features: [...FEATURES], keySource: on ? 'workspace' : null, model: config.ai.model, personalKeys: false, hasSecret: false };
}

/**
 * @param {object} deps
 * `compile`, `audit`, `requireAdmin`, `isAdmin` and `errors` come from api.mjs. `createProvider` is injectable for tests.
 */
export function createAiRoutes({ directory, config, compile, audit, requireAdmin, isAdmin, errors, createProvider: makeProvider = createProvider, log = console.error }) {
  const { HttpError, badRequest, forbidden, conflict } = errors;
  const ring = createKeyRing({ secret: config.ai.secret, previous: config.ai.previous });
  const settingsNow = () => readAiSettings(directory, config);

  /** The HttpError to throw for anything that went wrong while talking to the provider. */
  function failure(res, err) {
    if (err instanceof AiError) {
      if (err.retryAfter) res.setHeader('retry-after', String(err.retryAfter));
      return new HttpError(err.status, err.code, err.message);
    }
    log('ai: unexpected error:', describeError(err));
    return new HttpError(500, 'internal', 'Something went wrong');
  }

  async function verifyKey(res, { provider, apiKey }) {
    try {
      await makeProvider({ kind: provider, apiKey }).verify();
    } catch (err) {
      throw failure(res, err);
    }
  }

  const keyView = (info) => (info ? { provider: info.provider, hint: info.hint, createdAt: info.createdAt, lastUsedAt: info.lastUsedAt } : null);

  function adminView() {
    const info = directory.getAiKeyInfo('workspace');
    return {
      ...settingsNow(),
      hasSecret: ring.configured,
      key: info ? { ...keyView(info), readable: ring.configured && directory.aiKeyReadable({ ring, scope: 'workspace' }) } : null,
    };
  }

  // The caller is judged again after a provider call, which can take seconds.
  const stillThere = (user) => {
    const fresh = directory.getUser(user.id);
    if (!fresh || fresh.disabled) throw forbidden();
    return fresh;
  };

  const routes = [
    compile('GET', 'ai/config', {}, ({ user }) => {
      const settings = settingsNow();
      const personal = personalKeysFor(settings, user);
      const mine = personal ? directory.getAiKeyInfo('user', user.id) : null;
      const keySource = !ring.configured ? null : mine ? 'user' : directory.getAiKeyInfo('workspace') ? 'workspace' : null;
      return [
        200,
        {
          enabled: aiEnabledFor(settings, user),
          features: settings.features,
          keySource,
          model: settings.model,
          personalKeys: personal,
          hasSecret: ring.configured,
          myKey: keyView(mine),
        },
      ];
    }),

    compile('PUT', 'ai/keys/me', { body: true }, async ({ res, user, body }) => {
      if (!personalKeysFor(settingsNow(), user)) throw forbidden('Personal AI keys are not allowed in this workspace');
      const checked = validateKeyBody(body);
      if (checked.error) throw badRequest(checked.error);
      if (!ring.configured) throw conflict('ai_unconfigured', UNCONFIGURED);
      const { apiKey, provider } = checked.key;
      await verifyKey(res, checked.key);
      const fresh = stillThere(user);
      if (!personalKeysFor(settingsNow(), fresh)) throw forbidden('Personal AI keys are not allowed in this workspace');
      const saved = directory.transaction(() => {
        const result = directory.saveAiKey({ ring, scope: 'user', userId: user.id, provider, apiKey, createdBy: user.id });
        audit(user, 'ai.key.set', { scope: 'user', provider });
        return result;
      });
      return [200, saved];
    }),

    // Open while the workspace is read-only, and when personal keys were switched off: a person can always take their key back.
    compile('DELETE', 'ai/keys/me', { readOnlyOk: true }, ({ user }) => {
      directory.transaction(() => {
        if (directory.deleteAiKey('user', user.id)) audit(user, 'ai.key.delete', { scope: 'user' });
      });
      return [204];
    }),

    compile('GET', 'admin/ai', {}, ({ user }) => {
      requireAdmin(user);
      return [200, adminView()];
    }),

    compile('PUT', 'admin/ai', { body: true }, async ({ res, user, body }) => {
      requireAdmin(user);
      const checked = validateAdminAi(body);
      if (checked.error) throw badRequest(checked.error);
      const { patch, key } = checked;
      if (key && !ring.configured) throw conflict('ai_unconfigured', UNCONFIGURED);
      // Nothing is written unless the key checks out, so a bad key leaves the settings as they were.
      if (key) await verifyKey(res, key);
      if (!isAdmin(stillThere(user))) throw forbidden('Only workspace admins can do that');
      directory.transaction(() => {
        if (Object.keys(patch).length) {
          writeAiSettings(directory, patch);
          audit(user, 'ai.settings', patch);
        }
        if (key) {
          directory.saveAiKey({ ring, scope: 'workspace', provider: key.provider, apiKey: key.apiKey, createdBy: user.id });
          audit(user, 'ai.key.set', { scope: 'workspace', provider: key.provider });
        }
      });
      return [200, adminView()];
    }),

    compile('DELETE', 'admin/ai/key', { readOnlyOk: true }, ({ user }) => {
      requireAdmin(user);
      directory.transaction(() => {
        if (directory.deleteAiKey('workspace')) audit(user, 'ai.key.delete', { scope: 'workspace' });
      });
      return [204];
    }),
  ];

  /** The field GET /api/me adds when this person may bring their own key, so the account menu can offer it. */
  const meFlag = (user) => (personalKeysFor(settingsNow(), user) ? { ai: { personalKeys: true } } : {});

  return { routes, meFlag };
}
