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
export declare class WebError extends Error {
    readonly code: 'disabled' | 'bad_request' | 'network' | 'http' | 'blocked';
    constructor(code: WebError['code'], message: string);
}
/** Are internet capabilities allowed at all? */
export declare function netEnabled(): boolean;
/** Decode the handful of entities that show up in search results and pages. */
export declare function decodeEntities(text: string): string;
/** Strip tags/scripts/styles and collapse whitespace — enough for text models. */
export declare function htmlToText(html: string): string;
/** Unwrap DuckDuckGo's `/l/?uddg=<encoded>` redirect links. */
export declare function unwrapDuckDuckGoUrl(href: string): string;
/**
 * Parse the `html.duckduckgo.com` result page.
 *
 * Exported for tests: the markup is regular enough to be handled with a couple
 * of regexes, which keeps the toolkit free of an HTML parsing dependency.
 */
export declare function parseDuckDuckGo(html: string, limit?: number): SearchResult[];
/** Parse the lighter `lite.duckduckgo.com` table layout, used as a fallback. */
export declare function parseDuckDuckGoLite(html: string, limit?: number): SearchResult[];
/**
 * DuckDuckGo answers automated-looking traffic with a "select all squares
 * containing a duck" challenge and an HTTP 202 instead of results. Detecting it
 * lets the caller fall through to another provider instead of reporting
 * "no results" for a query that was never actually run.
 */
export declare function looksBlocked(html: string): boolean;
/**
 * Parse Bing's RSS output (`?format=rss`), the keyless fallback provider.
 * Items carry `<title>`, `<link>` and `<description>`.
 */
export declare function parseBingRss(xml: string, limit?: number): SearchResult[];
/**
 * Search the web.
 *
 * Order: the provider named in `INFAGENT_SEARCH_PROVIDER` (or the `provider`
 * option), then any key-backed provider, then DuckDuckGo, then Bing's RSS.
 * A provider that errors out or comes back empty hands over to the next one.
 */
export declare function webSearch(query: string, options?: {
    limit?: number;
    provider?: string;
}): Promise<SearchReport>;
/** Fetch a page and reduce it to readable text. */
export declare function webFetch(url: string, options?: {
    maxChars?: number;
}): Promise<WebPage>;
//# sourceMappingURL=search.d.ts.map