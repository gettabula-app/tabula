#!/usr/bin/env node
// End-to-end run of the hosted product (docs/e2e-hosted.md): the landing site, the signup form, Stripe Checkout in TEST mode, the new
// workspace, the sign-in link and a board. Staged, so the parts that cost nothing run on their own:
//
//   smoke   the site's pages at 1280 and 390 px, no console errors, no CORS error on the live slug check, preflight answers
//   forms   slug rules and invalid emails on the signup form (only invalid data is submitted; a 201 from the API fails the run)
//   cancel  starts a Checkout (a customer and a pending workspace in Stripe test mode, no Fly app), goes back, checks the cancel page
//   signup  the whole path: pays with the test card, waits for the workspace, signs in with the emailed link, opens a board
//
//   node scripts/e2e-hosted.mjs --stage smoke,forms [--out <folder>]
//   node scripts/e2e-hosted.mjs --stage cancel --allow-checkout --email <address>
//   node scripts/e2e-hosted.mjs --stage signup --allow-signup --email <address> --slug e2e-1016a [--link-file <path>]
//
// Safety: `cancel` needs --allow-checkout and `signup` needs --allow-signup (each real signup creates a Fly app, so each needs a go from
// the manager). Before it types a card the script checks that the Checkout page shows Stripe's test-mode badge and stops if it does not;
// the only card it knows is 4242 4242 4242 4242. Nothing secret is read, printed or stored; the sign-in link comes from --link or from
// the file named by --link-file (written by whoever reads the mailbox) and is never echoed. Not part of `npm test` or CI.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const USAGE = 'Usage: node scripts/e2e-hosted.mjs --stage smoke,forms,cancel,signup [--out <dir>] [--site <url>] [--api <url>] [--ws-suffix <domain>] [--email <address>] [--slug <slug>] [--name <workspace name>] [--link <url>] [--link-file <path>] [--allow-checkout] [--allow-signup] [--price <text>]';
let args;
try {
  args = parseArgs({
    options: {
      stage: { type: 'string', default: 'smoke,forms' }, out: { type: 'string' }, site: { type: 'string', default: 'https://gettabula.app' },
      api: { type: 'string', default: 'https://api.gettabula.app' }, 'ws-suffix': { type: 'string', default: 'thetabula.cloud' },
      email: { type: 'string' }, slug: { type: 'string' }, name: { type: 'string', default: 'E2E test workspace' },
      link: { type: 'string' }, 'link-file': { type: 'string' }, 'allow-checkout': { type: 'boolean' }, 'allow-signup': { type: 'boolean' },
      price: { type: 'string', default: '29' }, help: { type: 'boolean' },
    },
  }).values;
} catch (err) {
  console.error(`${err.message}\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
const STAGES = args.stage.split(',').map((s) => s.trim()).filter(Boolean);
const OUT = path.resolve(args.out ?? path.join('tabula-review', 'e2e', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)));
fs.mkdirSync(OUT, { recursive: true });
const SITE = args.site.replace(/\/$/, '');
const API = args.api.replace(/\/$/, '');
const CARD = { number: '4242 4242 4242 4242', expiry: '12 / 34', cvc: '123', name: 'E2E Tester', postal: '12345' };
const report = [];
const check = (ok, name, detail = '') => {
  report.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
  return ok;
};
const note = (text) => console.log(`NOTE ${text}`);
const shot = async (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {});

/** The signup form's fields. Names are the labels people read; adjust here if the form is reworded. */
const F = {
  name: (page) => page.getByLabel(/workspace name/i),
  slug: (page) => page.getByLabel(/workspace address|address/i).first(),
  email: (page) => page.getByLabel(/email/i).first(),
  submit: (page) => page.getByRole('button', { name: /continue to payment|continue|start/i }).first(),
};

function watch(page, bucket) {
  page.on('console', (m) => { if (m.type() === 'error') bucket.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => bucket.push(`pageerror ${e.message.slice(0, 200)}`));
  page.on('requestfailed', (r) => bucket.push(`failed ${r.url().slice(0, 100)} ${r.failure()?.errorText ?? ''}`));
}

async function smoke(browser) {
  for (const [label, width, height] of [['desktop', 1280, 800], ['phone', 390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width, height }, locale: 'en-US' });
    for (const p of ['/', '/signup', '/docs', '/privacy']) {
      const page = await ctx.newPage();
      const errs = [];
      watch(page, errs);
      const res = await page.goto(SITE + p, { waitUntil: 'networkidle', timeout: 30_000 }).catch((e) => ({ status: () => 0, error: e }));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1).catch(() => true);
      check(res.status() === 200 && !errs.length && !overflow, `smoke ${label} ${p}`, `status ${res.status()}, ${errs.length} errors${overflow ? ', scrolls sideways' : ''}${errs[0] ? `: ${errs[0]}` : ''}`);
      await shot(page, `smoke-${label}${p.replace(/\//g, '_') || '_'}`);
      await page.close();
    }
    await ctx.close();
  }
  const pre = await fetch(`${API}/v1/signup`, { method: 'OPTIONS', headers: { origin: SITE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } }).catch(() => null);
  const allow = pre?.headers.get('access-control-allow-origin');
  check(!!pre && pre.status < 300 && (allow === SITE || allow === '*'), 'CORS preflight for POST /v1/signup', `status ${pre?.status}, allow-origin ${allow}`);
  const probe = await fetch(`${API}/v1/slugs/e2e-cors-probe`, { headers: { origin: SITE } }).catch(() => null);
  check(!!probe && probe.ok && !!probe.headers.get('access-control-allow-origin'), 'CORS header on GET /v1/slugs/<slug>', `status ${probe?.status}`);
}

async function openForm(browser, width = 1280) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 800 }, locale: 'en-US' });
  const page = await ctx.newPage();
  const errs = [];
  watch(page, errs);
  const posts = [];
  page.on('response', (r) => { if (r.request().method() === 'POST' && r.url().includes('/v1/signup')) posts.push(r.status()); });
  await page.goto(`${SITE}/signup`, { waitUntil: 'networkidle' });
  return { ctx, page, errs, posts };
}

async function forms(browser) {
  const { ctx, page, errs, posts } = await openForm(browser);
  const text = await page.evaluate(() => document.body.innerText);
  check(new RegExp(args.price).test(text), 'signup page states the price', `looking for "${args.price}"`);
  check(!/per seat|seats?\b/i.test(text), 'signup page has no seat wording (flat price)', (text.match(/.{0,30}seats?.{0,30}/i) ?? [''])[0].replace(/\s+/g, ' '));
  const status = (page2) => page2.evaluate(() => (document.querySelector('[role=status], [aria-live]')?.textContent ?? '').trim());
  for (const [v, want] of [['www', /reserved/i], ['ab', /3 to 32/i], ['Bad_Slug', /3 to 32|lowercase/i], ['-lead', /hyphen/i]]) {
    await F.slug(page).fill(v);
    await sleep(1100);
    const s = await status(page);
    check(want.test(s), `slug "${v}" is refused with its rule`, s);
  }
  await F.slug(page).fill('e2e-forms-probe-free');
  await sleep(1500);
  const free = await status(page);
  check(!errs.some((e) => /cors/i.test(e)) && !/could not check/i.test(free), 'live slug check answers for a free slug', free || errs.join(' | ').slice(0, 160));
  await F.name(page).fill(args.name);
  for (const bad of ['', 'abc', 'abc@', 'a b@c.d']) {
    await F.email(page).fill(bad);
    await F.submit(page).click().catch(() => {});
    await sleep(900);
    const here = page.url();
    check(!here.includes('checkout.stripe.com') && !posts.includes(201), `invalid email ${JSON.stringify(bad)} does not start a Checkout`, `url ${here.slice(0, 60)}, POST statuses ${posts.join(',') || 'none'}`);
    if (here.includes('checkout.stripe.com') || posts.includes(201)) break;
  }
  await shot(page, 'forms-invalid-email');
  await ctx.close();
}

/** Fills and submits the signup form with valid data; returns once the browser is on Stripe's Checkout (or fails). */
async function startCheckout(browser, width = 1280) {
  const { ctx, page } = await openForm(browser, width);
  await F.name(page).fill(args.name);
  await F.slug(page).fill(args.slug);
  await sleep(1500);
  await F.email(page).fill(args.email);
  await shot(page, `form-filled-${width}`);
  await F.submit(page).click();
  const reached = await page.waitForURL(/checkout\.stripe\.com/, { timeout: 45_000 }).then(() => true).catch(() => false);
  check(reached, 'the form sends you to Stripe Checkout', page.url().slice(0, 80));
  if (reached) await sleep(2500);
  await shot(page, `checkout-${width}`);
  return { ctx, page, reached };
}

async function testModeBadge(page) {
  const text = await page.evaluate(() => document.body.innerText);
  return /test mode/i.test(text);
}

async function cancel(browser) {
  if (!args['allow-checkout'] || !args.email || !args.slug) {
    check(false, 'cancel stage needs --allow-checkout, --email and --slug', 'skipped without those (a Checkout creates a customer and a pending workspace)');
    return;
  }
  const { ctx, page, reached } = await startCheckout(browser);
  if (reached) {
    check(await testModeBadge(page), 'Checkout shows the test-mode badge');
    const back = page.getByRole('link', { name: /back|return/i }).first();
    await back.click().catch(() => page.goBack());
    const landed = await page.waitForURL(new RegExp(`${SITE.replace(/[.]/g, '\\.')}/signup`), { timeout: 20_000 }).then(() => true).catch(() => false);
    check(landed && /checkout=canceled/.test(page.url()), 'cancelling returns to the cancel page', page.url().slice(0, 90));
    const text = await page.evaluate(() => document.body.innerText);
    check(/cancel/i.test(text) && /nothing was charged|not charged|no charge/i.test(text), 'the cancel page says nothing was charged');
    await shot(page, 'cancel-page');
    const ws = await fetch(`https://${args.slug}.${args['ws-suffix']}/`, { redirect: 'manual' }).then((r) => r.status).catch(() => 0);
    check(ws === 0 || ws === 404 || ws >= 500 || ws === 421, 'no workspace exists after a cancelled Checkout', `GET workspace status ${ws}`);
  }
  await ctx.close();
}

async function fillStripe(page) {
  const frames = page.frames();
  const find = async (selectors) => {
    for (const f of frames) for (const s of selectors) { const l = f.locator(s).first(); if (await l.count()) return l; }
    return null;
  };
  const num = await find(['#cardNumber', 'input[name=cardNumber]', 'input[autocomplete=cc-number]']);
  if (!num) return false;
  await num.fill(CARD.number);
  (await find(['#cardExpiry', 'input[name=cardExpiry]', 'input[autocomplete=cc-exp]']))?.fill(CARD.expiry);
  (await find(['#cardCvc', 'input[name=cardCvc]', 'input[autocomplete=cc-csc]']))?.fill(CARD.cvc);
  (await find(['#billingName', 'input[name=billingName]']))?.fill(CARD.name);
  (await find(['#billingPostalCode', 'input[name=billingPostalCode]']))?.fill(CARD.postal).catch(() => {});
  return true;
}

/** The sign-in link: --link, else the first https line of --link-file (polled), else typed or pasted at a prompt when run from a terminal. */
async function readLink() {
  if (args.link) return args.link;
  const file = args['link-file'];
  if (!file) {
    if (!process.stdin.isTTY) return null;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const v = (await rl.question('Paste the sign-in link from the e-mail (it is not echoed to the log): ')).trim();
    rl.close();
    return v.startsWith('https://') ? v : null;
  }
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    if (fs.existsSync(file)) {
      const v = fs.readFileSync(file, 'utf8').trim();
      if (v.startsWith('https://')) return v;
    }
    await sleep(3000);
  }
  return null;
}

async function signup(browser) {
  if (!args['allow-signup'] || !args.email || !args.slug) {
    check(false, 'signup stage needs --allow-signup, --email and --slug', 'skipped without those (a signup creates a Fly app and needs the manager\'s go)');
    return;
  }
  const t0 = Date.now();
  const { ctx, page, reached } = await startCheckout(browser);
  if (!reached) return void (await ctx.close());
  if (!(await testModeBadge(page))) {
    check(false, 'Checkout shows the test-mode badge', 'NOT in test mode: stopped before typing any card');
    return void (await ctx.close());
  }
  check(true, 'Checkout shows the test-mode badge');
  const text = await page.evaluate(() => document.body.innerText);
  check(new RegExp(args.price).test(text), 'Checkout shows the plan price', `looking for "${args.price}"`);
  if (!(await fillStripe(page))) {
    check(false, 'card fields found on the Checkout page', 'headless Stripe page changed or shows a bot check: pay by hand, then resume at the return URL');
    await shot(page, 'checkout-stuck');
    return void (await ctx.close());
  }
  await shot(page, 'checkout-filled');
  await page.getByRole('button', { name: /start trial|subscribe|pay|confirm/i }).first().click();
  const back = await page.waitForURL(new RegExp(`${SITE.replace(/[.]/g, '\\.')}/signup/success`), { timeout: 90_000 }).then(() => true).catch(() => false);
  check(back && page.url().includes(`slug=${args.slug}`), 'Checkout returns to the success page for the slug', page.url().slice(0, 100));
  await shot(page, 'success-page');
  const paidAt = Date.now();
  const base = `https://${args.slug}.${args['ws-suffix']}`;
  let ready = false;
  while (Date.now() - paidAt < 600_000 && !ready) {
    ready = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
    if (!ready) await sleep(5000);
  }
  check(ready, 'the workspace answers within 10 minutes', `${Math.round((Date.now() - paidAt) / 1000)} s after payment`);
  if (!ready) return void (await ctx.close());
  const wp = await ctx.newPage();
  await wp.goto(base, { waitUntil: 'networkidle' });
  await shot(wp, 'workspace-signin');
  const emailBox = wp.getByLabel(/email/i).first();
  await emailBox.fill(args.email);
  await wp.getByRole('button', { name: /email me|send|link|continue/i }).first().click();
  const sentAt = Date.now();
  note('sign-in link requested; waiting for the link (--link, --link-file or a prompt)');
  const link = await readLink();
  check(!!link, 'the sign-in link arrives', link ? `${Math.round((Date.now() - sentAt) / 1000)} s` : 'no link given within 3 minutes');
  if (link) {
    check(link.startsWith(base), 'the link points at the workspace', 'host checked only');
    await wp.goto(link, { waitUntil: 'networkidle' });
    await sleep(1500);
    await shot(wp, 'boards-page');
    const t = await wp.evaluate(() => document.body.innerText);
    check(/boards/i.test(t) && !/sign in|check your email/i.test(t.slice(0, 200)), 'signed in: the boards page opens', wp.url().replace(/token=[^&]+/, 'token=…').slice(0, 80));
    await wp.getByRole('button', { name: /new board/i }).first().click().catch(() => {});
    await sleep(2500);
    await shot(wp, 'new-board');
    check(/#\/b\//.test(wp.url()), 'a new board opens', wp.url().replace(/token=[^&]+/, 'token=…').slice(0, 80));
  }
  note(`total ${Math.round((Date.now() - t0) / 1000)} s; tear down the workspace '${args.slug}' (Fly app tabula-ws-${args.slug}) afterwards`);
  await ctx.close();
}

const browser = await chromium.launch({ headless: true });
try {
  if (STAGES.includes('smoke')) await smoke(browser);
  if (STAGES.includes('forms')) await forms(browser);
  if (STAGES.includes('cancel')) await cancel(browser);
  if (STAGES.includes('signup')) await signup(browser);
} finally {
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
}
console.log(`REPORT pass=${report.filter((r) => r.ok).length} fail=${report.filter((r) => !r.ok).length} out=${OUT}`);
process.exit(report.some((r) => !r.ok) ? 1 : 0);
