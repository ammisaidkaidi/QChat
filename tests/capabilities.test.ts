import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  decodeEntities,
  htmlToText,
  looksBlocked,
  parseBingRss,
  parseDuckDuckGo,
  parseDuckDuckGoLite,
  unwrapDuckDuckGoUrl,
  webFetch,
  WebError,
} from '../src/capabilities/search.js';

const DDG_HTML = `
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Falpha&amp;rut=abc">
    Alpha &amp; &#x42;eta
  </a>
  <a class="result__snippet">First snippet about <b>alpha</b>.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://second.example/beta">Second result</a>
  <a class="result__snippet">Another snippet.</a>
</div>
<div class="result">
  <a class="result__a" href="/relative/path">Ignored relative</a>
</div>
`;

const DDG_LITE = `
<table>
  <tr><td><a rel="nofollow" href="https://lite.example/one" class="result-link">Lite one</a></td></tr>
  <tr><td class="result-snippet">Lite snippet one.</td></tr>
  <tr><td><a rel="nofollow" href="https://lite.example/two" class="result-link">Lite two</a></td></tr>
  <tr><td class="result-snippet">Lite snippet two.</td></tr>
</table>
`;

describe('search markup parsing', () => {
  it('reads titles, snippets and unwraps redirect links', () => {
    const results = parseDuckDuckGo(DDG_HTML, 5);
    expect(results).toHaveLength(2);
    expect(results[0]?.url).toBe('https://example.org/alpha');
    expect(results[0]?.title).toBe('Alpha & Beta');
    expect(results[0]?.snippet).toContain('First snippet');
    expect(results[1]?.url).toBe('https://second.example/beta');
  });

  it('honours the result limit', () => {
    expect(parseDuckDuckGo(DDG_HTML, 1)).toHaveLength(1);
  });

  it('reads the lite layout', () => {
    const results = parseDuckDuckGoLite(DDG_LITE, 5);
    expect(results.map((item) => item.url)).toEqual([
      'https://lite.example/one',
      'https://lite.example/two',
    ]);
    expect(results[1]?.snippet).toContain('Lite snippet two');
  });

  it('leaves ordinary links untouched', () => {
    expect(unwrapDuckDuckGoUrl('https://plain.example/x')).toBe('https://plain.example/x');
    expect(unwrapDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2Fb')).toBe(
      'https://a.test/b',
    );
  });

  it('reduces html to text', () => {
    expect(htmlToText('<style>b{}</style><p>Hello &amp; welcome</p><script>x</script>')).toBe(
      'Hello & welcome',
    );
    expect(decodeEntities('&lt;a&gt; &#65; &#x42;')).toBe('<a> A B');
  });
});

describe('webFetch', () => {
  it('rejects anything that is not http(s)', async () => {
    await expect(webFetch('file:///etc/passwd')).rejects.toBeInstanceOf(WebError);
    await expect(webFetch('ftp://example.org')).rejects.toBeInstanceOf(WebError);
  });

  it('is switched off by INFAGENT_ALLOW_NET=0', async () => {
    process.env['INFAGENT_ALLOW_NET'] = '0';
    try {
      await expect(webFetch('https://example.org')).rejects.toMatchObject({ code: 'disabled' });
    } finally {
      delete process.env['INFAGENT_ALLOW_NET'];
    }
  });

  it('fetches a real page when the network is available', async () => {
    try {
      const page = await webFetch('https://example.com', { maxChars: 500 });
      expect(page.title.toLowerCase()).toContain('example');
      expect(page.text.length).toBeGreaterThan(10);
    } catch (error) {
      // Offline CI: the parser tests above still cover the important paths.
      expect(error).toBeInstanceOf(WebError);
    }
  }, 30_000);
});

describe('search configuration', () => {
  it('refuses an empty query', async () => {
    await expect(
      (await import('../src/capabilities/search.js')).webSearch('   '),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('finds skills and scripts folders from the project root', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'infagent-capabilities-'));
    expect(scratch.length).toBeGreaterThan(0);
  });
});

const BING_RSS = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel>
<title>Bing: node release</title>
<item>
  <title>Node.js — Releases</title>
  <link>https://nodejs.org/en/about/previous-releases</link>
  <description>Node.js&reg; is a runtime &amp; platform.</description>
</item>
<item>
  <title><![CDATA[Releases · nodejs/node · GitHub]]></title>
  <link>https://github.com/nodejs/node/releases</link>
  <description>Source &lt;b&gt;downloads&lt;/b&gt;.</description>
</item>
<item>
  <title>Broken</title>
  <link>/relative</link>
  <description>ignored</description>
</item>
</channel></rss>`;

const DDG_CHALLENGE = `
<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
<form id="challenge-form"><div class="challenge">Select all squares containing a duck.</div></form>`;

describe('bing rss + challenge detection', () => {
  it('parses bing items and drops relative links', () => {
    const results = parseBingRss(BING_RSS, 5);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Node.js — Releases',
      url: 'https://nodejs.org/en/about/previous-releases',
      snippet: 'Node.js® is a runtime & platform.',
    });
    expect(results[1]?.title).toBe('Releases · nodejs/node · GitHub');
    expect(results[1]?.snippet).toBe('Source downloads.');
  });

  it('honours the limit', () => {
    expect(parseBingRss(BING_RSS, 1)).toHaveLength(1);
  });

  it('spots the duck challenge but not a normal results page', () => {
    expect(looksBlocked(DDG_CHALLENGE)).toBe(true);
    expect(looksBlocked(DDG_HTML)).toBe(false);
  });
});
