/**
 * Passage ranking.
 *
 * v1 scores SENTENCES, computing IDF over the ~500 one-sentence "documents" of
 * a single page. At that granularity almost every term is rare, so IDF carries
 * nearly no information and BM25 degenerates into a term-count. v2 scores
 * PASSAGES with IDF computed across the whole candidate set for the query —
 * every passage from every fetched document — which is the shape BM25 was
 * designed for and is where most of the expected lexical gain lives.
 *
 * Every component of `PassageScore` is filled separately, because a misranked
 * page has to be diagnosable rather than a mystery. Weights live in one
 * exported, serializable config so a later coordinate-descent tuner can search
 * them without touching this file.
 *
 * `Passage.date` is deliberately UNUSED. A recency prior is tempting and cheap
 * to add, but on `conceptual` and `reference` questions the older page is
 * frequently the better one — the definitive explanation of how TCP's handshake
 * works does not improve with a fresher timestamp — and nothing in the eval
 * rewards recency. It stays out until there is a measurement that asks for it.
 */

import type { Doc, PageKind, ParsedQuery, Passage, PassageScore } from "./types";
import { calculateIdf } from "../scoring/bm25";
import { buildTermFrequencyMap, tokenize } from "../preprocessing/tokenize";
import type { DocumentStats } from "../types";

// =============================================================================
// Config
// =============================================================================

/** Relative contribution of each `PassageScore` component to `combined`. */
export interface RankWeights {
    bm25: number;
    exact: number;
    headingMatch: number;
    structure: number;
    endorsement: number;
    semantic: number;
}

/** How much each class of exact anchor is worth, before normalization. */
export interface ExactWeights {
    /** A phrase the user quoted. */
    phrase: number;
    /** An error code or message. The highest-precision signal available. */
    errorString: number;
    /** A code identifier. */
    symbol: number;
    /** A version number. Weak on its own — "4" appears everywhere. */
    version: number;
}

/** Additive structural priors, applied on top of `structureBase`. */
export interface StructureWeights {
    /** Neutral starting point, so a prior can push both ways. */
    base: number;
    code: number;
    table: number;
    definition: number;
    callout: number;
    heading: number;
    answer: number;
    question: number;
    /** A passage that is nothing but list items — usually navigation residue. */
    listOnly: number;
    quote: number;
    /** Chrome that survived boilerplate stripping: "Related Posts", "Top comments", "Newsletter". */
    pageChrome: number;
    /**
     * The passage came through a structured adapter rather than scraped HTML.
     * Deliberately small: `authority.ts` already scores source trust at the
     * document level, and paying for it twice would double-count.
     */
    structuredSource: number;
    /** Ceiling on the total node-kind contribution, so kinds cannot swamp the prior. */
    kindCap: number;

    // Position priors, CONDITIONAL on page kind. There is deliberately no
    // global early-content bonus: v1 pays one, and it is why v1 returns
    // marketing intros. The answer to a general question is usually
    // mid-document.
    /**
     * `reference`: the signature and parameter table sit near the top.
     *
     * Set by reasoning and never measured, and now smaller than `globalEarly`,
     * which was — so a guide currently leans early slightly harder than a
     * reference page does. Flagged rather than quietly reconciled: raising it to
     * match is a guess, and the two have not been measured against each other.
     */
    referenceEarly: number;
    /** `qa`: the answer is BELOW the question. */
    qaLate: number;
    /** `changelog`: newest release first. */
    changelogEarly: number;
    /** `listicle`: the opening is filler by construction. */
    listicleEarly: number;
    /** `listicle`: flat penalty on every passage of the page. */
    listicleFlat: number;
    /**
     * Prior on early position that applies to EVERY page kind, added on top of
     * the conditional terms above.
     *
     * Prior on early position for page kinds that make no positional claim of
     * their own — guide, blog, spec, issue, unknown. It does NOT stack on top of
     * `referenceEarly`, `qaLate`, `changelogEarly` or `listicleEarly`; see
     * `structureScore`.
     *
     * There was deliberately none of this, on the reasoning that v1's global
     * early bonus is why v1 returns marketing intros. The reasoning survives; the
     * blanket zero does not. Measured over 7,798 candidate passages on tranche 1,
     * a passage that carries a labeled fact sits at relative position 0.40 on
     * average against 0.48 for one that does not, and position alone separates
     * the two with an AUC of 0.587 — weak on its own, but real, and larger than
     * `structure`, `exact` or `hasCode` manage.
     *
     * Swept on tranche 1 against everything else fixed: 0 → recall 0.644, 0.05 →
     * 0.649, 0.10 → 0.649, 0.20 → 0.657, 0.25 → 0.659, 0.35 → 0.648. The turn
     * after 0.25 is the original worry arriving on schedule — the top of a page
     * is where both the thesis and the pitch live, and a large early bonus buys
     * the second along with the first.
     */
    globalEarly: number;
}

export interface EndorsementWeights {
    /** Score for an accepted answer. */
    accepted: number;
    /** Half-width of the vote-only band: an unaccepted answer lands in [-spread, +spread]. */
    voteSpread: number;
}

/**
 * Gates applied to raw BM25 before normalization.
 *
 * BM25 sums independent per-term contributions, so a passage that mentions two
 * query terms ten times each can outscore one that mentions all five once — and
 * the second is almost always the better answer. Coverage and proximity are the
 * two classic corrections, and they matter most on exactly the queries where
 * `exact` contributes nothing: conceptual, how-to, and the non-technical tail
 * carry no error codes or symbols to anchor on.
 *
 * Each gate is a floor-blend: at floor 0.35 a passage covering none of the
 * query keeps 35% of its BM25 rather than being zeroed, so a gate can reorder
 * without being able to veto.
 */
export interface LexicalGates {
    /** Blend floor for IDF-weighted query-term coverage. */
    coverageFloor: number;
    /** Blend floor for query-term proximity. */
    proximityFloor: number;
    /** Token distance over which proximity decays to zero. */
    proximityScale: number;
    /** Proximity assigned when fewer than two distinct query terms are present. */
    proximityNeutral: number;
}

export interface RankConfig {
    weights: RankWeights;
    bm25: { k1: number; b: number };
    lexical: LexicalGates;
    exact: ExactWeights;
    structure: StructureWeights;
    endorsement: EndorsementWeights;
}

/**
 * Starting weights, reasoned rather than tuned.
 *
 * `exact` outweighs `bm25` on purpose: an exact error-string or symbol hit is
 * near-certain evidence of relevance, while a high BM25 only says the passage
 * is on topic. There is no early-position term in `structure` that is not
 * gated on page kind.
 */
export const DEFAULT_RANK_CONFIG: RankConfig = {
    weights: {
        bm25: 0.3,
        exact: 0.35,
        headingMatch: 0.13,
        structure: 0.1,
        // Endorsement spans [-0.6, +1.0], so this weight is a swing of ~0.29 on
        // a combined score whose realistic range is about 0-0.7 — enough to
        // overturn a moderate lexical gap, which is the point. On a Q&A page the
        // answer that most resembles the question is very often the one that
        // merely restates it, while the accepted, heavily-upvoted answer is the
        // one that explains it. If the weight cannot flip that pair, the
        // component is decorative.
        //
        // Set by reasoning, not by measurement: every Stack Exchange page in the
        // current corpus is a recorded 403, so endorsement never fires in replay
        // and the scoreboard cannot constrain this number either way.
        endorsement: 0.18,
        semantic: 0,
    },
    // b is well below v1's 0.75. Length normalization that aggressive is
    // calibrated for whole documents; applied to passages it hands a perfect
    // score to any one-line fragment containing the query terms, which is how
    // ranking ends up preferring a caption to the section that answers the
    // question.
    bm25: { k1: 1.5, b: 0.45 },
    lexical: {
        coverageFloor: 0.35,
        proximityFloor: 0.6,
        proximityScale: 100,
        proximityNeutral: 0.75,
    },
    exact: {
        phrase: 1,
        errorString: 1,
        symbol: 0.7,
        version: 0.35,
    },
    structure: {
        base: 0.5,
        code: 0.12,
        table: 0.1,
        definition: 0.12,
        callout: 0.06,
        heading: 0.04,
        answer: 0.1,
        question: -0.1,
        listOnly: -0.08,
        quote: -0.04,
        pageChrome: -0.25,
        structuredSource: 0.04,
        kindCap: 0.2,
        referenceEarly: 0.12,
        qaLate: 0.1,
        changelogEarly: 0.06,
        listicleEarly: -0.15,
        listicleFlat: -0.05,
        globalEarly: 0.25,
    },
    endorsement: {
        accepted: 1,
        voteSpread: 0.6,
    },
};

// =============================================================================
// Context
// =============================================================================

export interface RankContext {
    /**
     * The documents the passages came from. Optional: `Passage` now carries its
     * own `pageKind` and `source`, so the only thing a Doc still adds is the
     * document's full node extent, which sharpens the relative-position term.
     * Without it, extent is inferred from the passages themselves.
     */
    docs?: Doc[];
    /**
     * Optional dense-similarity contribution by passage id — the seam for a
     * later embedding reranker. Absent means `semantic` stays 0, and no
     * embedding dependency is pulled in.
     */
    semantic?: Map<string, number>;
    /** Prebuilt corpus statistics, when the caller has already computed them. */
    corpus?: PassageCorpus;
    config?: RankConfig;
}

// =============================================================================
// Helpers
// =============================================================================

function clamp(value: number, low: number, high: number): number {
    if (value < low) return low;
    if (value > high) return high;
    return value;
}

/** Max-normalize into 0-1. The floor is a true zero for every component here, so only the max is needed. */
function normalize(value: number, max: number): number {
    if (max <= 0) return 0;
    return clamp(value / max, 0, 1);
}

/**
 * Headings that introduce page furniture rather than content.
 *
 * These survive boilerplate stripping because they sit inside the main content
 * container, and they are dangerous precisely because they are ON TOPIC: a
 * "Related Posts" block on a page about dev servers is full of the query's
 * terms and none of its answer.
 */
const PAGE_CHROME_HEADING =
    /^\s*(related\s+(posts?|products?|articles?|reading|topics?)|you\s+might\s+also|more\s+(from|like)|recommended|top\s+comments?|comments?\s*\(\d+\)|newsletter|subscribe|share\s+this|follow\s+us|table\s+of\s+contents|on\s+this\s+page|in\s+this\s+article|about\s+the\s+author|advertisement|sponsored|trending|popular\s+(posts?|articles?)|latest\s+(posts?|news)|sign\s+up|get\s+started\s+free|start\s+(your\s+)?free\s+trial|key\s+takeaways)\b/i;

/** Does this passage's own heading, or its immediate parent, mark it as page furniture? */
function isPageChrome(passage: Passage): boolean {
    const own = passage.text.split("\n", 1)[0] ?? "";
    if (PAGE_CHROME_HEADING.test(own)) return true;
    const nearest = passage.headingPath[passage.headingPath.length - 1];
    return nearest !== undefined && PAGE_CHROME_HEADING.test(nearest);
}

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `needle` occur in `haystack` as a standalone token run?
 *
 * Plain `includes` would let the version "4" match "1024" and the symbol `map`
 * match "mapping", which turns the highest-precision signal we have into the
 * noisiest.
 *
 * A dot only counts as part of the token when a word character sits on its far
 * side, so `context.Err` does not match inside `context.Error` while
 * `ERR_PNPM_OUTDATED_LOCKFILE.` at the end of a sentence still does. Treating a
 * bare trailing dot as part of the token silently blocks every error code that
 * ends a sentence — which is most of them.
 */
function containsExact(haystack: string, needle: string): boolean {
    const trimmed = needle.trim();
    if (trimmed.length === 0) return false;
    const pattern = new RegExp(`(?<!\\w)(?<!\\w\\.)${escapeRegExp(trimmed)}(?!\\w)(?!\\.\\w)`, "i");
    return pattern.test(haystack);
}

// =============================================================================
// Corpus statistics
// =============================================================================

/** Passage-level corpus statistics for one query's whole candidate set. */
export interface PassageCorpus {
    stats: DocumentStats;
    tokens: Map<string, string[]>;
}

/**
 * Build BM25 statistics over PASSAGES, across every document in the candidate
 * set. This is the corpus-wide IDF that v1 lacks.
 *
 * Tokenized from `bodyText`, never from `text`: `text` repeats the heading that
 * `headingMatch` already scores, and counting it twice biases ranking toward
 * whatever sits under a keyword-stuffed heading.
 */
export function buildPassageCorpus(passages: Passage[]): PassageCorpus {
    const tokens = new Map<string, string[]>();
    const docFrequency: Record<string, number> = {};
    let totalLength = 0;

    for (const passage of passages) {
        const passageTokens = tokenize(passage.bodyText ?? passage.text);
        tokens.set(passage.id, passageTokens);
        totalLength += passageTokens.length;
        for (const term of new Set(passageTokens)) {
            docFrequency[term] = (docFrequency[term] ?? 0) + 1;
        }
    }

    return {
        tokens,
        stats: {
            totalDocs: passages.length,
            avgDocLength: passages.length > 0 ? totalLength / passages.length : 0,
            docFrequency,
        },
    };
}

/** BM25 for one passage, using the shared corpus statistics. Same maths as `src/scoring/bm25.ts`. */
function bm25Score(
    queryTerms: string[],
    passageTokens: string[],
    stats: DocumentStats,
    k1: number,
    b: number,
): number {
    if (stats.avgDocLength === 0) return 0;
    const tf = buildTermFrequencyMap(passageTokens);
    const length = passageTokens.length;
    let score = 0;

    for (const term of new Set(queryTerms)) {
        const frequency = tf[term] ?? 0;
        if (frequency === 0) continue;
        const idf = calculateIdf(term, stats);
        const numerator = frequency * (k1 + 1);
        const denominator = frequency + k1 * (1 - b + b * (length / stats.avgDocLength));
        score += idf * (numerator / denominator);
    }

    return score;
}

/**
 * IDF-weighted fraction of the query this passage covers.
 *
 * Weighted by IDF so that covering the rare, discriminating term counts for far
 * more than covering the common one — matching `err_pnpm_outdated_lockfile`
 * says more than matching `install`.
 */
export function coverageScore(queryTerms: string[], passageTokens: string[], stats: DocumentStats): number {
    const distinct = new Set(queryTerms);
    if (distinct.size === 0) return 0;
    const present = new Set(passageTokens);

    let matched = 0;
    let total = 0;
    for (const term of distinct) {
        const idf = calculateIdf(term, stats);
        total += idf;
        if (present.has(term)) matched += idf;
    }
    return total > 0 ? matched / total : 0;
}

/**
 * How tightly the query's terms cluster inside the passage.
 *
 * Computed as the minimal token window containing one occurrence of every
 * query term PRESENT in the passage — absent terms are excluded, since
 * coverage already accounts for those and double-penalizing them would make
 * proximity a second, noisier coverage.
 */
export function proximityScore(
    queryTerms: string[],
    passageTokens: string[],
    gates: LexicalGates,
): number {
    const distinct = new Set(queryTerms);
    const positions: number[][] = [];

    for (const term of distinct) {
        const found: number[] = [];
        for (let i = 0; i < passageTokens.length; i++) {
            if (passageTokens[i] === term) found.push(i);
        }
        if (found.length > 0) positions.push(found);
    }

    if (positions.length < 2) return gates.proximityNeutral;

    // Sliding window over all occurrences tagged with their term, shrinking from
    // the left whenever every present term is covered. Same shape as the eval
    // harness's own minimal-spanning-window matcher.
    const tagged: Array<{ index: number; group: number }> = [];
    for (let group = 0; group < positions.length; group++) {
        for (const index of positions[group] ?? []) tagged.push({ index, group });
    }
    tagged.sort((a, b) => a.index - b.index);

    const counts = new Map<number, number>();
    let covered = 0;
    let left = 0;
    let minSpan = Number.POSITIVE_INFINITY;

    for (let right = 0; right < tagged.length; right++) {
        const item = tagged[right];
        if (item === undefined) continue;
        const previous = counts.get(item.group) ?? 0;
        counts.set(item.group, previous + 1);
        if (previous === 0) covered++;

        while (covered === positions.length) {
            const leftItem = tagged[left];
            if (leftItem === undefined) break;
            const span = item.index - leftItem.index;
            if (span < minSpan) minSpan = span;
            const leftCount = counts.get(leftItem.group) ?? 0;
            counts.set(leftItem.group, leftCount - 1);
            if (leftCount - 1 === 0) covered--;
            left++;
        }
    }

    if (!Number.isFinite(minSpan)) return gates.proximityNeutral;
    const excess = Math.max(0, minSpan - (positions.length - 1));
    return clamp(1 - excess / gates.proximityScale, 0, 1);
}

/** Blend a gate into a raw score without letting it veto: at `floor`, a zero gate keeps `floor` of the score. */
function gate(value: number, floor: number): number {
    return floor + (1 - floor) * value;
}

// =============================================================================
// Components
// =============================================================================

interface ExactNeedle {
    text: string;
    weight: number;
}

function collectNeedles(query: ParsedQuery, config: RankConfig): ExactNeedle[] {
    const needles: ExactNeedle[] = [];
    const seen = new Set<string>();

    const push = (text: string, weight: number): void => {
        const key = text.trim().toLowerCase();
        if (key.length === 0 || seen.has(key)) return;
        seen.add(key);
        needles.push({ text: text.trim(), weight });
    };

    // Highest-precision first, so a string that is both an error code and a
    // symbol is kept at the error-code weight.
    for (const value of query.errorStrings) push(value, config.exact.errorString);
    for (const value of query.phrases) push(value, config.exact.phrase);
    for (const value of query.symbols) push(value, config.exact.symbol);
    for (const value of query.versions) push(value, config.exact.version);

    return needles;
}

/**
 * Fraction of the query's exact-anchor weight this passage carries.
 *
 * Counted per DISTINCT needle rather than per occurrence: a page that repeats
 * one symbol forty times is not forty times more relevant than one that states
 * it once, and rewarding repetition is exactly how keyword-stuffed pages win.
 */
function exactScore(text: string, needles: ExactNeedle[]): number {
    if (needles.length === 0) return 0;
    let matched = 0;
    let total = 0;
    for (const needle of needles) {
        total += needle.weight;
        if (containsExact(text, needle.text)) matched += needle.weight;
    }
    return total > 0 ? matched / total : 0;
}

/** IDF-weighted fraction of query terms present in the heading path. */
function headingMatchScore(headingPath: string[], queryTerms: string[], stats: DocumentStats): number {
    if (queryTerms.length === 0 || headingPath.length === 0) return 0;
    const headingTokens = new Set(tokenize(headingPath.join(" ")));
    if (headingTokens.size === 0) return 0;

    let matched = 0;
    let total = 0;
    for (const term of new Set(queryTerms)) {
        const idf = calculateIdf(term, stats);
        total += idf;
        if (headingTokens.has(term)) matched += idf;
    }
    return total > 0 ? matched / total : 0;
}

/**
 * Structural prior from node kinds plus a page-kind-CONDITIONAL position term.
 *
 * `relativePosition` is 0 at the top of the document and 1 at the bottom.
 */
function structureScore(
    passage: Passage,
    pageKind: PageKind,
    relativePosition: number,
    config: StructureWeights,
): number {
    let kindDelta = 0;
    const kinds = new Set(passage.kinds);

    if (kinds.has("code")) kindDelta += config.code;
    if (kinds.has("table")) kindDelta += config.table;
    if (kinds.has("definition")) kindDelta += config.definition;
    if (kinds.has("callout")) kindDelta += config.callout;
    if (kinds.has("heading")) kindDelta += config.heading;
    if (kinds.has("answer")) kindDelta += config.answer;
    if (kinds.has("question")) kindDelta += config.question;
    if (kinds.has("quote")) kindDelta += config.quote;

    const listOnly = passage.kinds.every((kind) => kind === "list-item" || kind === "heading");
    if (listOnly) kindDelta += config.listOnly;

    if (passage.source !== undefined && passage.source !== "html") kindDelta += config.structuredSource;

    kindDelta = clamp(kindDelta, -config.kindCap, config.kindCap);

    // Applied outside the kind cap: page furniture should be able to sink a
    // passage on its own, not be offset by it happening to contain a code block.
    const chromeDelta = isPageChrome(passage) ? config.pageChrome : 0;

    let positionDelta = 0;
    switch (pageKind) {
        case "reference":
            positionDelta = config.referenceEarly * (1 - relativePosition);
            break;
        case "qa":
            positionDelta = config.qaLate * relativePosition;
            break;
        case "changelog":
            positionDelta = config.changelogEarly * (1 - relativePosition);
            break;
        case "listicle":
            positionDelta = config.listicleFlat + config.listicleEarly * (1 - relativePosition);
            break;
        default:
            // guide, blog, spec, issue, unknown: no page-kind claim about where
            // the answer sits, so the measured default prior applies here and
            // ONLY here. A kind that already states where its answer lives has
            // better information than an average over the whole corpus, and
            // stacking the two silently overturns it — at 0.25 the global term
            // is more than twice `qaLate`, which would push a Q&A page's
            // question back above its accepted answer.
            positionDelta = config.globalEarly * (1 - relativePosition);
    }

    return clamp(config.base + kindDelta + chromeDelta + positionDelta, 0, 1);
}

/**
 * Community endorsement, in [-1, 1] with 0 meaning "no endorsement data".
 *
 * Signed rather than 0-1 so that a page with no Q&A signals is NEUTRAL rather
 * than penalized: a 0-1 endorsement would hand every Stack Overflow passage a
 * standing bonus over every documentation passage, which is not the claim being
 * made. The claim is narrower — among answers to the same question, the
 * community already told us which one is right.
 */
function endorsementScore(
    passage: Passage,
    maxVotes: number,
    config: EndorsementWeights,
): number {
    if (passage.votes === undefined && passage.accepted === undefined) return 0;
    if (passage.accepted === true) return config.accepted;

    const votes = Math.max(0, passage.votes ?? 0);
    const voteNorm = maxVotes > 0 ? Math.log1p(votes) / Math.log1p(maxVotes) : 0;
    return clamp((voteNorm * 2 - 1) * config.voteSpread, -config.voteSpread, config.voteSpread);
}

// =============================================================================
// Entry point
// =============================================================================

/**
 * Score every passage in the candidate set against the query.
 *
 * Returned in ranked order: `combined` descending, ties broken by passage id
 * ascending. Both levels are needed — score alone is not a total order, and an
 * unstable order makes an eval diff meaningless.
 */
export function scorePassages(
    passages: Passage[],
    query: ParsedQuery,
    ctx: RankContext,
): PassageScore[] {
    const config = ctx.config ?? DEFAULT_RANK_CONFIG;
    if (passages.length === 0) return [];

    const corpus = ctx.corpus ?? buildPassageCorpus(passages);
    const needles = collectNeedles(query, config);

    const kindByUrl = new Map<string, PageKind>();
    const maxOrderByUrl = new Map<string, number>();
    for (const doc of ctx.docs ?? []) {
        kindByUrl.set(doc.url, doc.kind);
        let maxOrder = 0;
        for (const node of doc.nodes) {
            if (node.order > maxOrder) maxOrder = node.order;
        }
        maxOrderByUrl.set(doc.url, maxOrder);
    }
    // Fall back to the extent the passages themselves span, so the position
    // prior still works when no Doc was supplied.
    for (const passage of passages) {
        const known = maxOrderByUrl.get(passage.docUrl) ?? 0;
        if (passage.endOrder > known) maxOrderByUrl.set(passage.docUrl, passage.endOrder);
    }

    let maxVotes = 0;
    for (const passage of passages) {
        if (passage.votes !== undefined && passage.votes > maxVotes) maxVotes = passage.votes;
    }

    // Gated BM25 first, so it can be max-normalized against the candidate set
    // rather than against an arbitrary constant. Coverage and proximity are
    // folded in here rather than carried as separate `PassageScore` fields
    // because the type is fixed by `types.ts` and all three are the same kind of
    // claim: how well this passage's TEXT matches the query.
    const rawBm25 = new Map<string, number>();
    let maxBm25 = 0;
    for (const passage of passages) {
        const tokens = corpus.tokens.get(passage.id) ?? [];
        const raw = bm25Score(query.terms, tokens, corpus.stats, config.bm25.k1, config.bm25.b);
        const coverage = coverageScore(query.terms, tokens, corpus.stats);
        const proximity = proximityScore(query.terms, tokens, config.lexical);
        const gated =
            raw * gate(coverage, config.lexical.coverageFloor) * gate(proximity, config.lexical.proximityFloor);
        rawBm25.set(passage.id, gated);
        if (gated > maxBm25) maxBm25 = gated;
    }

    const scores: PassageScore[] = [];
    for (const passage of passages) {
        // The passage's own page kind wins: it is what the passage builder
        // recorded, and it stays correct even when no Doc was passed.
        const pageKind = passage.pageKind ?? kindByUrl.get(passage.docUrl) ?? "unknown";
        const maxOrder = maxOrderByUrl.get(passage.docUrl) ?? 0;
        const relativePosition = maxOrder > 0 ? clamp(passage.startOrder / maxOrder, 0, 1) : 0;

        const bm25 = normalize(rawBm25.get(passage.id) ?? 0, maxBm25);
        // Exact anchors are matched against the FULL text, heading included.
        // The double-counting worry that keeps BM25 off the heading does not
        // apply here: an error code or symbol in a heading is a genuine, highly
        // specific signal, not the generic keyword stuffing headings attract.
        const exact = exactScore(passage.text, needles);
        const headingMatch = headingMatchScore(passage.headingPath, query.terms, corpus.stats);
        const structure = structureScore(passage, pageKind, relativePosition, config.structure);
        const endorsement = endorsementScore(passage, maxVotes, config.endorsement);
        const semantic = ctx.semantic?.get(passage.id) ?? 0;

        const combined =
            config.weights.bm25 * bm25 +
            config.weights.exact * exact +
            config.weights.headingMatch * headingMatch +
            config.weights.structure * structure +
            config.weights.endorsement * endorsement +
            config.weights.semantic * semantic;

        scores.push({
            passageId: passage.id,
            bm25,
            exact,
            headingMatch,
            structure,
            endorsement,
            semantic,
            combined,
        });
    }

    scores.sort((a, b) => {
        const diff = b.combined - a.combined;
        if (diff !== 0) return diff;
        return a.passageId.localeCompare(b.passageId);
    });

    return scores;
}
