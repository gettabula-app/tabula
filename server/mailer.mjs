import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';

const WEBHOOK_TIMEOUT_MS = 10_000;

export function createMailer(config) {
  const { mode, webhookUrl, smtpUrl, from } = config.mail;
  let transport = null;

  /**
   * `template` and `params` name the kind of email (for example `sign-in`) so a provider integration can render its own wording.
   * @param {{ to: string, subject: string, text: string, template?: string, params?: Record<string, unknown> }} message
   */
  async function send({ to, subject, text, template, params }) {
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
        body: JSON.stringify({ to, subject, text, from, template, params }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      await res.body?.cancel();
      if (!res.ok) throw new Error(`mail webhook answered ${res.status}`);
    } else if (mode === 'smtp') {
      if (!smtpUrl) throw new Error('SMTP is not configured');
      transport ??= nodemailer.createTransport(smtpUrl);
      await transport.sendMail({ from, to, subject, text });
    } else {
      throw new Error(`unknown mail mode "${mode}"`);
    }
  }

  return { send };
}
