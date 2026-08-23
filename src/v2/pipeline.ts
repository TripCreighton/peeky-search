/**
 * v2 search pipeline.
 *
 * parse the query -> fetch documents -> settle page kind -> build passages ->
 * score them against ONE corpus-wide candidate set -> score each source's
 * authority -> assemble under budget.
 *
 * The stage that matters most is the third arrow. v1 ranks each page in
 * isolation and then merges the winners, so IDF is computed per page and a
 * passage can only ever compete with its own neighbours. Here every passage
 * from every fetched document is scored in one pool, which is what lets a
 * strong passage on page four beat a mediocre one on page one.
 */

import { parseQuery } from "./query";
import { detectPageKind } from "./pagekind";
import { buildPassages, type PassageConfig } from "./passages";
import {
    scorePassages,
    buildPassageCorpus,
    coverageScore,
    DEFAULT_RANK_CONFIG,
    type RankConfig,
} from "./rank";
import { tokenize } from "../preprocessing/tokenize";
import {
    scoreAuthority,
    computePeerCitations,
    DEFAULT_AUTHORITY_CONFIG,
    type AuthorityConfig,
} from "./authority";
import { assemble, finalScore, DEFAULT_ASSEMBLE_BUDGET, type AssembleBudget, type RankedPassage } from "./assemble";
import {
    blendRankConfig,
    rerankPassages,
    resolveRerankConfig,
    type RerankConfig,
    type RerankOptions,
} from "./rerank";
import type { Authority, Doc, DocSource, PageKind, ParsedQuery, Passage, PassageScore } from "./types";

// =============================================================================
// Types
// =============================================================================

/** Fetch one URL as a parsed document, or null when it is unavailable. */
export type DocFetcher = (url: string) => Promise<Doc | null>;

/**
 * A returned excerpt. Adjacent selected passages from the same document are
 * merged into one, because a fact whose parts straddle a passage boundary is
 * lost to any consumer that reads excerpts independently — including the eval
 * harness's own nugget matcher.
 */
export interface V2Excerpt {
    text: string;
    headingPath: string[];
    score: number;
    charCount: number;
    /** Which passages were merged to produce this. Kept for diagnosis. */
    passageIds: string[];
}

export interface V2Page {
    url: string;
    finalUrl?: string;
    title: string;
    kind: PageKind;
    source: DocSource;
    authority: Authority;
    excerpts: V2Excerpt[];
    charCount: number;
    /** 1-based, best first. */
    rank: number;
}

export interface V2Diagnostics {
    /** URLs the pipeline attempted to fetch. */
    consideredUrls: string[];
    /** URLs the fetcher could not turn into a document. */
    unavailableUrls: string[];
    /** URLs dropped for bottomed-out authority: fetched, parsed, and carrying no article. */
    excludedUrls: string[];
    /** Documents fetched successfully. */
    docsFetched: number;
    /** Passages built across all documents. */
    passagesBuilt: number;
    /** Passages that survived assembly. */
    passagesSelected: number;
    /** Page kind per fetched document. */
    kindByUrl: Record<string, PageKind>;
}

export interface V2Result {
    query: ParsedQuery;
    pages: V2Page[];
    totalChars: number;
    diagnostics: V2Diagnostics;
}

export interface V2Config {
    /** Max SERP URLs to fetch. Default 16 — see `DEFAULTS`. */
    maxCandidates?: number;
    /** Documents fetched in parallel. Default 5. */
    fetchConcurrency?: number;
    /**
     * Documents whose authority is at or below this are dropped outright rather
     * than damped. Default 0.05 — the authority floor itself, so only a
     * document on which every structural negative fired is excluded.
     */
    minDocAuthority?: number;
    /** Coalesce consecutive passages until a unit reaches this. Default 900. */
    coalesceTargetChars?: number;
    /** Hard ceiling on a coalesced unit. Default 1900. */
    coalesceMaxChars?: number;
    passages?: PassageConfig;
    rank?: RankConfig;
    authority?: AuthorityConfig;
    /**
     * Hostnames known to be a declared homepage/repository for a library the
     * query names. Serializable (a plain array) so it can be recorded in a run
     * file; resolving it requires a network call, so it is supplied rather than
     * looked up here.
     */
    canonicalHosts?: string[];
    budget?: AssembleBudget;
    pageOrder?: Partial<PageOrderConfig>;
    /**
     * OPTIONAL cross-encoder reranking of the first stage's top candidates.
     * OFF unless a `scorer` is supplied — see `rerank.ts`. It is a
     * hundreds-of-milliseconds, hundreds-of-megabytes stage in a package whose
     * pitch is "no LLM needed", so it never runs by default.
     */
    rerank?: RerankOptions;
}

/** The fully-resolved configuration a run was executed with. Serializable by construction. */
export interface ResolvedV2Config {
    maxCandidates: number;
    fetchConcurrency: number;
    minDocAuthority: number;
    coalesceTargetChars: number;
    coalesceMaxChars: number;
    passages: PassageConfig;
    rank: RankConfig;
    authority: AuthorityConfig;
    canonicalHosts: string[];
    budget: Required<AssembleBudget>;
    pageOrder: PageOrderConfig;
    /** The reranker's serializable knobs, or null when the stage is off. */
    rerank: RerankConfig | null;
}

/**
 * `buildPassages` opens a new passage at every heading, so a page written in
 * short sections yields a stream of 100-400 character fragments. That is the
 * right SEGMENTATION but the wrong RETRIEVAL UNIT, for two measured reasons:
 *
 *   - BM25 saturates on fragments. With standard length normalization a
 *     123-character line holding one occurrence of each query term scores a
 *     perfect 1.0, outranking the 700-character section that actually explains
 *     the answer. Ranking then optimizes for brevity rather than substance.
 *   - A fact split across two fragments is lost to any consumer that reads
 *     excerpts independently, the eval harness's nugget matcher included.
 *
 * So consecutive passages are coalesced back into units of comparable size
 * before anything is scored.
 */
const DEFAULT_PASSAGE_CONFIG: PassageConfig = { maxChars: 1200, targetChars: 400 };

/**
 * How the ORDER of returned pages is decided, on top of each page's best
 * passage score.
 *
 * Two page-level signals exist that no passage carries. v1 uses both (title
 * match at 0.35, SearXNG score at 0.15 of its page relevance) and v2 would
 * otherwise discard them:
 *
 *   - TITLE MATCH. A document whose title states the question is usually about
 *     the question. This is also, notoriously, what a content farm optimizes —
 *     which is why v1 gets beaten by farms and v2 does not: authority is scored
 *     independently and multiplies into the same ordering.
 *   - SERP RANK. The search engine already ranked these, using signals
 *     (link graph, click data) we have no access to. Ignoring that entirely
 *     throws away evidence; trusting it heavily reproduces the search engine.
 */
export interface PageOrderConfig {
    /** Weight on the title's IDF-weighted query coverage. */
    titleMatch: number;
    /** Weight on the search engine's own ordering. */
    serpRank: number;
    /** SERP positions beyond this contribute nothing. */
    serpDepth: number;
    /**
     * Weight on `Authority.canonical` — "this page IS the documentation for the
     * thing that was asked about".
     *
     * Separate from the authority score already folded into each passage's
     * `finalScore`, and doing a different job. That score decides WHICH
     * passages survive assembly; this decides which of the surviving pages the
     * caller reads FIRST, and a model reading top-down should meet the
     * project's own manual before anyone's commentary on it. It is a boolean
     * rather than a slope on purpose: the claim is categorical, and letting a
     * continuous authority score reorder pages would re-apply evidence that
     * already priced itself into `best`.
     */
    canonicalBoost: number;
    /**
     * Sort every canonical document ahead of every non-canonical one, before
     * the score key is consulted at all.
     *
     * OFF by default, and it must stay off for search: every published number
     * describes the multiplicative `canonicalBoost`, and a hard partition is a
     * different ordering that no run file has ever scored.
     *
     * It exists for the SURVEY path, where the question being asked is
     * different. `canonicalBoost` says "weight the project's own manual more
     * heavily"; because it multiplies `best`, whether the manual actually lands
     * first depends on the SERP position it happened to draw that minute.
     * Measured live on "react useEffect cleanup function": react.dev scores
     * best=0.750 against w3schools' best=0.795 and wins only once the boost and
     * a position-0 SERP prior are applied — draw a worse position and a blog
     * takes the top slot. For a list whose entire job is "here is what exists,
     * pick one to read", that instability is the defect.
     *
     * Safe to partition on because `Authority.canonical` is a tight signal:
     * either a structural claim (declared homepage, standards body, primary
     * source, the project's own domain serving its own docs, cited by enough
     * peers) or a pre-prior score at or above `canonicalThreshold`. Critically,
     * that threshold is evaluated inside `scoreAuthority`, BEFORE
     * `applySerpPrior` runs — so ranking well cannot make a page canonical. A
     * Stack Overflow answer sitting at 0.89 after the prior is still correctly
     * not canonical.
     *
     * Canonical documents keep their relative order among themselves, and so do
     * the rest; this only moves the boundary between the two groups.
     */
    canonicalFirst: boolean;
    /**
     * How strongly the search engine's own ordering shifts a document's
     * AUTHORITY (see `applySerpPrior`). 0 disables it.
     */
    serpPrior: number;
    /** SERP position treated as the neutral point is half of this. */
    serpPriorDepth: number;
}

/**
 * `titleMatch` defaults to OFF, which is a measurement rather than an omission.
 * Switching it on moves canonical MRR by less than 0.005 on tranche 1, while
 * the SERP-rank term moves it by +0.019 on its own — passage-level scoring has
 * already extracted whatever the title was going to tell us, and title match is
 * the signal content farms are built to win. The knob stays exposed so a tuner
 * can revisit it against a larger query set.
 */
export const DEFAULT_PAGE_ORDER: PageOrderConfig = {
    titleMatch: 0,
    serpRank: 0.25,
    serpDepth: 10,
    canonicalBoost: 0.35,
    // Off: search's ordering is the measured one. See the field's comment.
    canonicalFirst: false,
    serpPrior: 0.7,
    serpPriorDepth: 16,
};

const DEFAULTS = {
    /**
     * How deep to read into the SERP.
     *
     * Raised from 8 once `authority.ts` could tell a page that published an
     * article from one that did not. The measured curve on tranche 1, holding
     * everything else fixed:
     *
     *   depth  8: recall 0.495  srcPrec 0.776  MRR 0.361  6844 chars
     *   depth 12: recall 0.529  srcPrec 0.724  MRR 0.375  7691 chars
     *   depth 16: recall 0.556  srcPrec 0.727  MRR 0.374  7815 chars
     *   depth 20: recall 0.560  srcPrec 0.723  MRR 0.364  8050 chars
     *
     * 16 is where recall stops paying for itself: the extra four fetches to 20
     * buy +0.004 recall and give back source precision and MRR. The gradient
     * driving the shape is in the corpus, not in this pipeline — SERP positions
     * 0-3 are 70% good-or-canonical and positions 12-15 are 41%.
     */
    maxCandidates: 16,
    fetchConcurrency: 5,
    /** Only a document at the very authority floor is excluded outright. */
    minDocAuthority: 0.05,
    /** Keep coalescing until a unit reaches this. */
    coalesceTargetChars: 900,
    /** Never let a coalesced unit exceed this. */
    coalesceMaxChars: 1900,
};

/** Expand a partial config into the exact settings a run used, for the record. */
export function resolveConfig(config: V2Config = {}): ResolvedV2Config {
    return {
        maxCandidates: config.maxCandidates ?? DEFAULTS.maxCandidates,
        fetchConcurrency: config.fetchConcurrency ?? DEFAULTS.fetchConcurrency,
        minDocAuthority: config.minDocAuthority ?? DEFAULTS.minDocAuthority,
        coalesceTargetChars: config.coalesceTargetChars ?? DEFAULTS.coalesceTargetChars,
        coalesceMaxChars: config.coalesceMaxChars ?? DEFAULTS.coalesceMaxChars,
        passages: { ...DEFAULT_PASSAGE_CONFIG, ...config.passages },
        rank: config.rank ?? DEFAULT_RANK_CONFIG,
        authority: config.authority ?? DEFAULT_AUTHORITY_CONFIG,
        canonicalHosts: config.canonicalHosts ?? [],
        budget: { ...DEFAULT_ASSEMBLE_BUDGET, ...config.budget },
        pageOrder: { ...DEFAULT_PAGE_ORDER, ...config.pageOrder },
        rerank: resolveRerankConfig(config.rerank),
    };
}

// =============================================================================
// Fetching
// =============================================================================

interface FetchOutcome {
    url: string;
    doc: Doc | null;
}

/** Fetch with bounded concurrency, writing results back at their input index so order never depends on timing. */
async function fetchAll(urls: string[], fetcher: DocFetcher, concurrency: number): Promise<FetchOutcome[]> {
    const outcomes: FetchOutcome[] = new Array<FetchOutcome>(urls.length);
    let next = 0;

    const worker = async (): Promise<void> => {
        for (;;) {
            const index = next;
            next += 1;
            const url = urls[index];
            if (url === undefined) return;
            let doc: Doc | null = null;
            try {
                doc = await fetcher(url);
            } catch {
                // A fetcher that throws is one unavailable page, not a failed
                // query — the same treatment a 403 gets.
                doc = null;
            }
            outcomes[index] = { url, doc };
        }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.max(1, Math.min(concurrency, urls.length)); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);

    return outcomes.filter((outcome): outcome is FetchOutcome => outcome !== undefined);
}

// =============================================================================
// Coalescing and excerpt merging
// =============================================================================

/** Two passages are adjacent when nothing in the document sits between them. */
function isAdjacent(previous: Passage, next: Passage): boolean {
    return next.startOrder <= previous.endOrder + 1;
}

/**
 * Endorsement identity. Two passages carrying different vote counts or accepted
 * flags come from different Q&A posts and must never be coalesced: the merged
 * unit's endorsement would be meaningless, and it would attribute one person's
 * answer to another.
 */
function sameEndorsement(a: Passage, b: Passage): boolean {
    return a.votes === b.votes && a.accepted === b.accepted;
}

/**
 * Fold `next` into the accumulating unit.
 *
 * `bodyText` is carried alongside `text` and joined the same way, because
 * ranking scores lexical relevance against the body while the caller reads the
 * display text — letting them drift apart would mean scoring one string and
 * returning another.
 */
function absorb(unit: Passage, next: Passage): Passage {
    const kinds = [...unit.kinds];
    for (const kind of next.kinds) {
        if (!kinds.includes(kind)) kinds.push(kind);
    }
    const text = joinPassageText(unit.text, unit, next);
    const unitBody = unit.bodyText;
    const nextBody = next.bodyText;
    const bodyText =
        unitBody !== undefined && nextBody !== undefined ? `${unitBody}\n${nextBody}` : undefined;

    return {
        ...unit,
        text,
        ...(bodyText !== undefined ? { bodyText } : {}),
        charCount: text.length,
        endOrder: next.endOrder,
        kinds,
        hasCode: unit.hasCode || next.hasCode,
    };
}

/**
 * Coalesce consecutive passages within each document into units of comparable
 * size, so ranking compares like with like (see `DEFAULT_PASSAGE_CONFIG`).
 *
 * Input must be in document order per document, which is what `buildPassages`
 * guarantees. Ids are inherited from each unit's first passage, so they stay
 * stable and remain usable as a deterministic tie-break.
 */
export function coalescePassages(passages: Passage[], targetChars: number, maxChars: number): Passage[] {
    const out: Passage[] = [];
    let unit: Passage | null = null;
    let previous: Passage | null = null;

    for (const passage of passages) {
        const canExtend =
            unit !== null &&
            previous !== null &&
            previous.docUrl === passage.docUrl &&
            isAdjacent(previous, passage) &&
            sameEndorsement(previous, passage) &&
            unit.charCount < targetChars &&
            unit.charCount + passage.charCount + 1 <= maxChars;

        if (canExtend && unit !== null) {
            unit = absorb(unit, passage);
        } else {
            if (unit !== null) out.push(unit);
            unit = { ...passage, kinds: [...passage.kinds] };
        }
        previous = passage;
    }
    if (unit !== null) out.push(unit);

    return out;
}

function samePath(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((value, index) => value === b[index]);
}

/**
 * Join two passage texts, dropping the second's repeated heading line.
 *
 * `buildPassages` prefixes every passage with its nearest heading, so merging
 * two passages from the same run would otherwise restate it — paying budget for
 * a line the reader already has.
 */
function joinPassageText(accumulated: string, previous: Passage, next: Passage): string {
    if (!samePath(previous.headingPath, next.headingPath)) {
        return `${accumulated}\n${next.text}`;
    }
    const newlineIndex = next.text.indexOf("\n");
    const firstLine = newlineIndex === -1 ? next.text : next.text.slice(0, newlineIndex);
    const heading = next.headingPath[next.headingPath.length - 1];
    if (heading !== undefined && firstLine === heading && newlineIndex !== -1) {
        return `${accumulated}\n${next.text.slice(newlineIndex + 1)}`;
    }
    return `${accumulated}\n${next.text}`;
}

function mergeAdjacent(passages: Passage[], scoreById: Map<string, number>): V2Excerpt[] {
    const ordered = [...passages].sort((a, b) => {
        const diff = a.startOrder - b.startOrder;
        if (diff !== 0) return diff;
        return a.id.localeCompare(b.id);
    });

    const excerpts: V2Excerpt[] = [];
    let text = "";
    let ids: string[] = [];
    let headingPath: string[] = [];
    let score = 0;
    let previous: Passage | null = null;

    const flush = (): void => {
        if (previous === null) return;
        excerpts.push({ text, headingPath, score, charCount: text.length, passageIds: ids });
    };

    for (const passage of ordered) {
        const passageScore = scoreById.get(passage.id) ?? 0;
        if (previous !== null && isAdjacent(previous, passage)) {
            text = joinPassageText(text, previous, passage);
            ids = [...ids, passage.id];
            if (passageScore > score) score = passageScore;
        } else {
            flush();
            text = passage.text;
            ids = [passage.id];
            headingPath = passage.headingPath;
            score = passageScore;
        }
        previous = passage;
    }
    flush();

    return excerpts;
}

// =============================================================================
// SERP prior
// =============================================================================

/**
 * Fold the search engine's own ordering into a document's authority.
 *
 * Stated in one sentence: a search engine's rank is third-party evidence about
 * a SOURCE — link graph, click data, spam scoring — that this pipeline has no
 * way to compute for itself, and discarding it entirely throws that evidence
 * away.
 *
 * It belongs on the authority axis rather than the relevance axis because it is
 * a claim about the publisher, not about whether this page answers this
 * question; `rank.ts` must never see it, or the pipeline degenerates into
 * reproducing the search engine it is trying to improve on.
 *
 * The prior is centred, not additive: `serpPriorDepth / 2` is the neutral
 * position, so it redistributes trust across the candidate list rather than
 * inflating everything near the top. That matters at depth — measured on
 * tranche 1, SERP positions 0-3 are 70% good-or-canonical and positions 12-15
 * are 41%, which is precisely the quality gradient that makes reading deeper
 * cost source precision.
 *
 * `canonical` is deliberately untouched: being the project's own manual is not
 * a claim a search engine gets a vote on.
 */
function applySerpPrior(
    authority: Authority,
    serpIndex: number | undefined,
    settings: ResolvedV2Config,
): Authority {
    const strength = settings.pageOrder.serpPrior;
    if (strength === 0 || serpIndex === undefined) return authority;
    // A page that published no article is not rescued by having ranked well:
    // the prior redistributes trust among the pages that have some to
    // redistribute. Measured as metric-neutral on tranche 1; it is here so that
    // the floor keeps meaning "this document carries nothing".
    if (authority.score <= settings.authority.floor) return authority;

    const depth = Math.max(1, settings.pageOrder.serpPriorDepth);
    const position = Math.min(1, serpIndex / depth);
    const delta = strength * (0.5 - position);
    if (delta === 0) return authority;

    const adjusted = Math.max(settings.authority.floor, Math.min(1, authority.score + delta));
    return {
        score: adjusted,
        canonical: authority.canonical,
        reasons: [
            ...authority.reasons,
            `${delta > 0 ? "+" : ""}${delta.toFixed(3)} SERP prior (position ${serpIndex} of ${depth})`,
        ],
    };
}

// =============================================================================
// Entry point
// =============================================================================

/**
 * Run the v2 pipeline over a candidate URL list.
 *
 * `fetcher` supplies documents, which is what lets the eval harness replay a
 * frozen corpus through exactly the same code path a live run would take.
 */
export async function searchV2(
    queryText: string,
    urls: string[],
    fetcher: DocFetcher,
    config: V2Config = {},
): Promise<V2Result> {
    const settings = resolveConfig(config);
    const query = parseQuery(queryText);

    const consideredUrls = urls.slice(0, settings.maxCandidates);
    // Input order IS the search engine's ranking; kept so page ordering can use it.
    const serpRankByUrl = new Map<string, number>();
    for (let i = 0; i < consideredUrls.length; i++) {
        const url = consideredUrls[i];
        if (url !== undefined && !serpRankByUrl.has(url)) serpRankByUrl.set(url, i);
    }
    const outcomes = await fetchAll(consideredUrls, fetcher, settings.fetchConcurrency);

    const docs: Doc[] = [];
    const unavailableUrls: string[] = [];
    const kindByUrl: Record<string, PageKind> = {};

    for (const outcome of outcomes) {
        if (outcome.doc === null) {
            unavailableUrls.push(outcome.url);
            continue;
        }
        const doc = outcome.doc;
        // A structured adapter already knows what it fetched; only fall back to
        // detection when nothing has classified the page.
        if (doc.kind === "unknown") {
            const detected = detectPageKind(doc, "", doc.finalUrl ?? doc.url);
            doc.kind = detected.kind;
            doc.kindEvidence = detected.evidence;
        }
        kindByUrl[doc.url] = doc.kind;
        docs.push(doc);
    }

    const passages: Passage[] = [];
    for (const doc of docs) {
        passages.push(
            ...coalescePassages(
                buildPassages(doc, settings.passages),
                settings.coalesceTargetChars,
                settings.coalesceMaxChars,
            ),
        );
    }

    const excludedUrls: string[] = [];
    const diagnostics: V2Diagnostics = {
        consideredUrls,
        unavailableUrls,
        excludedUrls,
        docsFetched: docs.length,
        passagesBuilt: passages.length,
        passagesSelected: 0,
        kindByUrl,
    };

    if (passages.length === 0) {
        return { query, pages: [], totalChars: 0, diagnostics };
    }

    // Built once and shared: the same IDF statistics rank passages and score
    // page titles, so a term cannot be rare for one and common for the other.
    const corpus = buildPassageCorpus(passages);
    let scores = scorePassages(passages, query, { docs, corpus, config: settings.rank });

    // --- Optional second stage ---------------------------------------------
    //
    // Two-stage retrieval in its deployment shape: the lexical ranker above has
    // just ordered every passage for free, and only its top `topK` are worth a
    // forward pass. The candidate set is re-scored rather than patched, so the
    // semantic component enters through the same `scorePassages` arithmetic as
    // every other component and there is exactly one definition of `combined`.
    const rerankOptions = config.rerank;
    if (settings.rerank !== null && rerankOptions?.scorer !== undefined) {
        const { semantic, timing, candidates } = await rerankPassages(
            queryText,
            passages,
            scores,
            rerankOptions.scorer,
            settings.rerank,
        );
        rerankOptions.onTiming?.(timing);
        rerankOptions.onScored?.(candidates);
        scores = scorePassages(passages, query, {
            docs,
            corpus,
            semantic,
            config: blendRankConfig(settings.rank, settings.rerank.weight),
        });
    }

    const scoreById = new Map<string, PassageScore>(scores.map((score) => [score.passageId, score]));

    const authorityByUrl = new Map<string, Authority>();
    const canonicalHosts = new Set(settings.canonicalHosts);
    // The candidate set is a small on-topic citation graph, and it can only be
    // read once every document is in hand — which is why this is computed here
    // and handed to `scoreAuthority` rather than derived inside it.
    const peerCitations = computePeerCitations(docs);
    for (const doc of docs) {
        const scored = scoreAuthority(doc, query, {
            canonicalHosts,
            peerCitations: peerCitations.get(doc.url) ?? 0,
            config: settings.authority,
        });
        authorityByUrl.set(doc.url, applySerpPrior(scored, serpRankByUrl.get(doc.url), settings));
    }

    const neutralAuthority: Authority = { score: 0.5, canonical: false, reasons: ["document not scored"] };

    // Bottomed-out authority means every structural negative fired at once,
    // which in practice is one specific document: a page that returned HTTP 200
    // and no article — a teaser grid, a newsletter gate, a nav-only stub.
    // Dropping it costs no recall because there is nothing on it to recall, and
    // it has to be dropped rather than damped: its title matches the query
    // exactly, so a damped score still wins slots at depth.
    //
    // This is the ONLY hard exclusion in the pipeline, and it carries two
    // safeguards. It is keyed to the authority FLOOR rather than to a tunable
    // band, so a content farm that writes real prose never reaches it; and it
    // is skipped entirely when every candidate is floored, because returning
    // the best of a bad SERP beats returning nothing at all.
    const floored = new Set<string>();
    for (const doc of docs) {
        const authority = authorityByUrl.get(doc.url);
        if (authority !== undefined && authority.score <= settings.minDocAuthority) floored.add(doc.url);
    }
    if (floored.size === docs.length) floored.clear();
    excludedUrls.push(...[...floored].sort((a, b) => a.localeCompare(b)));

    const ranked: RankedPassage[] = [];
    for (const passage of passages) {
        const score = scoreById.get(passage.id);
        if (score === undefined) continue;
        if (floored.has(passage.docUrl)) continue;
        ranked.push({
            passage,
            score,
            authority: authorityByUrl.get(passage.docUrl) ?? neutralAuthority,
        });
    }

    const selected = assemble(ranked, settings.budget);
    diagnostics.passagesSelected = selected.length;

    // --- Group back into pages ---------------------------------------------

    const finalById = new Map<string, number>();
    for (const entry of ranked) {
        finalById.set(entry.passage.id, finalScore(entry, settings.budget));
    }

    const byDoc = new Map<string, Passage[]>();
    for (const passage of selected) {
        const list = byDoc.get(passage.docUrl);
        if (list === undefined) byDoc.set(passage.docUrl, [passage]);
        else list.push(passage);
    }

    const docByUrl = new Map(docs.map((doc) => [doc.url, doc]));
    const unranked: Array<{ page: V2Page; key: number }> = [];

    for (const [docUrl, docPassages] of byDoc) {
        const doc = docByUrl.get(docUrl);
        if (doc === undefined) continue;

        const excerpts = mergeAdjacent(docPassages, finalById);
        const charCount = excerpts.reduce((sum, excerpt) => sum + excerpt.charCount, 0);

        // A page is ordered by its BEST passage, not by its total: one decisive
        // passage on an authoritative page is worth more than several weak ones.
        let best = 0;
        for (const passage of docPassages) {
            const value = finalById.get(passage.id) ?? 0;
            if (value > best) best = value;
        }

        const titleScore = coverageScore(query.terms, tokenize(doc.title), corpus.stats);
        const serpIndex = serpRankByUrl.get(doc.url);
        const serpScore =
            serpIndex === undefined ? 0 : Math.max(0, 1 - serpIndex / settings.pageOrder.serpDepth);
        const authority = authorityByUrl.get(docUrl) ?? neutralAuthority;
        const key =
            best *
            (1 +
                settings.pageOrder.titleMatch * titleScore +
                settings.pageOrder.serpRank * serpScore +
                (authority.canonical ? settings.pageOrder.canonicalBoost : 0));

        unranked.push({
            key,
            page: {
                url: doc.url,
                ...(doc.finalUrl !== undefined ? { finalUrl: doc.finalUrl } : {}),
                title: doc.title,
                kind: doc.kind,
                source: doc.source,
                authority,
                excerpts,
                charCount,
                rank: 0,
            },
        });
    }

    unranked.sort((a, b) => {
        // The partition, when asked for, outranks the score key entirely.
        if (settings.pageOrder.canonicalFirst) {
            const left = a.page.authority.canonical ? 1 : 0;
            const right = b.page.authority.canonical ? 1 : 0;
            if (left !== right) return right - left;
        }
        const diff = b.key - a.key;
        if (diff !== 0) return diff;
        return a.page.url.localeCompare(b.page.url);
    });

    const pages: V2Page[] = unranked.map((entry, index) => ({ ...entry.page, rank: index + 1 }));

    const totalChars = pages.reduce((sum, page) => sum + page.charCount, 0);

    return { query, pages, totalChars, diagnostics };
}
