/**
 * v2 document model.
 *
 * v1 flattens HTML into a list of sentences and scores those. That discards
 * almost everything a page uses to say what it means: tables, code-block
 * languages, link targets, dates, and — most damagingly for search — the vote
 * counts and accepted-answer flags that say which answer on a Q&A page is the
 * right one. It then spends three modules reassembling sentences into passages
 * it had already destroyed.
 *
 * v2 keeps the structure. Documents parse into a typed node tree, passages are
 * built from that tree as the retrieval unit, and structural facts stay
 * attached to the text they describe so ranking can use them.
 */

/**
 * What a node IS, semantically. The kind drives both ranking priors and how a
 * passage renders, so it must describe meaning rather than the HTML tag that
 * happened to carry it — `<div class="note">` and `<aside>` are both callouts.
 */
export type NodeKind =
    | "heading"
    | "prose"
    | "code"
    | "list-item"
    | "table"
    | "quote"
    | "callout"      // note/warning/tip admonitions
    | "definition"   // term + description, dl/dt/dd and API parameter lists
    | "question"     // Q&A body
    | "answer";      // Q&A answer body

/** A link kept with its anchor text. Anchor text is often the best description of the target that exists. */
export interface DocLink {
    text: string;
    href: string;
}

/**
 * One semantic unit of a document.
 *
 * `order` is the sole source of document sequence; passages are contiguous
 * runs of it. Everything optional is a signal v1 threw away.
 */
export interface DocNode {
    kind: NodeKind;
    text: string;
    /** Position in document order, 0-based and dense. */
    order: number;
    /** Ancestor headings, nearest last. */
    headingPath: string[];
    /** 1-6, headings only. */
    level?: number;
    /** Language of a code block, when the page declares one. */
    lang?: string;
    /** Links found inside this node. */
    links?: DocLink[];

    // Q&A signals. Present only on question/answer nodes, and the reason a
    // Q&A page can be ranked by what the community actually endorsed rather
    // than by where the text sits on the page.
    votes?: number;
    accepted?: boolean;
    author?: string;
    /** ISO date when the page states one. */
    date?: string;
}

/**
 * What KIND of page this is. Detected from the document itself rather than
 * supplied by the caller: asking the calling model to declare "this is
 * technical, search lower in the page" pushes a guess onto someone with less
 * information than we have. The page already announces what it is.
 */
export type PageKind =
    | "reference"   // API docs: signatures, parameters, return values
    | "guide"       // tutorial, how-to, narrative documentation
    | "qa"          // Stack Exchange, forum thread, GitHub discussion
    | "issue"       // bug report / issue tracker
    | "changelog"   // release notes, migration guide
    | "spec"        // RFC, standard, formal specification
    | "blog"
    | "listicle"    // SEO-shaped listicle; a ranking signal in its own right
    | "unknown";

/** How the document was obtained. Structured sources beat scraped HTML. */
export type DocSource =
    | "html"
    | "markdown"        // .md sibling or llms.txt
    | "stackexchange"   // API: carries real votes and accepted flags
    | "github"          // API or raw README
    | "registry";       // npm/PyPI metadata

/** A parsed document. */
export interface Doc {
    url: string;
    /** After redirects, when different. */
    finalUrl?: string;
    title: string;
    kind: PageKind;
    source: DocSource;
    nodes: DocNode[];
    /** ISO publication date when the page states one. Drives staleness priors. */
    publishedAt?: string;
    /** Detected content language; non-English pages are usually the wrong result. */
    lang?: string;
    /** Why `kind` was chosen. Kept for debugging a misranked page. */
    kindEvidence?: string;
}

/**
 * The retrieval unit.
 *
 * A contiguous run of nodes under one heading, capped by character count and
 * never splitting a code block. Scoring passages directly is what removes
 * v1's anchor -> expand -> dedupe round trip: there is nothing to reassemble
 * because nothing was taken apart.
 */
export interface Passage {
    id: string;
    docUrl: string;
    headingPath: string[];
    /**
     * Display text, INCLUDING the heading prefix. This is what gets returned to
     * the caller and what nugget matching runs against, so the heading belongs
     * in it — a heading is often the clearest statement of what follows.
     */
    text: string;
    /**
     * The same passage WITHOUT the heading prefix.
     *
     * Score lexical relevance against this, never against `text`. `text`
     * repeats the heading that `PassageScore.headingMatch` already scores from
     * `headingPath`, so scoring both counts every heading term twice and
     * quietly biases ranking toward passages that happen to sit under a
     * keyword-stuffed heading — which is exactly what SEO pages have.
     */
    bodyText?: string;
    charCount: number;
    /** Inclusive node-order bounds, for merging and adjacency checks. */
    startOrder: number;
    endOrder: number;
    /** Kinds present, for structural scoring without walking nodes again. */
    kinds: NodeKind[];
    hasCode: boolean;
    /**
     * Kind of the document this came from. Structural priors are conditional on
     * it — early text is the signature on a reference page and filler on a
     * listicle — so the scorer needs it without threading the whole Doc.
     */
    pageKind?: PageKind;
    /** How the document was obtained; structured sources are more trustworthy. */
    source?: DocSource;
    /** Carried up from an answer node so a passage can be ranked by endorsement. */
    votes?: number;
    accepted?: boolean;
    /** Author of the post this passage came from. A passage never spans two. */
    author?: string;
    /** ISO date of the post or page, for recency weighting. */
    date?: string;
}

/** Per-passage scoring breakdown. Every component is inspectable so a bad ranking can be explained rather than guessed at. */
export interface PassageScore {
    passageId: string;
    /** Lexical relevance over passages, with corpus-level IDF. */
    bm25: number;
    /** Exact hits on quoted phrases, error strings, and symbols. */
    exact: number;
    /** Query terms matched in the heading path. */
    headingMatch: number;
    /** Prior from node kinds and page kind. */
    structure: number;
    /** Q&A endorsement: accepted flag and vote count. */
    endorsement: number;
    /** Optional dense-similarity contribution; 0 when disabled. */
    semantic: number;
    combined: number;
}

/** Trust in the SOURCE, independent of how well its text matches the query. This is the axis v1 has no representation of at all. */
export interface Authority {
    /** 0-1. */
    score: number;
    /** Is this the project's own documentation for the thing being asked about? */
    canonical: boolean;
    reasons: string[];
}

/** A query, understood rather than just tokenized. */
export interface ParsedQuery {
    raw: string;
    /** Terms for lexical scoring, stemmed and stopworded. */
    terms: string[];
    /** Phrases the user quoted; these must match exactly. */
    phrases: string[];
    /** Error strings and codes: ERR_PNPM_OUTDATED_LOCKFILE, exit 137, TS2345. */
    errorStrings: string[];
    /** Code identifiers: useEffect, spawn_blocking, map_or_else. */
    symbols: string[];
    /** Version constraints mentioned: "v4", "18", "1.22". */
    versions: string[];
    /** Search-engine operators, passed through untouched. */
    operators: string[];
}
