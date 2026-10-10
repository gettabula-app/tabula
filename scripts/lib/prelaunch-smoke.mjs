const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function describeError(error) {
  const message = error?.message ?? String(error);
  return error?.cause?.message ? `${message}; cause=${error.cause.message}` : message;
}

export function findForbiddenPageText(text, { docs = false } = {}) {
  // the user guide explains what is not allowed (for example a localhost address), so it may say the word
  const rules = [
    ...(docs ? [] : [['localhost', /localhost/i]]),
    ['127.0.0.1', /127\.0\.0\.1/i],
    ['example.com', /example\.com/i],
    ['TODO', /\bTODO\b/i],
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

export function findLegalPlaceholders(text) {
  const rules = [
    ['TODO', /\bTODO\b/i],
    ['lorem', /lorem/i],
    ['[', /\[/],
    ['XXX', /XXX/i],
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function decodeXml(text) {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

export function parseSitemapXml(xml, baseUrl) {
  if (!/<(?:urlset|sitemapindex)\b/i.test(xml)) throw new Error('response is not a sitemap urlset or index');
  const locations = [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)].map((match) => decodeXml(match[1].trim()));
  if (!locations.length) throw new Error('sitemap contains no <loc> URLs');
  return [...new Set(locations.map((location) => new URL(location, baseUrl).href))];
}

export function parseRobotsTxt(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const sitemapUrls = lines
    .filter((line) => /^sitemap\s*:/i.test(line))
    .map((line) => line.replace(/^sitemap\s*:\s*/i, '').trim())
    .filter(Boolean);
  const allowsRoot = lines.some((line) => /^allow\s*:\s*\/$/i.test(line));
  return { sitemapUrls, allowsRoot };
}

function internalUrls(values, baseUrl) {
  const base = new URL(baseUrl);
  const urls = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim() || value.trim().startsWith('#')) continue;
    try {
      const url = new URL(value.trim(), base);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin === base.origin) {
        url.hash = '';
        urls.add(url.href);
      }
    } catch {
      // Invalid and non-URL values cannot be checked as internal resources.
    }
  }
  return [...urls];
}

/** @param {{ links?: string[], images?: string[] }} resources @param {string} baseUrl @returns {{ links: string[], images: string[] }} */
export function resolveInternalResources({ links = [], images = [] }, baseUrl) {
  return {
    links: internalUrls(links, baseUrl),
    images: internalUrls(images, baseUrl),
  };
}

function mentionsAmount(text, amount, period) {
  const amountPattern = new RegExp(`(?:€|\\bEUR\\s*)\\s*${amount}(?:[.,]00)?(?![\\d.,])`, 'gi');
  const periodPattern = new RegExp(`(?:\\b(?:${period})\\b|/\\s*(?:mo|month|yr|year))`, 'i');
  for (const match of text.matchAll(amountPattern)) {
    const surrounding = text.slice(Math.max(0, match.index - 15), match.index + match[0].length + 90);
    if (periodPattern.test(surrounding)) return true;
  }
  return false;
}

export function inspectFlatPricing(text) {
  const normalized = text.replace(/\s+/g, ' ').toLowerCase();
  const monthly = mentionsAmount(normalized, '29', 'month|monthly');
  const yearly = mentionsAmount(normalized, '290', 'year|yearly|annual|annually');
  const foundingAmount = /(?:€|\beur\s*)\s*19(?:[.,]00)?(?![\d.,])/i.test(normalized);
  const foundingPeriod = /\b12\s+months?\b|\bfirst\s+year\b/i.test(normalized);
  const foundingDeadline = /\b31\s+dec(?:ember)?\.?\s+2026\b/i.test(normalized);
  const perPersonOrSeat = /\bper\s+(?:person|seat)\b/i.test(normalized);
  return {
    monthly,
    yearly,
    founding: foundingAmount && foundingPeriod && foundingDeadline,
    foundingAmount,
    foundingPeriod,
    foundingDeadline,
    flat: !perPersonOrSeat,
  };
}

export function inspectEducationOffer(text) {
  const normalized = text.replace(/\s+/g, ' ');
  const halfPrice = /\bhalf price\b|\b50\s?%\s?(?:off|discount)?\b|\bfifty percent\b/i.test(normalized);
  const trialApplication = /(?:during|in|start(?:ing)? your)\s+(?:the\s+)?trial|trial.{0,100}(?:write|email|contact)/i.test(normalized)
    && /(?:write|email|contact).{0,120}(?:apply|discount|school|organisation|organization)|(?:apply|discount).{0,120}(?:trial|first payment)/i.test(normalized);
  return { halfPrice, trialApplication };
}

export async function requestFollowingRedirects(rawUrl, {
  fetchImpl = globalThis.fetch,
  maxRedirects = 8,
  timeoutMs = 15_000,
} = {}) {
  let current;
  try {
    current = new URL(rawUrl);
  } catch (error) {
    return { url: String(rawUrl), response: null, redirects: [], loop: false, error: describeError(error) };
  }
  const redirects = [];
  const seen = new Set();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = current.href;
    if (seen.has(url)) return { url, response: null, redirects, loop: true, error: 'redirect loop detected' };
    seen.add(url);
    let response;
    try {
      response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      return { url, response: null, redirects, loop: false, error: describeError(error) };
    }
    if (!REDIRECT_STATUSES.has(response.status)) return { url, response, redirects, loop: false, error: null };
    const location = response.headers.get('location');
    if (!location) return { url, response, redirects, loop: false, error: null };
    if (hop === maxRedirects) {
      await response.body?.cancel().catch(() => {});
      return { url, response: null, redirects, loop: true, error: `more than ${maxRedirects} redirects` };
    }
    let next;
    try {
      next = new URL(location, current);
    } catch (error) {
      return { url, response, redirects, loop: false, error: `invalid redirect location: ${describeError(error)}` };
    }
    redirects.push({ from: url, to: next.href, status: response.status });
    await response.body?.cancel().catch(() => {});
    current = next;
  }
  return { url: current.href, response: null, redirects, loop: true, error: `more than ${maxRedirects} redirects` };
}
