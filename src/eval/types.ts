/**
 * Evaluation harness type definitions.
 *
 * The harness scores a pipeline configuration against a frozen corpus using
 * nugget labels. A run is a pure function of (config, corpus, queryset):
 * nothing touches the network at eval time, so runs are reproducible and fast.
 */

/** Broad category of information need. Metrics are reported per category. */
export type QueryCategory =
    | "api-docs"        // "react useEffect cleanup function"
    | "debugging"       // "ERR_PNPM_OUTDATED_LOCKFILE frozen lockfile"
    | "conceptual"      // "what is BM25 ranking"
    | "how-to"          // "set up vitest coverage thresholds"
    | "version-specific"// "tailwind v4 css-first config migration"
    | "comparison"      // "pnpm vs npm workspaces"
    | "general";        // non-technical tail

/**
 * A nugget anchor group. ALL groups in a nugget must be satisfied; a group is
 * satisfied if ANY of its terms appears in the candidate text.
 *
 * Terms are matched as normalized substrings, so a stem-like prefix
 * ("dependenc") matches "dependency" and "dependencies" without needing a
 * stemmer at eval time. Keep terms lowercase.
 */
export type AnchorGroup = string[];

/**
 * An atomic fact a good answer must contain.
 *
 * Written once, by hand, against the full page text. The intelligence goes in
 * at authoring time so that scoring stays deterministic and model-free — that
 * is what makes the iterate loop cost seconds instead of minutes.
 */
export interface Nugget {
    id: string;
    /** Human-readable statement of the fact. Not used for matching. */
    text: string;
    /** ALL groups must match; ANY term within a group satisfies it. */
    anchors: AnchorGroup[];
    /**
     * Optional regex (source string, matched case-insensitively) that must also
     * match. Use for exact strings: error codes, API signatures, flags.
     */
    pattern?: string;
    /**
     * Max characters between the first and last matched anchor. Guards against
     * a nugget being "found" because its terms are scattered across an
     * unrelated excerpt. Omit to allow anywhere within a single excerpt.
     */
    window?: number;
    /** Relative importance. Defaults to 1. */
    weight?: number;
    /** URLs known to contain this nugget. Enables extraction-only scoring. */
    sources?: string[];
}

/** How good a source is for a given query. Drives retrieval metrics. */
export type SourceGrade =
    | "canonical"   // the authoritative source (official docs, the spec, the repo)
    | "good"        // accurate and useful, but not authoritative
    | "acceptable"  // partially useful
    | "bad";        // SEO farm, wrong, outdated, contentless

export interface SourceLabel {
    /** Exact URL, or a domain to grade every URL from that host. */
    match: string;
    grade: SourceGrade;
    note?: string;
}

export interface Query {
    id: string;
    text: string;
    category: QueryCategory;
    /** 1 = easy lexical match, 3 = requires synonym/structure understanding. */
    difficulty: 1 | 2 | 3;
    /**
     * Labeling wave. Tranche 1 is the ~60-query set labeled first to validate
     * the nugget format against a real scoreboard before the rest is authored.
     */
    tranche?: 1 | 2;
    note?: string;
}

/** Labels for one query. Authored once, reused across every run. */
export interface QueryLabel {
    queryId: string;
    nuggets: Nugget[];
    sources: SourceLabel[];
    /** ISO timestamp of authoring, for staleness tracking. */
    labeledAt: string;
    /** Free-form note on what a good answer looks like. */
    rubric?: string;
}

/** One excerpt as returned by a pipeline under test. */
export interface RunExcerpt {
    text: string;
    headingPath: string[];
    score: number;
}

/** One page's contribution to a run's output for a query. */
export interface RunPage {
    url: string;
    title: string;
    rank: number;
    excerpts: RunExcerpt[];
    charCount: number;
}

/** The output of one pipeline invocation for one query. */
export interface RunQueryResult {
    queryId: string;
    pages: RunPage[];
    /** URLs the pipeline actually saw and could have chosen, pre-filtering. */
    consideredUrls: string[];
    /**
     * Every URL the search engine returned, before the pipeline truncated the
     * list. Kept separately from `consideredUrls` so a missing canonical source
     * can be attributed: absent here means the search engine never surfaced it,
     * present here but absent from the output means our own filtering dropped
     * it. Those two failures have opposite fixes.
     */
    serpUrls?: string[];
    totalChars: number;
    durationMs: number;
    error?: string;
}

/** A complete evaluation run. Written to eval/runs/<id>.json. */
export interface Run {
    id: string;
    /** Which pipeline produced this: "v1", "v2", etc. */
    pipeline: string;
    /** Serialized config, so a run is fully reproducible. */
    config: unknown;
    corpusRevision: string;
    startedAt: string;
    results: RunQueryResult[];
}

/**
 * Where a nugget was found. Recorded per match so `--diff` can explain a
 * regression down to the excerpt that used to carry the fact.
 */
export interface NuggetMatch {
    nuggetId: string;
    matched: boolean;
    /** URL of the page whose excerpt matched. */
    pageUrl?: string;
    /** Index of the matching excerpt within that page. */
    excerptIndex?: number;
    /** Smallest span (chars) containing one term from every anchor group. */
    span?: number;
}

/** Per-query scoring detail. This is what --diff compares. */
export interface QueryScore {
    queryId: string;
    category: QueryCategory;
    /** Nuggets found in the returned excerpts, by nugget id. */
    nuggetsFound: string[];
    nuggetsMissed: string[];
    /** Full match detail, including where each hit landed. */
    matches: NuggetMatch[];
    /** Weighted fraction of nuggets recovered. The headline extraction metric. */
    nuggetRecall: number;
    /**
     * Nugget recall counting ONLY nuggets whose declared source page was
     * actually returned. Isolates extraction quality from retrieval quality:
     * if we fetched the right page, did we pull the right passage out of it?
     *
     * `null` when no labeled nugget's source page was returned — the metric is
     * undefined for that query and must be skipped by the macro-average, not
     * counted as zero.
     */
    conditionalNuggetRecall: number | null;
    /** Fraction of returned pages graded canonical or good. */
    sourcePrecision: number;
    /**
     * Fraction of returned pages that carry ANY grade. `sourcePrecision` is
     * computed over graded pages only, so a high score against a low
     * gradedFraction is measuring almost nothing — this keeps that visible
     * instead of letting thin label coverage read as a good result.
     */
    gradedFraction: number;
    /** 1 / rank of the first canonical source, or 0. */
    canonicalMrr: number;
    /** Did any returned page carry a bad grade? */
    badSourcesReturned: string[];
    /**
     * Fraction of returned pages carrying ANY grade that are graded `bad`.
     * Isolates "returned a content farm / wrong / contentless page" from
     * `sourcePrecision`, which also penalizes `acceptable` pages - a
     * topicality judgment, not a trust judgment. Lower is better; 0 is the
     * goal. Computed over graded pages only, same denominator convention as
     * `sourcePrecision`.
     *
     * `null` when the query returned no graded pages - the metric is
     * undefined for that query and must be skipped by the macro-average, not
     * counted as zero.
     */
    badRate: number | null;
    /** Weighted nuggets recovered per 1000 characters returned. */
    efficiency: number;
    totalChars: number;
}

export interface CategoryScore {
    category: QueryCategory;
    queryCount: number;
    nuggetRecall: number;
    /** Null when no query in this category had a scorable conditional case. */
    conditionalNuggetRecall: number | null;
    sourcePrecision: number;
    /**
     * Macro-average of badRate over queries with at least one graded page.
     * Null when no query in this category had any graded page.
     */
    badRate: number | null;
    canonicalMrr: number;
    efficiency: number;
}

export interface Scoreboard {
    runId: string;
    pipeline: string;
    queryCount: number;
    /** Headline numbers, macro-averaged over queries. */
    nuggetRecall: number;
    /** Macro-average over queries where it is defined; null if none are. */
    conditionalNuggetRecall: number | null;
    sourcePrecision: number;
    /** Macro-average over queries with at least one graded page; null if none. */
    badRate: number | null;
    canonicalMrr: number;
    efficiency: number;
    avgChars: number;
    /**
     * Queries in the run that carry no label and were therefore not scored.
     * Belongs in the scoreboard rather than a log line: while labeling is
     * partial, every headline number is an average over a subset, and reading
     * it as though it covered the whole query set would be wrong.
     */
    skippedQueryIds: string[];
    byCategory: CategoryScore[];
    byQuery: QueryScore[];
}
