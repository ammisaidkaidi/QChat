/**
 * Internet capabilities: web search and page fetching.
 *
 * No SDK and no API key is required. DuckDuckGo's HTML endpoint is tried first,
 * and Bing's RSS endpoint is used as a fallback because DuckDuckGo answers
 * datacenter IPs with a bot challenge. Brave and Tavily take over when their
 * keys are present, since they return cleaner data:
 *
 *   INFAGENT_SEARCH_PROVIDER  duckduckgo | bing | brave | tavily
 *   BRAVE_API_KEY             https://api.search.brave.com
 *   TAVILY_API_KEY            https://api.tavily.com
 *   INFAGENT_ALLOW_NET=0      switch every internet capability off
 *
 * Results are normalised to `{ title, url, snippet }` so the model sees the
 * same shape no matter which provider answered.
 */
import process from 'node:process';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchReport {
  provider: string;
  query: string;
  results: SearchResult[];
}

export interface WebPage {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export class WebError extends Error {
  public readonly code: 'disabled' | 'bad_request' | 'network' | 'http' | 'blocked';

  constructor(code: WebError['code'], message: string) {
    super(message);
    this.name = 'WebError';
    this.code = code;
  }
}

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 InfAgent';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;

/** Are internet capabilities allowed at all? */
export function netEnabled(): boolean {
  return process.env['INFAGENT_ALLOW_NET'] !== '0';
}

function requireNet(): void {
  if (!netEnabled()) {
    throw new WebError('disabled', 'Internet access is disabled (INFAGENT_ALLOW_NET=0).');
  }
}

/** Decode the handful of entities that show up in search results and pages. */
export function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    rsquo: '’',
    lsquo: '‘',
    ldquo: '“',
    rdquo: '”',
    laquo: '«',
    raquo: '»',
    reg: '®',
    copy: '©',
    trade: '™',
    deg: '°',
    middot: '·',
    bull: '•',
    euro: '€',
    pound: '£',
  };

  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

/** Strip tags/scripts/styles and collapse whitespace — enough for text models. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return (
    decodeEntities(stripped)
      // Feeds escape their markup (`&lt;b&gt;`), so a second pass is needed
      // once the entities have been decoded.
      .replace(/<\/?[a-z][^>]{0,400}>/gi, ' ')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^[ \t]+|[ \t]+$/gm, '')
      // Stripping an inline tag leaves a space before the punctuation it wrapped.
      .replace(/ +([,.;:!?%)\]])(?=\s|$)/g, '$1')
      .trim()
  );
}

/** The `<title>` of a page, if it has one. */
function pageTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : '';
}

/** GET with a timeout, a byte cap and a browser-ish user agent. */
async function getText(url: string, init: RequestInit = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'en,fr;q=0.8',
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw new WebError('http', `${response.status} ${response.statusText} for ${url}`);
    }

    const reader = response.body?.getReader();
    if (!reader) return await response.text();

    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value?.byteLength ?? 0;
      text += decoder.decode(value, { stream: true });
      if (bytes >= MAX_BYTES) break;
    }
    return text;
  } catch (error) {
    if (error instanceof WebError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new WebError('network', `Could not reach ${url}: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Unwrap DuckDuckGo's `/l/?uddg=<encoded>` redirect links. */
export function unwrapDuckDuckGoUrl(href: string): string {
  const cleaned = decodeEntities(href.trim());
  // Wrapped results look like `/l/?uddg=<encoded target>`; anything else is
  // returned verbatim so the caller can reject relative links.
  const target = /[?&]uddg=([^&]+)/.exec(cleaned)?.[1];
  if (target) {
    try {
      return decodeURIComponent(target);
    } catch {
      return target;
    }
  }
  return cleaned;
}

/**
 * Pull `<a>` tags out of a page, whatever order their attributes are in.
 *
 * Search markup varies (class before href, href before class, extra rel/data
 * attributes); scanning the tags and testing them individually is far more
 * robust than one rigid pattern.
 */
function anchors(html: string, classToken: string): { href: string | null; text: string }[] {
  const found: { href: string | null; text: string }[] = [];
  const tag = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    const attributes = match[1] ?? '';
    const classAttribute = /class\s*=\s*"([^"]*)"/i.exec(attributes)?.[1] ?? '';
    if (!classAttribute.includes(classToken)) continue;
    const href = /href\s*=\s*"([^"]*)"/i.exec(attributes)?.[1] ?? null;
    found.push({ href, text: htmlToText(match[2] ?? '') });
  }

  return found;
}

/** Absolute http(s) URLs only — relative links are navigation, not results. */
function usableUrl(href: string | null): string | null {
  if (!href) return null;
  const url = unwrapDuckDuckGoUrl(href);
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Parse the `html.duckduckgo.com` result page.
 *
 * Exported for tests: the markup is regular enough to be handled with a couple
 * of regexes, which keeps the toolkit free of an HTML parsing dependency.
 */
export function parseDuckDuckGo(html: string, limit = 5): SearchResult[] {
  const snippets = anchors(html, 'result__snippet').map((anchor) => anchor.text);
  const results: SearchResult[] = [];

  anchors(html, 'result__a').some((anchor, index) => {
    const url = usableUrl(anchor.href);
    if (!url || !anchor.text) return false;
    results.push({ title: anchor.text, url, snippet: snippets[index] ?? '' });
    return results.length >= limit;
  });

  return results;
}

/** Parse the lighter `lite.duckduckgo.com` table layout, used as a fallback. */
export function parseDuckDuckGoLite(html: string, limit = 5): SearchResult[] {
  const snippetPattern = /<td[^>]*class\s*=\s*"[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
  const snippets: string[] = [];
  for (let match = snippetPattern.exec(html); match; match = snippetPattern.exec(html)) {
    snippets.push(htmlToText(match[1] ?? ''));
  }

  const results: SearchResult[] = [];
  anchors(html, 'result-link').some((anchor, index) => {
    const url = usableUrl(anchor.href);
    if (!url || !anchor.text) return false;
    results.push({ title: anchor.text, url, snippet: snippets[index] ?? '' });
    return results.length >= limit;
  });

  return results;
}

/**
 * DuckDuckGo answers automated-looking traffic with a "select all squares
 * containing a duck" challenge and an HTTP 202 instead of results. Detecting it
 * lets the caller fall through to another provider instead of reporting
 * "no results" for a query that was never actually run.
 */
export function looksBlocked(html: string): boolean {
  return (
    /anomaly-modal|challenge-form|"challenge"|Select all squares containing/i.test(html) ||
    /unfortunately, bots use duckduckgo too/i.test(html)
  );
}

/**
 * Parse Bing's RSS output (`?format=rss`), the keyless fallback provider.
 * Items carry `<title>`, `<link>` and `<description>`.
 */
export function parseBingRss(xml: string, limit = 5): SearchResult[] {
  const results: SearchResult[] = [];
  const item = /<item>([\s\S]*?)<\/item>/gi;

  for (let match = item.exec(xml); match && results.length < limit; match = item.exec(xml)) {
    const block = match[1] ?? '';
    const field = (tag: string): string => {
      const found = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block)?.[1] ?? '';
      return htmlToText(found.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
    };

    const url = field('link');
    const title = field('title');
    if (!/^https?:\/\//i.test(url) || !title) continue;
    results.push({ title, url, snippet: field('description') });
  }

  return results;
}

async function searchBing(query: string, limit: number): Promise<SearchResult[]> {
  const xml = await getText(
    `https://www.bing.com/search?${new URLSearchParams({ q: query, format: 'rss' }).toString()}`,
    { headers: { accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8' } },
  );
  return parseBingRss(xml, limit);
}

async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  const body = new URLSearchParams({ q: query, kl: 'wt-wt' });
  const html = await getText('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const results = parseDuckDuckGo(html, limit);
  if (results.length > 0) return results;
  if (looksBlocked(html)) {
    throw new WebError('blocked', 'DuckDuckGo served a bot challenge instead of results.');
  }

  const lite = await getText(
    `https://lite.duckduckgo.com/lite/?${new URLSearchParams({ q: query }).toString()}`,
  );
  if (looksBlocked(lite)) {
    throw new WebError('blocked', 'DuckDuckGo served a bot challenge instead of results.');
  }
  return parseDuckDuckGoLite(lite, limit);
}

async function searchBrave(query: string, limit: number, key: string): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({
    q: query,
    count: String(limit),
  }).toString()}`;
  const raw = await getText(url, {
    headers: { accept: 'application/json', 'x-subscription-token': key },
  });
  const payload = JSON.parse(raw) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };

  return (payload.web?.results ?? [])
    .slice(0, limit)
    .map((item) => ({
      title: htmlToText(item.title ?? ''),
      url: item.url ?? '',
      snippet: htmlToText(item.description ?? ''),
    }))
    .filter((item) => item.url.startsWith('http'));
}

async function searchTavily(query: string, limit: number, key: string): Promise<SearchResult[]> {
  const raw = await getText('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: limit, search_depth: 'basic' }),
  });
  const payload = JSON.parse(raw) as {
    results?: { title?: string; url?: string; content?: string }[];
  };

  return (payload.results ?? [])
    .slice(0, limit)
    .map((item) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: htmlToText(item.content ?? ''),
    }))
    .filter((item) => item.url.startsWith('http'));
}

/**
 * Search the web.
 *
 * Order: the provider named in `INFAGENT_SEARCH_PROVIDER` (or the `provider`
 * option), then any key-backed provider, then DuckDuckGo, then Bing's RSS.
 * A provider that errors out or comes back empty hands over to the next one.
 */
export async function webSearch(
  query: string,
  options: { limit?: number; provider?: string } = {},
): Promise<SearchReport> {
  requireNet();
  const cleaned = query.trim();
  if (!cleaned) throw new WebError('bad_request', 'A search query is required.');

  const limit = Math.min(Math.max(options.limit ?? 5, 1), 10);
  const brave = process.env['BRAVE_API_KEY'];
  const tavily = process.env['TAVILY_API_KEY'];
  const requested = (options.provider ?? process.env['INFAGENT_SEARCH_PROVIDER'] ?? '')
    .toLowerCase()
    .trim();

  const keyless: { provider: string; run: () => Promise<SearchResult[]> }[] = [
    { provider: 'duckduckgo', run: () => searchDuckDuckGo(cleaned, limit) },
    { provider: 'bing', run: () => searchBing(cleaned, limit) },
  ];

  const keyed: { provider: string; run: () => Promise<SearchResult[]> }[] = [];
  if (tavily) keyed.push({ provider: 'tavily', run: () => searchTavily(cleaned, limit, tavily) });
  if (brave) keyed.push({ provider: 'brave', run: () => searchBrave(cleaned, limit, brave) });

  const byName = [...keyed, ...keyless];
  const attempts = [
    ...(requested ? byName.filter((entry) => entry.provider === requested) : []),
    ...keyed.filter((entry) => entry.provider !== requested),
    ...keyless.filter((entry) => entry.provider !== requested),
  ];

  let lastError: unknown = null;
  let lastEmpty: { provider: string; results: SearchResult[] } | null = null;
  for (const attempt of attempts) {
    try {
      const results = await attempt.run();
      if (results.length > 0) return { provider: attempt.provider, query: cleaned, results };
      lastEmpty = { provider: attempt.provider, results };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastEmpty)
    return { provider: lastEmpty.provider, query: cleaned, results: lastEmpty.results };
  if (lastError instanceof WebError) throw lastError;
  throw new WebError(
    'network',
    `Search failed: ${lastError instanceof Error ? lastError.message : 'every provider refused'}`,
  );
}

/** Fetch a page and reduce it to readable text. */
export async function webFetch(url: string, options: { maxChars?: number } = {}): Promise<WebPage> {
  requireNet();
  const target = url.trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new WebError('bad_request', 'Only http(s) URLs can be fetched.');
  }

  const maxChars = Math.min(Math.max(options.maxChars ?? 4000, 500), 20_000);
  const html = await getText(target);
  const text = htmlToText(html);
  const truncated = text.length > maxChars;

  return {
    url: target,
    title: pageTitle(html),
    text: truncated ? `${text.slice(0, maxChars)}… (truncated)` : text,
    truncated,
  };
}
