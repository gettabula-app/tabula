// HTTP routes of the AI settings and keys (docs/ai.md, "Endpoints"), registered by api.mjs in accounts mode, plus the one
// route open mode has. A key travels only in the body of the request that stores it. No response, log line or audit
// row ever carries it, and a provider error is mapped to a code before it gets this far.

import { FEATURES, aiEnabledFor, personalKeysFor, readAiSettings, validateAdminAi, validateKeyBody, writeAiSettings } from './settings.mjs';
import { AiError, describeError } from './errors.mjs';
import { hostOf } from './base-url.mjs';
import { createKeyRing } from './keys.mjs';
import { createSaveThrottle } from './limits.mjs';
import { createProvider } from './providers.mjs';
import { createRunRoutes } from './run.mjs';

const UNCONFIGURED = 'AI keys cannot be saved because the server has no TABULA_AI_SECRET. Set it (32 random bytes as base64) and restart.';

/** The answer of GET /api/ai/config in open mode: on only with the operator's key and TABULA_AI_OPEN=1. */
export function openAiConfig(config) {
  const on = config.ai.open !== null;
  return { enabled: on, features: [...FEATURES], keySource: on ? 'workspace' : null, provider: on ? config.ai.provider : null, model: config.ai.model, personalKeys: false, hasSecret: false };
}

/**
 * @param {object} deps
 * `compile`, `audit`, `requireAdmin`, `isAdmin`, `errors` and `cloud` come from api.mjs; `canWriteRoom` and `readRoom` from the
 * relay (the rule and the room reader it shares with MCP). `createProvider`, `now` and `timeoutMs` are injectable for tests.
 */
export function createAiRoutes({
  directory, config, compile, audit, requireAdmin, isAdmin, errors, cloud = null,
  canWriteRoom = () => false, readRoom = () => { throw new Error('This server has no room access'); },
  createProvider: makeProvider = createProvider, live = null, log = console.error, now = Date.now, timeoutMs,
}) {
  const { HttpError, badRequest, forbidden, notFound, conflict } = errors;
  const ring = createKeyRing({ secret: config.ai.secret, previous: config.ai.previous });
  const settingsNow = () => readAiSettings(directory, config);
  const saves = createSaveThrottle({ now });

  /** The HttpError to throw for anything that went wrong while talking to the provider. */
  function failure(res, err) {
    if (err instanceof AiError) {
      if (err.retryAfter) res.setHeader('retry-after', String(err.retryAfter));
      return new HttpError(err.status, err.code, err.message);
    }
    log('ai: unexpected error:', describeError(err));
    return new HttpError(500, 'internal', 'Something went wrong');
  }

  // Each save or test makes an outbound call, so a person gets a few an hour and one at a time.
  async function verifyKey(res, user, { provider, apiKey, baseUrl = null, model = null }) {
    const turn = saves.begin(user.id);
    if (turn.wait) {
      res.setHeader('retry-after', String(turn.wait));
      throw new HttpError(429, 'rate_limited', 'Too many key checks. Try again later.');
    }
    try {
      await makeProvider({ kind: provider, apiKey, baseUrl, model }).verify();
    } catch (err) {
      throw failure(res, err);
    } finally {
      turn.done();
    }
  }

  async function testStoredKey(res, user, scope) {
    if (!ring.configured) throw conflict('ai_unconfigured', UNCONFIGURED);
    const userId = scope === 'user' ? user.id : null;
    let found;
    try {
      found = directory.readAiKey({ ring, scope, userId });
    } catch (err) {
      throw failure(res, err);
    }
    if (!found) throw notFound('AI key not found');

    try {
      await verifyKey(res, user, { provider: found.row.provider, apiKey: found.apiKey, baseUrl: found.row.base_url ?? null, model: found.row.model ?? null });
    } catch (err) {
      // A throttle refusal did not reach the provider, so it did not test the key.
      if (!(err instanceof HttpError && err.code === 'rate_limited')) {
        audit(user, 'ai.key.test', { scope, provider: found.row.provider, ok: false });
      }
      throw err;
    }

    const fresh = stillThere(user);
    if (scope === 'user') {
      if (!personalKeysFor(settingsNow(), fresh)) throw forbidden('Personal AI keys are not allowed in this workspace');
    } else if (!isAdmin(fresh)) {
      throw forbidden('Only workspace admins can do that');
    }
    audit(user, 'ai.key.test', { scope, provider: found.row.provider, ok: true });
    return [200, { ok: true, provider: found.row.provider, checkedAt: now() }];
  }

  const keyView = (info) => (info ? { provider: info.provider, baseUrl: info.baseUrl, model: info.model, hint: info.hint, createdAt: info.createdAt, lastUsedAt: info.lastUsedAt } : null);

  // What an audit row says about a key: who it is for and which provider. For an OpenAI-compatible one also the host (not the
  // whole address, which could carry a path the operator would rather not repeat) and the model id; never the key.
  const keyAudit = (scope, key) => ({ scope, provider: key.provider, ...(key.baseUrl ? { host: hostOf(key.baseUrl), model: key.model } : {}) });

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
      const workspaceKey = directory.getAiKeyInfo('workspace');
      const keySource = !ring.configured ? null : mine ? 'user' : workspaceKey ? 'workspace' : null;
      const inUse = keySource === 'user' ? mine : keySource === 'workspace' ? workspaceKey : null;
      return [
        200,
        {
          enabled: aiEnabledFor(settings, user),
          features: settings.features,
          keySource,
          provider: inUse?.provider ?? null,
          // a key of a provider with no fixed list of models names its own
          model: inUse?.model ?? settings.model,
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
      const { apiKey, provider, baseUrl, model } = checked.key;
      await verifyKey(res, user, checked.key);
      const fresh = stillThere(user);
      if (!personalKeysFor(settingsNow(), fresh)) throw forbidden('Personal AI keys are not allowed in this workspace');
      const saved = directory.transaction(() => {
        const result = directory.saveAiKey({ ring, scope: 'user', userId: user.id, provider, baseUrl, model, apiKey, createdBy: user.id });
        audit(user, 'ai.key.set', keyAudit('user', checked.key));
        return result;
      });
      return [200, saved];
    }),

    compile('POST', 'ai/keys/me/test', { body: true, readOnlyOk: true }, async ({ res, user }) => {
      if (!personalKeysFor(settingsNow(), user)) throw forbidden('Personal AI keys are not allowed in this workspace');
      return testStoredKey(res, user, 'user');
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
      if (key) await verifyKey(res, user, key);
      if (!isAdmin(stillThere(user))) throw forbidden('Only workspace admins can do that');
      directory.transaction(() => {
        if (Object.keys(patch).length) {
          writeAiSettings(directory, patch);
          audit(user, 'ai.settings', patch);
        }
        if (key) {
          directory.saveAiKey({ ring, scope: 'workspace', provider: key.provider, baseUrl: key.baseUrl, model: key.model, apiKey: key.apiKey, createdBy: user.id });
          audit(user, 'ai.key.set', keyAudit('workspace', key));
        }
      });
      return [200, adminView()];
    }),

    compile('POST', 'admin/ai/key/test', { body: true, readOnlyOk: true }, async ({ res, user }) => {
      requireAdmin(user);
      return testStoredKey(res, user, 'workspace');
    }),

    ...createRunRoutes({ compile, errors, audit, directory, cloud, ring, settingsNow, canWriteRoom, readRoom, createProvider: makeProvider, live, log, now, timeoutMs }),

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
