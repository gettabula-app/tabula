#!/usr/bin/env node
// Read-only launch checklist for gettabula.app, its landing-page demo and the hosted API.
// The only write-capable path is the explicitly gated, existing test-mode hosted e2e.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import {
  findForbiddenPageText,
  findLegalPlaceholders,
  inspectEducationOffer,
  inspectFlatPricing,
  parseRobotsTxt,
  parseSitemapXml,
  requestFollowingRedirects,
  resolveInternalResources,
} from './lib/prelaunch-smoke.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STAGES = ['site', 'demo', 'education', 'legal', 'api'];
const VALID_STAGES = new Set([...DEFAULT_STAGES, 'signup', 'all']);
const USAGE = `Usage: npm run qa:prelaunch -- [options]

  --stage site,demo,signup,education,legal,api,all  default: site,demo,education,legal,api
  --site <url>          marketing site base (default: https://gettabula.app)
  --api <url>           hosted API base (default: https://api.gettabula.app)
  --demo <url>          demo URL (default: <site>/demo/)
  --yes-test-mode       explicitly permit the existing signup e2e to submit its Stripe test card
  --stripe-url <url>    required signup guard; checkout.stripe.com URL containing cs_test_
  --email <address>     signup e2e owner mailbox
  --slug <slug>         new, disposable e2e workspace slug
  --link-file <path>    optional file consumed by scripts/e2e-hosted.mjs for its sign-in link
  --help`;

let args;
try {
  args = parseArgs({
    options: {
      stage: { type: 'string', default: DEFAULT_STAGES.join(',') },
      site: { type: 'string', default: 'https://gettabula.app' },
      api: { type: 'string', default: 'https://api.gettabula.app' },
      demo: { type: 'string' },
      'yes-test-mode': { type: 'boolean', default: false },
      'stripe-url': { type: 'string' },
      email: { type: 'string' },
      slug: { type: 'string' },
      'link-file': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  }).values;
} catch (error) {
  console.error(`${error.message}\n${USAGE}`);
  process.exit(2);
}

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

function parseBase(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--${label} must be an absolute http(s) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`--${label} must be an http(s) URL without credentials, query or fragment`);
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href.replace(/\/$/, '');
}

let SITE;
let API;
let DEMO;
let STAGES;
try {
  SITE = parseBase(args.site, 'site');
  API = parseBase(args.api, 'api');
  DEMO = args.demo ? parseBase(args.demo, 'demo') : `${SITE}/demo`;
  const requested = args.stage.split(',').map((stage) => stage.trim().toLowerCase()).filter(Boolean);
  const invalid = requested.filter((stage) => !VALID_STAGES.has(stage));
  if (!requested.length || invalid.length) throw new Error(`Unknown or empty stage list: ${invalid.join(', ') || args.stage}`);
  STAGES = requested.includes('all') ? [...DEFAULT_STAGES, 'signup'] : [...new Set(requested)];
} catch (error) {
  console.error(`${error.message}\n${USAGE}`);
  process.exit(2);
}

const report = [];
function check(state, name, url, fact) {
  report.push({ state, name, url, fact });
  console.log(`${state} ${name} :: ${url} :: ${fact}`);
}

function errorFact(error) {
  const message = error?.message ?? String(error);
  const first = message.split('\n')[0];
  const diagnostic = message.split('\n').find((line) => /FATAL|EPERM|Permission denied|ECONN/i.test(line));
  return diagnostic ? `${first}; ${diagnostic.trim().slice(-240)}` : first;
}

function appendPath(base, pathname) {
  const baseUrl = new URL(base);
  const prefix = baseUrl.pathname.replace(/\/+$/, '');
  return `${baseUrl.origin}${prefix}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

async function mapLimit(values, limit, fn) {
  const results = Array.from({ length: values.length });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]);
    }
  }));
  return results;
}

function canonicalHostname(base) {
  return new URL(base).hostname.replace(/^www\./i, '');
}

function isLocalHost(hostname) {
  const unbracketed = hostname.replace(/^\[|\]$/g, '');
  return unbracketed === 'localhost' || unbracketed.endsWith('.localhost') || unbracketed.endsWith('.test') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(unbracketed) || unbracketed === '::1';
}

function requestFact(result) {
  if (result.error) return result.error;
  const status = result.response?.status ?? 'no response';
  const final = result.url;
  return `HTTP ${status}; redirects=${result.redirects.length}; final=${final}`;
}

async function readPage(url) {
  const result = await requestFollowingRedirects(url);
  let body = '';
  if (result.response) {
    try {
      body = await result.response.text();
    } catch (error) {
      result.error = `could not read response: ${errorFact(error)}`;
    }
  }
  return { ...result, body };
}

async function inspectHtml(browser, html) {
  if (!browser) return null;
  const page = await browser.newPage();
  try {
    return await page.evaluate((source) => {
      const documentCopy = new DOMParser().parseFromString(source, 'text/html');
      const visibleBody = documentCopy.body.cloneNode(true);
      visibleBody.querySelectorAll('script, style, noscript, template').forEach((element) => element.remove());
      return {
        title: documentCopy.title.trim(),
        description: documentCopy.querySelector('meta[name="description" i]')?.getAttribute('content')?.trim() ?? '',
        canonical: documentCopy.querySelector('link[rel~="canonical" i]')?.getAttribute('href') ?? '',
        text: [
          visibleBody.textContent ?? '',
          ...[...documentCopy.querySelectorAll('[placeholder], img[alt]')].map((element) => element.getAttribute('placeholder') ?? element.getAttribute('alt') ?? ''),
        ].join(' ').replace(/\s+/g, ' ').trim(),
        links: [...documentCopy.querySelectorAll('a[href]')].map((element) => element.getAttribute('href')),
        images: [...documentCopy.querySelectorAll('img[src], source[src]')].map((element) => element.getAttribute('src')),
      };
    }, html);
  } finally {
    await page.close();
  }
}

function checkStatus(name, requestedUrl, result) {
  const status = result.response?.status;
  const ok = !result.error && !result.loop && status === 200;
  check(ok ? 'PASS' : 'FAIL', name, requestedUrl, requestFact(result));
  return ok;
}

async function inspectPage(browser, url, { legal = false, education = false, pricing = false } = {}) {
  const result = await readPage(url);
  checkStatus('page HTTP status and redirect chain', url, result);
  if (result.error || !result.response || result.response.status !== 200) return { result, facts: null };
  const contentType = result.response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('text/html')) {
    check('FAIL', 'page is HTML for metadata and text checks', url, `content-type=${contentType || '(missing)'}`);
    return { result, facts: null };
  }
  let facts;
  try {
    facts = await inspectHtml(browser, result.body);
  } catch (error) {
    check('FAIL', 'HTML metadata and text can be inspected', url, errorFact(error));
    return { result, facts: null };
  }
  if (!facts) {
    check('FAIL', 'Chromium can inspect page metadata and text', url, 'Playwright Chromium could not launch');
    return { result, facts: null };
  }
  check(facts.title ? 'PASS' : 'FAIL', 'page title is present', url, facts.title || 'missing <title>');
  check(facts.description ? 'PASS' : 'FAIL', 'meta description is present', url, facts.description || 'missing meta description');
  let canonical = null;
  try {
    if (facts.canonical) canonical = new URL(facts.canonical, result.url);
  } catch {
    // Invalid canonical URLs are reported as invalid below.
  }
  const expectedHost = canonicalHostname(SITE);
  const responseHost = new URL(result.url).hostname;
  const canonicalHostOk = responseHost === expectedHost && (!facts.canonical || canonical?.hostname === expectedHost);
  const canonicalFact = `page-host=${responseHost}; declared-canonical-host=${canonical?.hostname ?? (facts.canonical ? 'invalid' : 'not declared')}; expected=${expectedHost}`;
  check(canonicalHostOk ? 'PASS' : 'FAIL', 'page and any declared canonical use the expected host', url, canonicalFact);
  const pageCopy = `${facts.title} ${facts.description} ${facts.text}`;
  const hazards = findForbiddenPageText(pageCopy);
  check(hazards.length ? 'FAIL' : 'PASS', 'page text has no local or placeholder values', url, hazards.length ? `found=${hazards.join(', ')}` : 'none found');
  if (legal) {
    const placeholders = findLegalPlaceholders(pageCopy);
    check(placeholders.length ? 'FAIL' : 'PASS', 'legal page has no draft placeholders', url, placeholders.length ? `found=${placeholders.join(', ')}` : 'none found');
  }
  if (education) {
    const offer = inspectEducationOffer(facts.text);
    const ok = offer.halfPrice && offer.trialApplication;
    check(ok ? 'PASS' : 'FAIL', 'education offer states half price and how to apply during trial', url, `half-price=${offer.halfPrice}; trial-application=${offer.trialApplication}`);
  }
  if (pricing) {
    const prices = inspectFlatPricing(`${facts.text} ${facts.description}`);
    const ok = prices.monthly && prices.yearly && prices.founding && prices.flat;
    check(ok ? 'PASS' : 'FAIL', 'signup pricing matches the flat EUR plan', url, `€29/month=${prices.monthly}; €290/year=${prices.yearly}; €19 for 12 months through 31 Dec 2026=${prices.founding}; no per-person/seat wording=${prices.flat}`);
  }
  return { result, facts };
}

function tlsCheck(url, label) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      check('SKIP', `${label} TLS certificate`, url, `scheme is ${parsed.protocol}; TLS is not used`);
      resolve();
      return;
    }
    const port = Number(parsed.port || 443);
    const socket = tls.connect({ host: parsed.hostname, port, servername: parsed.hostname, rejectUnauthorized: false });
    const timer = setTimeout(() => socket.destroy(new Error('TLS handshake timed out')), 12_000);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const certificate = socket.getPeerCertificate();
      const validFrom = Date.parse(certificate.valid_from ?? '');
      const validTo = Date.parse(certificate.valid_to ?? '');
      const now = Date.now();
      const daysLeft = Number.isFinite(validTo) ? Math.floor((validTo - now) / 86_400_000) : null;
      const valid = socket.authorized && Number.isFinite(validFrom) && Number.isFinite(validTo) && validFrom <= now && validTo > now;
      const fact = `authorized=${socket.authorized}; valid-from=${certificate.valid_from ?? 'unknown'}; valid-to=${certificate.valid_to ?? 'unknown'}; days-left=${daysLeft ?? 'unknown'}${socket.authorizationError ? `; reason=${socket.authorizationError}` : ''}`;
      check(valid ? 'PASS' : 'FAIL', `${label} TLS certificate`, url, fact);
      socket.end();
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      check('FAIL', `${label} TLS certificate`, url, errorFact(error));
      resolve();
    });
  });
}

function headerFacts(headers) {
  const hsts = headers.get('strict-transport-security');
  const contentTypeOptions = headers.get('x-content-type-options');
  const xFrame = headers.get('x-frame-options');
  const csp = headers.get('content-security-policy') ?? '';
  const framePolicy = Boolean(xFrame?.trim()) || /(?:^|;)\s*frame-ancestors\s+[^;]+/i.test(csp);
  return {
    hsts: Boolean(hsts?.trim()),
    contentTypeOptions: contentTypeOptions?.trim().toLowerCase() === 'nosniff',
    framePolicy,
    values: `HSTS=${hsts ?? 'missing'}; X-Content-Type-Options=${contentTypeOptions ?? 'missing'}; frame-policy=${xFrame ? `X-Frame-Options ${xFrame}` : framePolicy ? 'CSP frame-ancestors' : 'missing'}`,
  };
}

async function checkSecurityHeaders(url, label) {
  const result = await requestFollowingRedirects(url);
  if (!result.response || result.error) {
    check('FAIL', `${label} security headers`, url, requestFact(result));
    return;
  }
  const facts = headerFacts(result.response.headers);
  await result.response.body?.cancel().catch(() => {});
  const ok = facts.hsts && facts.contentTypeOptions && facts.framePolicy;
  check(ok ? 'PASS' : 'FAIL', `${label} security headers`, url, facts.values);
}

async function runSiteStages(browser) {
  const paths = new Set();
  const scanPaths = new Set();
  if (STAGES.includes('site')) for (const pathName of ['/', '/signup', '/contact', '/docs']) paths.add(pathName);
  if (STAGES.includes('education')) paths.add('/education');
  if (STAGES.includes('legal')) for (const pathName of ['/terms', '/privacy']) paths.add(pathName);
  for (const pathName of paths) scanPaths.add(pathName);
  if (paths.size) {
    await tlsCheck(SITE, 'Marketing site');
    const sitemapLinks = [];
    const sitemapUrls = [];
    if (STAGES.includes('site')) {
      const robotsUrl = appendPath(SITE, '/robots.txt');
      const robots = await readPage(robotsUrl);
      checkStatus('robots.txt HTTP status', robotsUrl, robots);
      if (robots.response?.status === 200 && !robots.error) {
        const parsed = parseRobotsTxt(robots.body);
        const expectedSitemap = appendPath(SITE, '/sitemap.xml');
        const hasExpectedSitemap = parsed.sitemapUrls.some((value) => {
          try {
            const sitemapUrl = new URL(value, robots.url);
            return sitemapUrl.pathname === new URL(expectedSitemap).pathname && sitemapUrl.hostname === canonicalHostname(SITE);
          } catch {
            return false;
          }
        });
        check(parsed.sitemapUrls.length && parsed.allowsRoot ? 'PASS' : 'FAIL', 'robots.txt parses', robotsUrl, `allow-root=${parsed.allowsRoot}; sitemap-lines=${parsed.sitemapUrls.length}`);
        check(hasExpectedSitemap ? 'PASS' : 'FAIL', 'robots.txt names the canonical sitemap', robotsUrl, hasExpectedSitemap ? expectedSitemap : 'canonical sitemap URL is missing');
      }
      const sitemapUrl = appendPath(SITE, '/sitemap.xml');
      const sitemap = await readPage(sitemapUrl);
      checkStatus('sitemap.xml HTTP status', sitemapUrl, sitemap);
      if (sitemap.response?.status === 200 && !sitemap.error) {
        try {
          sitemapLinks.push(...parseSitemapXml(sitemap.body, sitemap.url));
          const canonicalOrigin = new URL(sitemap.url).origin.replace(new URL(sitemap.url).hostname, canonicalHostname(SITE));
          const canonicalLinks = sitemapLinks.every((link) => new URL(link).origin === canonicalOrigin);
          check(sitemapLinks.length && canonicalLinks ? 'PASS' : 'FAIL', 'sitemap.xml parses with canonical URLs', sitemapUrl, `urls=${sitemapLinks.length}; canonical-host=${canonicalLinks}`);
        } catch (error) {
          check('FAIL', 'sitemap.xml parses with canonical URLs', sitemapUrl, error.message);
        }
      }
      const origin = new URL(SITE);
      if (isLocalHost(origin.hostname)) {
        check('SKIP', 'www redirects to the canonical host', `https://www.${origin.hostname}/`, 'local fixture hostname has no public www alias');
      } else {
        const wwwUrl = new URL(origin);
        wwwUrl.hostname = `www.${canonicalHostname(SITE)}`;
        const www = await requestFollowingRedirects(wwwUrl.href);
        const targetHost = www.response ? new URL(www.url).hostname : '';
        const ok = !www.error && !www.loop && www.redirects.length > 0 && www.response?.status === 200 && targetHost === canonicalHostname(SITE);
        check(ok ? 'PASS' : 'FAIL', 'www redirects to the canonical host', wwwUrl.href, requestFact(www));
        await www.response?.body?.cancel().catch(() => {});
      }
      for (const link of sitemapLinks) {
        const url = new URL(link);
        if (url.hostname !== canonicalHostname(SITE)) {
          check('FAIL', 'sitemap URL uses canonical host', link, `host=${url.hostname}; expected=${canonicalHostname(SITE)}`);
        }
        sitemapUrls.push(link);
      }
    }
    const cache = new Map();
    const pageUrls = [...new Set([...paths].map((pathName) => appendPath(SITE, pathName)).concat(sitemapUrls))];
    await mapLimit(pageUrls, 6, async (url) => {
      const pathName = new URL(url).pathname;
      const legal = pathName === '/terms' || pathName === '/privacy';
      const education = pathName === '/education';
      const pricing = pathName === '/' || pathName === '/signup';
      const page = await inspectPage(browser, url, { legal, education, pricing });
      cache.set(new URL(url).href, page);
    });
    if (STAGES.includes('site')) {
      for (const imagePath of ['/opengraph-image.png', '/twitter-image.png']) {
        const imageUrl = appendPath(SITE, imagePath);
        const image = await requestFollowingRedirects(imageUrl);
        const contentType = image.response?.headers.get('content-type') ?? '';
        const ok = !image.error && !image.loop && image.response?.status === 200 && contentType.toLowerCase().startsWith('image/');
        check(ok ? 'PASS' : 'FAIL', `${imagePath.includes('opengraph') ? 'Open Graph' : 'Twitter'} image exists`, imageUrl, `${requestFact(image)}; content-type=${contentType || 'missing'}`);
        await image.response?.body?.cancel().catch(() => {});
      }
      const mainFacts = [...scanPaths].map((p) => cache.get(new URL(appendPath(SITE, p)).href)?.facts).filter(Boolean);
      const resources = resolveInternalResources({
        links: mainFacts.flatMap((facts) => facts.links),
        images: mainFacts.flatMap((facts) => facts.images),
      }, SITE);
      for (const [kind, values] of [['internal link', resources.links], ['image', resources.images]]) {
        await mapLimit(values, 8, async (target) => {
          const resolved = await requestFollowingRedirects(target);
          const ok = !resolved.error && !resolved.loop && resolved.response?.status === 200;
          check(ok ? 'PASS' : 'FAIL', `main-page ${kind} resolves`, target, requestFact(resolved));
          await resolved.response?.body?.cancel().catch(() => {});
        });
      }
      await checkSecurityHeaders(appendPath(SITE, '/'), 'Marketing site');
    }
  }
}

async function runApiStage() {
  if (!STAGES.includes('api')) return;
  await tlsCheck(API, 'Hosted API');
  const apiRoot = appendPath(API, '/');
  await checkSecurityHeaders(apiRoot, 'Hosted API');
  const healthUrl = appendPath(API, '/api/health');
  const health = await requestFollowingRedirects(healthUrl);
  let healthJson = null;
  if (health.response && health.response.status === 200 && !health.error) {
    try {
      healthJson = await health.response.json();
    } catch {
      // A non-JSON health response is a failed health check below.
    }
  } else {
    await health.response?.body?.cancel().catch(() => {});
  }
  const healthy = health.response?.status === 200 && healthJson?.ok === true;
  check(healthy ? 'PASS' : 'FAIL', 'public API health endpoint answers', healthUrl, `${requestFact(health)}; JSON ok=${healthJson?.ok === true}`);
  const statsUrl = appendPath(API, '/api/internal/stats');
  const stats = await requestFollowingRedirects(statsUrl);
  const statsStatus = stats.response?.status;
  const protectedStats = !stats.error && !stats.loop && (statsStatus === 401 || statsStatus === 404);
  check(protectedStats ? 'PASS' : 'FAIL', 'internal stats stays private without a token', statsUrl, stats.error ?? `HTTP ${statsStatus ?? 'no response'}; expected 401 or 404; response body was not read`);
  await stats.response?.body?.cancel().catch(() => {});
}

function allowlistedFontshare(url) {
  try {
    return new Set(['api.fontshare.com', 'cdn.fontshare.com']).has(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function runDemoStage(browser) {
  if (!STAGES.includes('demo')) return;
  if (!browser) {
    check('FAIL', 'landing-page demo in Chromium', DEMO, 'Playwright Chromium could not launch');
    return;
  }
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 800 } });
    const consoleErrors = [];
    const failedRequests = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('requestfailed', (request) => {
      if (!allowlistedFontshare(request.url())) failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? 'request failed'})`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400 && !allowlistedFontshare(response.url())) failedRequests.push(`${response.url()} (HTTP ${response.status()})`);
    });
    try {
      const response = await page.goto(DEMO, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const canvas = page.locator('svg.canvas[aria-label="Whiteboard canvas"]');
      await canvas.waitFor({ state: 'visible', timeout: 20_000 });
      check(response?.status() === 200 ? 'PASS' : 'FAIL', 'demo document loads in Chromium', DEMO, `width=${width}; HTTP ${response?.status() ?? 'no response'}`);
      check(await canvas.isVisible() ? 'PASS' : 'FAIL', 'demo board is visible', DEMO, `width=${width}; selector=svg.canvas[aria-label="Whiteboard canvas"]`);
      const stickyButton = page.getByRole('button', { name: 'Sticky note' });
      const buttonVisible = await stickyButton.isVisible().catch(() => false);
      if (buttonVisible) {
        const before = await page.locator('svg.canvas .objects > g[data-id]').count();
        const bounds = await canvas.boundingBox();
        if (bounds) {
          for (const [index, fraction] of [0.35, 0.75].entries()) {
            await stickyButton.click();
            await page.mouse.click(bounds.x + bounds.width * fraction, bounds.y + bounds.height * 0.68);
            await page.waitForFunction((minimum) => document.querySelectorAll('svg.canvas .objects > g[data-id]').length >= minimum, before + index + 1, { timeout: 5_000 }).catch(() => {});
            await page.keyboard.press('Escape');
          }
        }
        const after = await page.locator('svg.canvas .objects > g[data-id]').count();
        const added = after - before;
        check(added >= 2 ? 'PASS' : 'FAIL', 'two sticky notes can be added', DEMO, `width=${width}; objects-before=${before}; objects-after=${after}; added=${added}`);
      } else {
        check('FAIL', 'two sticky notes can be added', DEMO, `width=${width}; Sticky note control is missing or hidden`);
      }
    } catch (error) {
      check('FAIL', 'demo loads and accepts two sticky notes', DEMO, `width=${width}; ${errorFact(error)}`);
    }
    check(consoleErrors.length ? 'FAIL' : 'PASS', 'demo browser console has no errors', DEMO, `width=${width}; errors=${consoleErrors.length}${consoleErrors[0] ? `; first=${consoleErrors[0]}` : ''}`);
    check(failedRequests.length ? 'FAIL' : 'PASS', 'demo has no failed non-Fontshare requests', DEMO, `width=${width}; failures=${failedRequests.length}${failedRequests[0] ? `; first=${failedRequests[0]}` : ''}`);
    await page.close();
  }
}

function validStripeTestUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' && /cs_test_/.test(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
}

function printManualSignupSteps(reason) {
  check('SKIP', 'hosted signup purchase flow', appendPath(SITE, '/signup'), reason);
  console.log('MANUAL signup steps:');
  console.log('  1. Use a team-controlled plus-address and a new e2e-<date> slug; confirm the exact test run with the manager.');
  console.log('  2. Complete Stripe Checkout in TEST mode only with 4242 4242 4242 4242, then confirm the workspace and welcome/sign-in email from no-reply@mg.gettabula.app.');
  console.log('  3. Open Manage billing, verify the Stripe portal and cancellation path, then have the operator cancel the test subscription and remove the workspace.');
  console.log('  4. Check the education offer at checkout separately; confirm the 50 percent discount is applied before the first payment.');
  console.log('  Never use real card details; see docs/e2e-hosted.md for the detailed run and teardown steps.');
}

function runSignupStage() {
  if (!STAGES.includes('signup')) return;
  if (!args['yes-test-mode']) {
    printManualSignupSteps('no --yes-test-mode flag; no signup or purchase was started');
    return;
  }
  if (!validStripeTestUrl(args['stripe-url'])) {
    printManualSignupSteps('--stripe-url is missing or is not checkout.stripe.com with a cs_test_ session; no signup or purchase was started');
    return;
  }
  if (!args.email || !args.slug) {
    printManualSignupSteps('--email and --slug are required by scripts/e2e-hosted.mjs; no signup or purchase was started');
    return;
  }
  check('PASS', 'signup test-mode guard', 'https://checkout.stripe.com/', 'provided URL host is checkout.stripe.com and contains cs_test_; the hosted e2e also checks its actual Checkout URL and badge');
  const childArgs = [
    path.join(ROOT, 'scripts/e2e-hosted.mjs'), '--stage', 'signup', '--allow-signup', '--plan', 'flat',
    '--site', SITE, '--api', API, '--email', args.email, '--slug', args.slug,
  ];
  if (args['link-file']) childArgs.push('--link-file', args['link-file']);
  const child = spawnSync(process.execPath, childArgs, { cwd: ROOT, stdio: 'inherit' });
  const ok = child.status === 0;
  check(ok ? 'PASS' : 'FAIL', 'existing hosted signup e2e', appendPath(SITE, '/signup'), child.error ? child.error.message : `exit status=${child.status ?? 'unknown'}; slug=${args.slug}`);
}

async function main() {
  let browser = null;
  const needsBrowser = STAGES.some((stage) => ['site', 'education', 'legal', 'demo'].includes(stage));
  if (needsBrowser) {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      check('FAIL', 'Playwright Chromium launch', DEMO, errorFact(error));
    }
  }
  try {
    await runSiteStages(browser);
    await runDemoStage(browser);
    await runApiStage();
    runSignupStage();
  } finally {
    await browser?.close();
  }
  const counts = Object.fromEntries(['PASS', 'FAIL', 'SKIP'].map((state) => [state.toLowerCase(), report.filter((entry) => entry.state === state).length]));
  console.log(`SUMMARY pass=${counts.pass} fail=${counts.fail} skip=${counts.skip}`);
  if (counts.fail) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  check('FAIL', 'pre-launch runner completed', SITE, errorFact(error));
  const counts = Object.fromEntries(['PASS', 'FAIL', 'SKIP'].map((state) => [state.toLowerCase(), report.filter((entry) => entry.state === state).length]));
  console.log(`SUMMARY pass=${counts.pass} fail=${counts.fail} skip=${counts.skip}`);
  process.exitCode = 1;
}
