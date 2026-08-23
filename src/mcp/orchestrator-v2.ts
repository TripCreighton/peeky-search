/**
 * v2 search orchestration for the MCP server.
 *
 * Deliberately thin. `src/eval/adapters/v2.ts` — the thing every measured
 * number describes — hands raw SERP URLs straight to `searchV2` with no
 * deduplication, no blocked-domain list, and no pre-scrape relevance filter.
 * Adding v1's front half here would mean the MCP served a pipeline the harness
 * had never scored, which is precisely the gap that made the live HTML adapter
 * diverge from the eval for as long as it did. So this path stays equal to the
 * measured one, and the only thing layered on top is session deduplication —
 * cross-call state about what the caller has already seen, not a judgement
 * about page quality.
 *
 * v1's `search()` in `orchestrator.ts` is untouched. It is no longer served to
 * anyone, but `src/eval/adapters/v1.ts` injects fetchers into it to reproduce
 * the baseline, and a baseline you cannot re-run is not a baseline.
 */

import { searchSearxng } from "./searxng";
import { parseSearchOperators } from "./query-parser";
import { addUrlsToSession, filterSessionUrls } from "./orchestrator";
import { tokenize } from "../preprocessing/tokenize";
import { fetchDoc } from "../v2/fetch/resolver";
import { resolveConfig, searchV2 } from "../v2/pipeline";
import { buildPassages } from "../v2/passages";
import type { V2Page, V2Result } from "../v2/pipeline";
import { DEFAULT_CONFIG } from "./types";
import Logger from "../utils/logger";

const logger = Logger.getInstance();

export interface SearchV2Options {
    maxResults?: number;
    searxngUrl?: string;
    timeout?: number;
    sessionKey?: string;
    debug?: boolean;
}

/**
 * SearXNG is asked for more than `maxResults` because v2 drops documents that
 * fail to fetch or bottom out on authority, and a short candidate list starves
 * the ranker rather than making it choosier.
 *
 * The floor matters more than the multiplier. The pipeline reads `maxCandidates`
 * (16) URLs deep, and that depth is not free choice — it is where the measured
 * recall curve stops paying for itself (see `DEFAULTS` in `pipeline.ts`: depth 8
 * scores 0.495 and depth 16 scores 0.556 on tranche 1). Asking SearXNG for only
 * `2 * maxResults` would hand the pipeline 10 candidates by default and quietly
 * run a shallower search than the one every published number describes.
 */
const REQUEST_MULTIPLIER = 2;

/** The MCP tool documents a ceiling of 10; a caller can still pass anything. */
const MAX_RESULTS_CEILING = 10;

export async function searchV2Mcp(query: string, opts: SearchV2Options = {}): Promise<string> {
    const requested = opts.maxResults ?? DEFAULT_CONFIG.maxResults;
    const maxResults = Math.min(Math.max(Math.floor(requested), 1), MAX_RESULTS_CEILING);
    const pipelineDefaults = resolveConfig({});
    const searxngUrl = opts.searxngUrl ?? DEFAULT_CONFIG.searxngUrl;
    const timeout = opts.timeout ?? DEFAULT_CONFIG.timeout;
    const debug = opts.debug ?? false;

    // site: and friends belong in the SearXNG query but not in the text v2
    // ranks against, or the operator tokens pollute the match.
    const { searchQuery, extractionQuery } = parseSearchOperators(query);

    let serp;
    try {
        serp = await searchSearxng(searchQuery, {
            baseUrl: searxngUrl,
            maxResults: Math.max(maxResults * REQUEST_MULTIPLIER, pipelineDefaults.maxCandidates),
            timeout,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        return `Error searching SearXNG: ${message}`;
    }

    if (serp.length === 0) {
        return (
            `No search results for: "${query}"\n\n` +
            "SearXNG's upstream engines rate-limit under sustained use and then " +
            "answer with an empty list rather than an error. If this repeats, " +
            "check `docker logs peeky-searxng`."
        );
    }

    const queryTokens = tokenize(extractionQuery);
    const { newUrls, skippedUrls } = filterSessionUrls(
        opts.sessionKey,
        serp.map((r) => r.url),
        queryTokens
    );

    if (newUrls.length === 0) {
        return (
            `All ${skippedUrls.length} results for "${query}" were already fetched in this session.\n` +
            "Vary the query terms to reach different pages."
        );
    }

    let result: V2Result;
    try {
        // `maxResults` is a cap on PAGES RETURNED, which lives in the assembly
        // budget — not on URLs considered. Without this the parameter silently
        // does nothing: assembly's own `maxDocs` of 5 decides, so asking for 3
        // returns 5 and asking for 10 also returns 5.
        result = await searchV2(extractionQuery, newUrls, (url) => fetchDoc(url), {
            budget: { maxDocs: maxResults },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        return `Error extracting results: ${message}`;
    }

    if (opts.sessionKey !== undefined) {
        addUrlsToSession(
            opts.sessionKey,
            result.pages.map((p) => p.url),
            queryTokens
        );
    }

    logger.debug(
        `v2: ${serp.length} serp -> ${newUrls.length} considered -> ${result.pages.length} pages, ${result.totalChars} chars`,
        debug
    );

    return formatForMcp(query, result, skippedUrls.length);
}

/**
 * Render for a model reading mid-task.
 *
 * Every page leads with its URL so a follow-up fetch has something to use, and
 * heading paths are kept because they say where in the document an excerpt came
 * from — the difference between a note in a migration guide and the same words
 * in a changelog entry.
 */
function formatForMcp(query: string, result: V2Result, skipped: number): string {
    if (result.pages.length === 0) {
        return (
            `No usable content found for: "${query}"\n\n` +
            "Every candidate page either failed to fetch or carried no extractable article."
        );
    }

    const out: string[] = [];
    out.push(`${result.pages.length} pages for "${query}"`);
    if (skipped > 0) out.push(`(${skipped} already fetched this session, skipped)`);
    out.push("");

    for (const page of result.pages) {
        out.push("---");
        out.push("");
        out.push(`## [${page.title || page.url}](${page.finalUrl ?? page.url})`);
        out.push("");
        for (const excerpt of page.excerpts) {
            // The excerpt text already opens with its own heading, so printing
            // the full path repeats it. Show the ancestors only — they are what
            // says where in the document this sits.
            const ancestors = excerpt.headingPath.slice(0, -1);
            if (ancestors.length > 0) out.push(`> ${ancestors.join(" > ")}`);
            out.push(excerpt.text);
            out.push("");
        }
    }

    return out.join("\n");
}

/** v1 used 12,000 for a single page; kept so behaviour does not change under callers. */
const FETCH_PAGE_CHAR_BUDGET = 12000;

export interface FetchPageV2Options {
    query?: string;
    charBudget?: number;
}

/**
 * Fetch and read one page, through v2's source resolver.
 *
 * The reason to migrate this off v1 is capability, not scoring. v1's fetchPage
 * calls `scrapeUrls`, which is a raw HTML GET — so it simply cannot read the
 * pages people most often want to follow up on. stackoverflow.com answers every
 * scraper with 403; GitHub serves repo pages as JS. v2 resolves those through
 * the Stack Exchange and GitHub APIs, npm's registry, and markdown siblings, so
 * a URL that returned "Error fetching …" now returns the answer.
 *
 * With a query, the page goes through the same `searchV2` used by search, so
 * ranking and assembly match. Without one, the whole readable document is
 * returned in document order up to the budget.
 */
export async function fetchPageV2(url: string, opts: FetchPageV2Options = {}): Promise<string> {
    const charBudget = opts.charBudget ?? FETCH_PAGE_CHAR_BUDGET;

    let doc;
    try {
        doc = await fetchDoc(url);
    } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        return `Error fetching ${url}: ${message}`;
    }
    if (doc === null) {
        return `Error fetching ${url}: no source adapter could retrieve a readable document.`;
    }

    const title = doc.title !== "" ? doc.title : url;

    if (opts.query !== undefined && opts.query.trim() !== "") {
        // Hand searchV2 the document already in hand rather than letting it
        // fetch again.
        const result = await searchV2(opts.query, [url], async () => doc);
        const page = result.pages[0];
        if (page === undefined || page.excerpts.length === 0) {
            return `# ${title}\nSource: ${url}\n\nNo content matched "${opts.query}" on this page.`;
        }
        const out = [`# ${title}`, `Source: ${page.finalUrl ?? url}`, ""];
        for (const excerpt of page.excerpts) {
            const ancestors = excerpt.headingPath.slice(0, -1);
            if (ancestors.length > 0) out.push(`> ${ancestors.join(" > ")}`);
            out.push(excerpt.text);
            out.push("");
        }
        return out.join("\n");
    }

    // No query: the readable document, in document order, until the budget runs out.
    const passages = buildPassages(doc);
    const out = [`# ${title}`, `Source: ${doc.finalUrl ?? url}`, ""];
    let used = 0;
    let truncated = false;
    for (const passage of passages) {
        if (used + passage.charCount > charBudget) {
            truncated = true;
            break;
        }
        out.push(passage.text);
        out.push("");
        used += passage.charCount;
    }
    if (used === 0) return `# ${title}\nSource: ${url}\n\nNo readable content extracted.`;
    if (truncated) out.push(`_(truncated at ${charBudget} characters)_`);
    return out.join("\n");
}

/** Page-level summary, for callers that want structure rather than prose. */
export function summarizePages(pages: V2Page[]): Array<{ url: string; title: string; chars: number }> {
    return pages.map((p) => ({ url: p.finalUrl ?? p.url, title: p.title, chars: p.charCount }));
}
