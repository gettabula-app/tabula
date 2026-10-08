import fs from 'node:fs';
import path from 'node:path';

const WEBHOOK_TIMEOUT_MS = 10_000;

export function createMailer(config) {
  const { mode, webhookUrl, from } = config.mail;

  async function send({ to, subject, text }) {
    if (mode === 'log') {
      console.log(`--- mail to ${to} ---\nSubject: ${subject}\n\n${text}\n--- end mail ---`);
    } else if (mode === 'file') {
      fs.mkdirSync(config.dataDir, { recursive: true });
      const line = JSON.stringify({ to, subject, text, from, ts: Date.now() });
      // the mails contain sign-in links, so the file is private to the server user
      fs.appendFileSync(path.join(config.dataDir, 'outbox.jsonl'), `${line}\n`, { mode: 0o600 });
    } else if (mode === 'webhook') {
      if (!webhookUrl) throw new Error('mail webhook URL is not configured');
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to, subject, text, from }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      await res.body?.cancel();
      if (!res.ok) throw new Error(`mail webhook answered ${res.status}`);
    } else {
      throw new Error(`unknown mail mode "${mode}"`);
    }
  }

  return { send };
}
