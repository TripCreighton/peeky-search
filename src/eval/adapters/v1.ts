/**
 * v1 pipeline adapter: replays the EXISTING MCP search pipeline against a
 * frozen corpus.
 *
 * This adapter is the baseline every v2 comparison is measured against, so it
 * calls the real `searchStructured()` rather than reimplementing any of its
 * stages. The only thing swapped out is I/O: `fetchSerp` and `fetchPages` are
 * wired to the corpus instead of SearXNG and the live scraper. Every filter,
 * threshold, ranking rule and budget decision is v1's own code.
 */

import { searchStructured, type SearchOptions } from "../../mcp/orchestrator";
import { DEFAULT_CONFIG } from "../../mcp/types";
import type { SearchConfig, SearxngResult, ScrapeResult } from "../../mcp/types";
import { CorpusMissError } from "../cache";
import type { CachedPage, Corpus } from "../cache";
import type { Query, RunPage, RunQueryResult } from "../types";
import type { PipelineAdapter } from "../runner";

/**
 * Map a cached page to what the live scraper would have produced for it.
 *
 * The live scraper (`src/mcp/scraper.ts`) returns `{ url, html: null, error }`
 * for a non-2xx response, a non-HTML content type, or a transport failure.
 * Mirroring that here means v1's failure handling is exercised identically on
 * replay — a page that would have failed live still fails, and still produces
 * a `scrape_failed` diagnostic rather than being silently extracted.
 */
function toScrapeResult(page: CachedPage, url: string): ScrapeResult {
    if (page.error !== undefined) {
        return { url, html: null, error: page.error };
    }

    if (page.status < 200 || page.status >= 300) {
        return { url, html: null, error: `HTTP ${page.status}` };
    }

    const contentType = page.contentType;
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
        return { url, html: null, error: `Non-HTML content type: ${contentType}` };
    }

    return { url, html: page.html };
}

/**
 * Read one page from the corpus, degrading a miss into a dead result.
 *
 * A page that is not in the corpus is treated exactly like a page that could
 * not be scraped: one dead result among several, not a failed query. The
 * recorder legitimately fails on a meaningful fraction of URLs (403s, bot
 * walls, timeouts), and in production v1 handles an unfetchable page the same
 * way. Zeroing a whole query because one of its five pages is missing would
 * make the baseline pessimistic for reasons unrelated to v1's ranking.
 *
 * A SERP miss is deliberately NOT degraded this way - a query with no search
 * results has nothing to score at all.
 */
async function fetchOnePage(corpus: Corpus, url: string, timeout: number): Promise<ScrapeResult> {
    try {
        const page = await corpus.getPage(url, timeout);
        return toScrapeResult(page, url);
    } catch (error) {
        if (error instanceof CorpusMissError) {
            return { url, html: null, error: `corpus miss: ${url}` };
        }
        // A corrupt or unreadable cache entry is an infrastructure problem, not
        // a retrieval outcome - keep it visible rather than filing it as a miss.
        return {
            url,
            html: null,
            error: `corpus read failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

/**
 * Build the SearchOptions for a replay, copying only the keys the caller set.
 *
 * `sessionKey` is deliberately never forwarded: v1's session cache has a 10s
 * TTL and would let one query's results perturb the next one's within a single
 * run, which would make the baseline depend on wall-clock timing.
 */
function baseOptions(config: Partial<SearchConfig>): SearchOptions {
    const options: SearchOptions = {};
    if (config.searxngUrl !== undefined) options.searxngUrl = config.searxngUrl;
    if (config.maxResults !== undefined) options.maxResults = config.maxResults;
    if (config.timeout !== undefined) options.timeout = config.timeout;
    if (config.perPageCharBudget !== undefined) options.perPageCharBudget = config.perPageCharBudget;
    if (config.totalCharBudget !== undefined) options.totalCharBudget = config.totalCharBudget;
    return options;
}

/**
 * Create an adapter that runs the v1 search pipeline from cached data.
 */
export function createV1Adapter(config: Partial<SearchConfig> = {}): PipelineAdapter {
    // sessionKey is dropped on purpose (see baseOptions) - record what we
    // actually ran with, not what was passed in.
    const effectiveConfig = baseOptions(config);
    const searxngUrl = config.searxngUrl ?? DEFAULT_CONFIG.searxngUrl;
    const timeout = config.timeout ?? DEFAULT_CONFIG.timeout;

    return {
        name: "v1",
        config: effectiveConfig,

        async runQuery(query: Query, corpus: Corpus): Promise<RunQueryResult> {
            const start = performance.now();

            // Every URL the SERP handed to the pipeline, before v1 dedupes,
            // blocks, title-filters or budget-trims anything. Retrieval metrics
            // need to know what was available and rejected, not just what came
            // back.
            const consideredUrls: string[] = [];

            // The full, untruncated SERP. Distinguishes "the search engine
            // never surfaced this source" from "v1's own filtering dropped it".
            // Left undefined if the SERP itself was never fetched.
            let serpUrls: string[] | undefined;

            const options: SearchOptions = {
                ...baseOptions(config),

                fetchSerp: async (searchQuery: string, maxResults: number): Promise<SearxngResult[]> => {
                    const serp = await corpus.getSerp(searchQuery, searxngUrl, maxResults, timeout);
                    serpUrls = serp.results.map((r) => r.url);
                    // Same slice the live SearXNG client applies to its response.
                    const results = serp.results.slice(0, maxResults).map((r) => ({
                        url: r.url,
                        title: r.title,
                        content: r.content,
                        score: r.score,
                        engine: r.engine,
                    }));
                    for (const r of results) {
                        consideredUrls.push(r.url);
                    }
                    return results;
                },

                fetchPages: async (urls: string[]): Promise<ScrapeResult[]> => {
                    // Sequential and in input order. The live scraper resolves
                    // in completion order, but v1 sorts pages by relevance
                    // before emitting them, so ordering here cannot change the
                    // output - and fixing it keeps replays deterministic.
                    const results: ScrapeResult[] = [];
                    for (const url of urls) {
                        results.push(await fetchOnePage(corpus, url, timeout));
                    }
                    return results;
                },
            };

            const result = await searchStructured(query.text, options);

            const pages: RunPage[] = result.pages.map((page, index) => ({
                url: page.url,
                title: page.title,
                rank: index + 1,
                excerpts: page.excerpts.map((e) => ({
                    text: e.text,
                    headingPath: e.headingPath,
                    score: e.score,
                })),
                charCount: page.totalChars,
            }));

            return {
                queryId: query.id,
                pages,
                consideredUrls,
                ...(serpUrls !== undefined && { serpUrls }),
                totalChars: result.totalChars,
                durationMs: performance.now() - start,
                // A SearXNG failure or an empty SERP short-circuits v1 before
                // extraction; surface that as a query-level error.
                ...(result.earlyExit !== undefined && { error: result.earlyExit }),
            };
        },
    };
}
