/**
 * v2 pipeline adapter: replays the v2 pipeline against the frozen corpus.
 *
 * Structured to mirror `v1.ts` exactly where the harness observes it — the same
 * corpus-miss-degrades-to-a-dead-result behaviour, the same `consideredUrls` /
 * `serpUrls` semantics, and no session key — so a v1-vs-v2 diff is a comparison
 * of ranking, not of harness plumbing.
 *
 * STRUCTURED SOURCES DURING A REPLAY
 * ----------------------------------
 * v2's biggest single source improvement is `fetch/stackexchange.ts`, which
 * reaches `api.stackexchange.com` and comes back with real vote counts and
 * accepted-answer flags — the signal `rank.ts` spends its `endorsement`
 * component on. That adapter cannot RUN during a replay: the corpus is frozen
 * and the run must stay offline, so calling an API mid-run would both break
 * reproducibility and violate the no-network rule.
 *
 * So the adapter runs at RECORD time instead, and its output is frozen into the
 * corpus's `docs/` directory next to the raw HTML (see `cache.ts`). This fetcher
 * prefers that recorded Doc when the corpus has one and parses the cached HTML
 * when it does not. Nothing here fetches; a structured Doc is just another thing
 * the corpus can hand back.
 *
 * The asymmetry with v1 — which reads HTML and only HTML — is deliberate and is
 * the measurement, not a flaw in it. On a corpus recorded WITHOUT structured
 * documents (the original `eval/corpus`) every Stack Exchange URL is a frozen
 * HTTP 403 with an empty body, and both pipelines degrade to a dead result on
 * it; `endorsement` therefore never fires and contributes nothing to that
 * scoreboard. On a corpus recorded WITH them, v2 can read those pages and v1
 * genuinely cannot, because no scraping fix reaches a host that refuses every
 * User-Agent. Numbers from the two corpora are not comparable to each other.
 */

import { Corpus, CorpusMissError } from "../cache";
import type { CachedPage } from "../cache";
import { parseHtml } from "../../v2/parse";
import { searchV2, resolveConfig } from "../../v2/pipeline";
import type { DocFetcher, V2Config } from "../../v2/pipeline";
import type { Doc } from "../../v2/types";
import type { Query, RunExcerpt, RunPage, RunQueryResult } from "../types";
import type { PipelineAdapter } from "../runner";

/**
 * `Corpus.getSerp`'s `maxResults` is consulted only when live-fetching; a
 * replay hit returns the full cached list. The pipeline applies its own
 * `maxCandidates` cap to that list, so this value only matters outside replay.
 */
const NO_SERP_CAP = 9999;

/** Replay never uses it (a cache hit resolves synchronously), but the signature wants one. */
const DEFAULT_TIMEOUT = 15000;

/**
 * A page is usable if the recorder actually got it: no transport error, a 2xx
 * status, and a non-empty body. Identical to the conditions v1's
 * `toScrapeResult` treats as a scrape failure, so neither pipeline gets to read
 * a page the other could not.
 */
function isUsablePage(page: CachedPage): boolean {
    if (page.error !== undefined) return false;
    if (page.status < 200 || page.status >= 300) return false;
    if (page.html.trim().length === 0) return false;
    return true;
}

/**
 * Build the document fetcher for one replayed query.
 *
 * A structured Doc recorded by a source adapter wins over the cached HTML for
 * the same URL — that is the whole point of recording one, and on Stack Exchange
 * it is the difference between a document with vote counts and a frozen 403.
 * An empty Doc is treated as no Doc, so a recording pass that captured a husk
 * still falls through to whatever HTML the corpus holds.
 *
 * Every failure mode — a corpus miss, an unreadable cache entry, a recorded
 * 403, HTML that parses to nothing — degrades to `null`, which the pipeline
 * treats as one unavailable page rather than a failed query. That matches both
 * v1's replay behaviour and what a live v2 run does when a fetch fails.
 */
function corpusFetcher(corpus: Corpus, timeout: number): DocFetcher {
    return async (url: string): Promise<Doc | null> => {
        const structured = corpus.readDoc(url);
        if (structured !== null && structured.doc.nodes.length > 0) {
            return structured.doc;
        }

        let page: CachedPage;
        try {
            page = await corpus.getPage(url, timeout);
        } catch (error) {
            if (error instanceof CorpusMissError) return null;
            return null;
        }

        if (!isUsablePage(page)) return null;

        try {
            const doc = parseHtml(page.html, url, {
                ...(page.finalUrl !== undefined ? { finalUrl: page.finalUrl } : {}),
            });
            return doc.nodes.length > 0 ? doc : null;
        } catch {
            // A parse failure is this page being unreadable, not the query
            // failing. Same disposition as a 403.
            return null;
        }
    };
}

/**
 * Create an adapter that runs the v2 pipeline from cached data.
 *
 * No session key is threaded through, deliberately and for the same reason v1's
 * adapter drops it: cross-query state would make one query's result depend on
 * another's, and a replay must be a pure function of (config, corpus, query).
 */
export function createV2Adapter(config: V2Config = {}): PipelineAdapter {
    const resolved = resolveConfig(config);

    return {
        name: "v2",
        config: resolved,

        async runQuery(query: Query, corpus: Corpus): Promise<RunQueryResult> {
            const start = performance.now();

            // A SERP miss is NOT degraded into a dead result: a query with no
            // search results has nothing to rank. It throws and is recorded as
            // a failed query by runner.ts, exactly as for v1 and oracle.
            const serp = await corpus.getSerp(query.text, "", NO_SERP_CAP, DEFAULT_TIMEOUT);
            const serpUrls = serp.results.map((result) => result.url);

            const result = await searchV2(
                query.text,
                serpUrls,
                corpusFetcher(corpus, DEFAULT_TIMEOUT),
                config,
            );

            const pages: RunPage[] = result.pages.map((page) => ({
                url: page.url,
                title: page.title,
                rank: page.rank,
                excerpts: page.excerpts.map(
                    (excerpt): RunExcerpt => ({
                        text: excerpt.text,
                        headingPath: excerpt.headingPath,
                        score: excerpt.score,
                    }),
                ),
                charCount: page.charCount,
            }));

            return {
                queryId: query.id,
                pages,
                // What the pipeline actually saw and could have chosen, before
                // its own ranking and budget narrowed it.
                consideredUrls: result.diagnostics.consideredUrls,
                serpUrls,
                totalChars: result.totalChars,
                durationMs: performance.now() - start,
                ...(serp.error !== undefined && { error: `serp fetch failed: ${serp.error}` }),
            };
        },
    };
}
