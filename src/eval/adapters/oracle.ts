/**
 * oracle pipeline adapter: measures the CEILING of what any pipeline could
 * achieve on this corpus.
 *
 * This is not a candidate pipeline - it is a yardstick. For every query it
 * returns EVERYTHING the corpus has: every successfully-fetched SERP page's
 * full extracted text, with no ranking, filtering, quality gate, or budget.
 * A query's nugget recall under oracle is the maximum any real pipeline
 * could ever reach on this corpus: if oracle misses a nugget, no ranking or
 * budget change can recover it, because the fact is not present in any page
 * any pipeline could have read.
 *
 * Parser
 * ------
 * The oracle reads pages with the V2 PARSER (`parseHtml`), not v1's
 * preprocess+segment - and, when the corpus recorded one, with the STRUCTURED
 * DOCUMENT a source adapter produced in preference to the raw HTML. Both
 * choices follow from the same rule: the oracle must answer "what does this
 * corpus contain", so it reads each entry the best way the corpus allows. A
 * corpus recorded with the Stack Exchange adapter active holds real answer
 * bodies for URLs whose frozen HTML is an empty 403; measuring the ceiling from
 * that HTML would report a corpus gap where there is content sitting on disk.
 *
 * This is also why the oracle's numbers move between corpora and must never be
 * compared across them. v1's
 * class-pattern boilerplate rules delete whole documents (its `/comment/`
 * pattern removes every answer on a discussion page; its `/nav/` pattern
 * matches `id="belowtopnav"` and removes an entire w3schools reference
 * page), and v1 cannot see tables at all. A ceiling measured through v1's
 * parser is v1's-parser ceiling, not the corpus ceiling. The oracle must
 * answer "what does the corpus contain", so it uses the parser that reads
 * the most of it.
 *
 * Excerpt granularity
 * --------------------
 * `matchNuggetInExcerpt` (see nuggets.ts) requires every anchor group - and
 * the `window` distance constraint - to be satisfied within a SINGLE
 * excerpt's text. A nugget whose anchors straddle two excerpts is scored as
 * a miss even when the fact is right there on the page. To keep the oracle's
 * OWN splitting choice from ever manufacturing a false miss (as opposed to a
 * genuine corpus gap), each surviving page contributes:
 *
 *   1. One excerpt per heading-anchored node run - all nodes from one
 *      heading (or the top of the document) up to the next heading. This is
 *      a reasonable, human-legible granularity that mirrors how `dump`
 *      renders pages for labeling. Deliberately NOT `buildPassages`: that
 *      caps a passage at 900 characters, and a cap splits mid-section,
 *      which is exactly the manufactured-miss risk this granularity exists
 *      to avoid.
 *   2. One final excerpt containing the ENTIRE page's rendered text, so a
 *      nugget whose anchors happen to fall on either side of one of our
 *      section boundaries is still matchable. `window` still bounds how far
 *      apart a nugget's anchors may be, so this whole-page excerpt does not
 *      relax matching - it only removes the possibility that OUR split point
 *      (rather than the nugget's own window) is what caused a miss.
 *
 * The union of excerpts therefore always covers the whole extracted
 * document, per-page and per-section excerpts are duplicated inside the
 * final whole-page excerpt. `RunPage.charCount` is intentionally the length
 * of the extracted text ONCE (not the sum of excerpt lengths), so that
 * `totalChars` / `avgChars` report how much text is actually available
 * rather than being inflated by this safety duplication.
 */

import { parseHtml } from "../../v2/parse";
import type { Doc, DocNode } from "../../v2/types";
import type { CachedPage, Corpus } from "../cache";
import type { Query, RunExcerpt, RunPage, RunQueryResult } from "../types";
import type { PipelineAdapter } from "../runner";

/** Corpus.getPage/getSerp signatures take a timeout, but replay mode never
 * actually uses it (a cache hit returns synchronously); kept only so the
 * adapter's config is meaningful if oracle is ever pointed at "record"
 * mode. */
const DEFAULT_TIMEOUT = 15000;

/**
 * Corpus.getSerp's `maxResults` is only consulted when live-fetching
 * (record/refresh mode); a replay hit returns the FULL cached result list
 * regardless. Oracle wants every URL the corpus ever saw for this query, so
 * this value only matters if oracle is ever run outside replay mode.
 */
const NO_SERP_CAP = 9999;

export interface OracleConfig {
    timeout?: number;
}

/**
 * Read one page from the corpus, degrading any failure (a corpus miss, or a
 * corrupt/unreadable cache entry) into "unavailable" rather than crashing
 * the query. Mirrors v1's `fetchOnePage` in spirit: a page a pipeline could
 * never have read is not a reason to fail every other page in the SERP.
 */
async function readPageSafe(corpus: Corpus, url: string, timeout: number): Promise<CachedPage | null> {
    try {
        return await corpus.getPage(url, timeout);
    } catch {
        return null;
    }
}

/**
 * A page is usable if it was actually fetched successfully: no transport
 * error, a 2xx status, and non-empty HTML. These are the same conditions
 * v1's `toScrapeResult` treats as a scrape failure - pages that fail them
 * are genuinely unavailable to any pipeline replaying this corpus, not just
 * to oracle.
 */
function isUsablePage(page: CachedPage): boolean {
    if (page.error !== undefined) return false;
    if (page.status < 200 || page.status >= 300) return false;
    if (page.html.trim().length === 0) return false;
    return true;
}

/**
 * Render one v2 node as the markdown-ish text a labeler sees in `dump`.
 *
 * Shared with the `dump` command (which imports `renderNodesAsMarkdown`) so
 * that the text a nugget is authored against and the text the oracle matches
 * it in are the same string, character for character.
 */
export function renderNodeText(node: DocNode): string {
    switch (node.kind) {
        case "heading": {
            const level = node.level ?? 1;
            return `${"#".repeat(level)} ${node.text}`;
        }
        case "code":
            return "```" + (node.lang ?? "") + "\n" + node.text + "\n```";
        case "list-item":
        case "definition":
            return `- ${node.text}`;
        case "quote":
        case "callout":
            return `> ${node.text}`;
        // prose, table, question and answer render as their own text: a
        // table's rendered rows already carry their own newlines, and
        // decorating a Q&A body would put characters inside the window a
        // nugget's anchors are measured across.
        default:
            return node.text;
    }
}

/** Render a run of nodes, one per line-pair, trimmed. */
export function renderNodesAsMarkdown(nodes: DocNode[]): string {
    return nodes.map(renderNodeText).join("\n\n").trim();
}

interface Section {
    headingPath: string[];
    nodes: DocNode[];
}

/**
 * Group nodes into heading-anchored runs: a new section starts at each
 * heading node and absorbs every following non-heading node up to the
 * next heading (or the end of the document). Nodes before the first
 * heading, if any, form a leading section with an empty heading path.
 */
function groupIntoSections(nodes: DocNode[]): Section[] {
    const sections: Section[] = [];
    let current: Section | null = null;

    for (const node of nodes) {
        if (current === null || node.kind === "heading") {
            current = { headingPath: node.headingPath, nodes: [] };
            sections.push(current);
        }
        current.nodes.push(node);
    }

    return sections;
}

/**
 * Build the excerpt set for one page's nodes: one per heading-anchored
 * section, plus a final whole-page excerpt (see module docs for why).
 * Returns the deduplicated full page text alongside, for `charCount`.
 */
function buildExcerpts(nodes: DocNode[]): { excerpts: RunExcerpt[]; fullText: string } {
    const excerpts: RunExcerpt[] = [];

    for (const section of groupIntoSections(nodes)) {
        const text = renderNodesAsMarkdown(section.nodes);
        if (text.length === 0) continue;
        // score is meaningless for oracle (nothing is ranked); left at 0
        // rather than omitted so the field stays a plain number everywhere.
        excerpts.push({ text, headingPath: section.headingPath, score: 0 });
    }

    const fullText = renderNodesAsMarkdown(nodes);
    if (fullText.length > 0) {
        excerpts.push({ text: fullText, headingPath: [], score: 0 });
    }

    return { excerpts, fullText };
}

/**
 * Create the oracle adapter: for every query, replay the FULL cached SERP
 * (uncapped - v1 truncates to `maxResults`, oracle does not) and every page
 * the corpus has for it, extracting whole-document text with no ranking,
 * filtering, quality gate, or budget.
 */
export function createOracleAdapter(config: OracleConfig = {}): PipelineAdapter {
    const timeout = config.timeout ?? DEFAULT_TIMEOUT;

    return {
        name: "oracle",
        config: { timeout },

        async runQuery(query: Query, corpus: Corpus): Promise<RunQueryResult> {
            const start = performance.now();

            // A SERP miss (or a corpus-record-time SERP fetch failure) is
            // deliberately NOT degraded into a dead result: a query with no
            // search results has nothing for any pipeline, oracle included,
            // to work with. A miss throws and is recorded as a failed query
            // by runner.ts, exactly as it is for v1.
            const serp = await corpus.getSerp(query.text, "", NO_SERP_CAP, timeout);

            // Oracle applies no cap and no filtering: every URL the search
            // engine ever surfaced for this query is both "considered" and
            // part of the SERP - the two lists are identical here precisely
            // because oracle never narrows them.
            const serpUrls = serp.results.map((r) => r.url);
            const consideredUrls = [...serpUrls];

            const pages: RunPage[] = [];
            let totalChars = 0;

            for (const result of serp.results) {
                // A recorded structured document beats the HTML for the same
                // URL: it is what the corpus actually holds for that page, and
                // on a source that refuses every scraper it is the only thing
                // the corpus holds at all.
                let doc: Doc | undefined;
                const structured = corpus.readDoc(result.url);
                if (structured !== null && structured.doc.nodes.length > 0) {
                    doc = structured.doc;
                }

                if (doc === undefined) {
                    const page = await readPageSafe(corpus, result.url, timeout);
                    if (page === null || !isUsablePage(page)) continue;

                    // A parse failure is this page being unreadable, not the
                    // query failing - the same disposition as a 403.
                    try {
                        doc = parseHtml(page.html, result.url, {
                            ...(page.finalUrl !== undefined ? { finalUrl: page.finalUrl } : {}),
                        });
                    } catch {
                        continue;
                    }
                }

                // Nothing extractable: unavailable in the same sense as a
                // 403, not a bug in the oracle's own logic.
                if (doc.nodes.length === 0) continue;

                const { excerpts, fullText } = buildExcerpts(doc.nodes);
                if (excerpts.length === 0) continue;

                pages.push({
                    url: result.url,
                    title: doc.title !== "" ? doc.title : result.url,
                    // SERP order among surviving pages - oracle does not rank.
                    rank: pages.length + 1,
                    excerpts,
                    charCount: fullText.length,
                });
                totalChars += fullText.length;
            }

            return {
                queryId: query.id,
                pages,
                consideredUrls,
                serpUrls,
                totalChars,
                durationMs: performance.now() - start,
                ...(serp.error !== undefined && { error: `serp fetch failed: ${serp.error}` }),
            };
        },
    };
}
