/**
 * Source authority.
 *
 * Trust in the SOURCE, independent of how well its text matches the query.
 * v1 has no representation of this axis at all, which is why a content farm
 * that has optimized its title and URL for the query outranks the project's own
 * documentation: on a pure text-match score, the farm genuinely does look
 * better, because looking better is the entire product.
 *
 * A measured caution runs through the weights here. At least one content-farm
 * network in the eval corpus writes technically ACCURATE mechanism
 * explanations while fabricating the statistics around them. Suppressing such
 * a page outright would trade source-precision gains for nugget-recall losses.
 * So authority is built to REORDER strongly and SUPPRESS only at the extreme —
 * the suppression decision itself lives in `assemble.ts`, and this module's job
 * is to produce a defensible score with its reasoning attached.
 *
 * WHAT THE SIGNALS ARE DERIVED FROM
 * ---------------------------------
 * Every negative below states a mechanism about the DOCUMENT AS PARSED, not a
 * fact about a hostname. That is deliberate: a hostname blocklist scores well
 * on a labelled set and transfers nothing. The three host lists that remain
 * (standards bodies, primary sources, social platforms) are claims about a
 * CATEGORY of publisher, are small, and are listed together at the top of the
 * reference-data section so their size stays visible.
 *
 * The dominant failure the negatives are built for is not the elaborate content
 * farm — it is the page that fetches with HTTP 200 and yields no article:
 * a teaser grid of links to other posts, a newsletter gate, a nav-only
 * reference stub, a marketing splash. Such a page still has a title and a URL
 * that match the query perfectly, so lexical ranking loves it and it is
 * returned in place of a page that answers. Those are caught by measuring how
 * much of the extracted body is anchor text (`linkIndex`), whether any
 * paragraph is long enough to state a fact (`noSubstance`), and how much body
 * there is at all (`thinBody` and `emptyBody`).
 *
 * WHAT THIS MODULE STILL CANNOT SEE
 * ---------------------------------
 * Eight further page-shape signals were built and measured against the 466
 * graded documents of tranche 1 and are NOT here, because they did not beat the
 * corpus baseline of 13.9% bad / 61.2% good-or-canonical:
 *
 *   FAQ-shaped question headings          16.7% bad / 65.7% good  (backwards)
 *   heading-to-prose density              13.6% bad / 58.0% good  (backwards)
 *   short average paragraph length        10.7% bad / 56.2% good  (backwards)
 *   repeated sentence openings             5.2% bad / 77.6% good  (backwards)
 *   any year token in the URL path         2.2% bad / 69.6% good  (backwards)
 *   query-term coverage of the body       fires only on video pages already
 *                                         caught by `socialOrForum`
 *   omitting a term every peer states     23.7% bad / 52.6% good, and fires on
 *                                         MDN, eslint.org and pkg.go.dev
 *   peer support for the page's own
 *     characteristic vocabulary           noisy, and fires on serde.rs and
 *                                         doc.rust-lang.org
 *
 * The population they were built for — a well-formed page that keyword-matches
 * a question it does not answer, or an accurate explanation wrapped around a
 * vendor's pitch — is not separable by document shape. Those pages look exactly
 * like good pages, which is the point of them. `peerCited` below is the only
 * signal found that reaches them at all, and it reaches them by asking someone
 * else.
 */

import type { Authority, Doc, DocNode, ParsedQuery } from "./types";

// =============================================================================
// Peer citation
// =============================================================================
//
// The one piece of third-party evidence available offline.
//
// Everything else in this module reads a page in isolation and asks what it
// looks like. That is structurally blind to the failure that matters most: an
// SEO page and a project's own manual can have identical shape. What separates
// them is that other people cite the manual.
//
// The candidate set for a query is a sample of ~16 pages that a search engine
// thinks are about the same topic, and their outbound links are a small,
// on-topic citation graph that costs nothing to build — the links are already
// parsed. Measured over the 466 graded documents of tranche 1, against a
// baseline of 13.9% bad / 61.2% good-or-canonical / 15.5% canonical:
//
//   cited by >= 1 peer:  109 graded, bad 10.1%, good 75.2%, canonical 56.9%
//   cited by >= 2 peers:  68 graded, bad  7.4%, good 79.4%, canonical 72.1%
//   cited by >= 3 peers:  49 graded, bad  4.1%, good 87.8%, canonical 83.7%
//   cited by >= 4 peers:  29 graded, bad  0.0%, good 93.1%, canonical 93.1%
//   cited by no peer:    357 graded, bad 15.1%, good 56.9%
//
// The zero bucket is indistinguishable from the corpus baseline, which is why
// this is a POSITIVE ONLY: not being cited is uninformative, and penalising it
// would cost recall on the many good pages nobody in a 16-page sample happened
// to link. Every one of the bad pages v2 returned before this signal existed
// sits at zero or one.

/**
 * Hosts that publish many unrelated authors under one domain. On these the
 * publisher is the FIRST PATH SEGMENT, not the hostname: a page linking to
 * `github.com/tokio-rs/tokio` endorses tokio, not every repository on GitHub.
 *
 * The one host list in this module that is not a claim about a category of
 * publisher, and it earns its place by measurement: collapsing these to their
 * domain drops the signal from 7.4% bad / 72.1% canonical at two citations to
 * 9.8% / 59.8%, because every mention of any repository would otherwise endorse
 * every other one.
 */
const MULTI_TENANT_HOSTS = [
    "github.com", "gitlab.com", "bitbucket.org", "sourceforge.net",
    "medium.com", "dev.to", "substack.com", "wordpress.com", "blogspot.com",
    "readthedocs.io", "gitbook.io", "notion.site", "netlify.app", "vercel.app",
    "github.io", "pages.dev", "npmjs.com", "pypi.org", "crates.io",
    "stackoverflow.com", "reddit.com",
];

/**
 * Who PUBLISHED a URL, as a comparable string.
 *
 * The registrable domain, so `docs.python.org` and `python.org` are one
 * publisher; extended with the first path segment on the multi-tenant hosts
 * above, where the domain is a landlord rather than an author.
 */
function publisherIdentity(url: string): string {
    let host = "";
    let path = "";
    try {
        const parsed = new URL(url);
        host = parsed.hostname.toLowerCase().replace(/^www\./, "");
        path = parsed.pathname;
    } catch {
        return "";
    }
    if (host === "") return "";

    const labels = host.split(".");
    const domain = labels.length <= 2 ? host : labels.slice(-2).join(".");
    if (!MULTI_TENANT_HOSTS.includes(domain)) return domain;

    const segment = path.split("/").filter((part) => part.length > 0)[0] ?? "";
    return `${domain}/${segment.toLowerCase()}`;
}

/**
 * How many OTHER documents in the candidate set link to each document's
 * publisher, keyed by `Doc.url`.
 *
 * Self-links never count — a site linking to itself is navigation — and each
 * peer is counted once however many times it links, so a page with fifty
 * footnotes to the same manual is one endorsement rather than fifty.
 */
export function computePeerCitations(docs: Doc[]): Map<string, number> {
    const identities = docs.map((doc) => publisherIdentity(doc.finalUrl ?? doc.url));

    const outbound: Array<Set<string>> = docs.map((doc, index) => {
        const own = identities[index] ?? "";
        const targets = new Set<string>();
        for (const node of doc.nodes) {
            for (const link of node.links ?? []) {
                const target = publisherIdentity(link.href);
                if (target !== "" && target !== own) targets.add(target);
            }
        }
        return targets;
    });

    const citations = new Map<string, number>();
    for (let i = 0; i < docs.length; i++) {
        const identity = identities[i] ?? "";
        let count = 0;
        if (identity !== "") {
            for (let j = 0; j < docs.length; j++) {
                if (i === j) continue;
                if (outbound[j]?.has(identity) === true) count++;
            }
        }
        const doc = docs[i];
        if (doc !== undefined) citations.set(doc.url, count);
    }
    return citations;
}

// =============================================================================
// Config
// =============================================================================

export interface AuthorityConfig {
    /** Neutral starting point, so evidence can push both ways. */
    base: number;
    /** The domain is the library's declared homepage or repository. */
    declaredHomepage: number;
    /** A query term is the domain's own name: `react` -> react.dev. */
    domainNameMatch: number;
    /** The project's own domain, serving reference/documentation content. */
    projectDocs: number;
    /** URL sits under /docs/, /reference/, /api/, /manual/ — only on a topically related host. */
    docsUrlShape: number;
    /** ietf.org, w3.org, whatwg.org, and friends. */
    standardsBody: number;
    /** Primary sources and regulators for the non-technical tail: *.gov, *.edu. */
    primarySource: number;
    /** Reached through a structured adapter rather than scraped HTML. */
    structuredSource: number;
    /** Page kind was detected as `listicle`. */
    listicleKind: number;
    /** "10 best", "top N", "ultimate guide" in the title. */
    listicleTitle: number;
    /** Affiliate / self-referential link density. */
    linkFarm: number;
    /** Most of the extracted body is anchor text: a teaser grid, not an article. */
    linkIndex: number;
    /** No paragraph long enough to state a fact. */
    noSubstance: number;
    /** Barely any extracted body at all. */
    thinBody: number;
    /** The page repeatedly names its own product, which the query never asked about. */
    selfPromotion: number;
    /** A code-shaped query answered by a page containing no code at all. */
    noCodeOnTechnical: number;
    /** Page declares a non-English content language. */
    nonEnglish: number;
    /** General-purpose social or forum host: an opinion, not a source. */
    socialOrForum: number;
    /** A year welded onto the end of a slug — the signature of an SEO refresh cycle. */
    seoYearSlug: number;
    /**
     * Value of being cited by other documents in the same candidate set, at
     * `peerCitationSaturation` citations. Scaled linearly below that.
     */
    peerCited: number;
    /** Citations at which `peerCited` is paid in full. */
    peerCitationSaturation: number;
    /** Citations at or above which the page is treated as canonical for the query. */
    peerCitationCanonical: number;
    /**
     * Extra penalty on top of `thinBody` for a document with almost no body at
     * all. Measured on tranche 1: under 500 extracted characters a page is 86.7%
     * bad and 13.3% good-or-canonical (n=15) — a different population from the
     * merely short page, and one that by definition costs no recall to demote.
     */
    emptyBody: number;
    /** At or above this, `canonical` is set even without a direct canonical signal. */
    canonicalThreshold: number;
    /**
     * Hard floor on the score.
     *
     * Above zero on purpose. A page that looks bad on every structural signal is
     * still not certainly worthless — the content farms in this corpus write
     * accurate mechanism explanations around fabricated statistics — and a true
     * zero would let assembly multiply a passage out of existence, converting a
     * source-precision judgement into a nugget-recall loss.
     */
    floor: number;
}

export const DEFAULT_AUTHORITY_CONFIG: AuthorityConfig = {
    base: 0.5,
    declaredHomepage: 0.3,
    domainNameMatch: 0.2,
    projectDocs: 0.18,
    docsUrlShape: 0.08,
    standardsBody: 0.3,
    primarySource: 0.22,
    structuredSource: 0.08,
    listicleKind: -0.06,
    listicleTitle: -0.06,
    linkFarm: -0.25,
    linkIndex: -0.6,
    noSubstance: -0.45,
    thinBody: -0.3,
    selfPromotion: -0.25,
    noCodeOnTechnical: -0.12,
    nonEnglish: -0.15,
    socialOrForum: -0.45,
    seoYearSlug: -0.05,
    peerCited: 0.28,
    peerCitationSaturation: 3,
    peerCitationCanonical: 3,
    emptyBody: -0.25,
    canonicalThreshold: 0.85,
    floor: 0.05,
};

export interface AuthorityContext {
    /**
     * Hostnames known to be the declared homepage or repository of a library
     * the query names. Resolved OUT of band (see `resolveHomepage` in
     * `fetch/registry.ts`) and passed in, because that lookup is a network call
     * and authority scoring must stay usable offline — an eval replay never
     * touches the network.
     */
    canonicalHosts?: Set<string>;
    /**
     * How many other documents in this query's candidate set cite this
     * document's publisher. Supplied by the caller because it is a property of
     * the SET, not of the document — see `computePeerCitations`.
     */
    peerCitations?: number;
    config?: AuthorityConfig;
}

// =============================================================================
// Reference data
// =============================================================================
//
// THE COMPLETE SET OF HOST LISTS IN THIS MODULE IS THE THREE BELOW.
// Each is a claim about a category of publisher rather than a record of who
// misbehaved on one labelled corpus. Nothing else in this file names a host.

/** Standards bodies: the document IS the definition of the thing being asked about. */
const STANDARDS_HOSTS = [
    "ietf.org",
    "rfc-editor.org",
    "w3.org",
    "whatwg.org",
    "unicode.org",
    "iana.org",
    "iso.org",
    "ecma-international.org",
    "tc39.es",
    "khronos.org",
    "oasis-open.org",
    "postgresql.org",
];

/**
 * Primary sources and regulators for the non-technical tail. The generic
 * `.gov` / `.edu` / `.gov.uk` suffix rules cover irs.gov, fda.gov, cfpb.gov,
 * nih.gov and usda.gov; this list is for the ones that carry no such suffix.
 */
const PRIMARY_SOURCE_HOSTS = ["who.int", "europa.eu", "un.org", "oecd.org", "imf.org", "worldbank.org"];

/**
 * General-purpose social and video hosts: places where the content is someone's
 * opinion rather than anyone's documentation, or is not text at all.
 *
 * This is a structural claim about the KIND of host, not a blocklist of
 * offenders — which is why the endorsed-Q&A sources are excluded below rather
 * than swept up here. A Stack Overflow answer with 400 votes and a green tick
 * is a different object from a Reddit thread, and v2's whole endorsement
 * component exists to rank the former.
 */
const SOCIAL_HOSTS = [
    "reddit.com", "quora.com", "youtube.com", "youtu.be", "linkedin.com",
    "facebook.com", "twitter.com", "x.com", "instagram.com", "tiktok.com",
    "pinterest.com", "threads.net", "tumblr.com",
];

/** Endorsed Q&A, exempt from the social penalty: these carry votes and accepted flags. */
const ENDORSED_QA_HOSTS = [
    "stackoverflow.com", "stackexchange.com", "serverfault.com",
    "superuser.com", "askubuntu.com", "github.com",
];

// --- Shape rules (no hostnames) ----------------------------------------------

/** URL shapes that say "this is the manual", not "this is an article about the manual". */
const DOCS_PATH = /(^|\/)(docs?|documentation|reference|api|api-reference|manual|handbook|spec|specification)(\/|$)/i;

/** SEO listicle titles. Matched against the page title, not the URL — `pagekind.ts` already reads the URL. */
const LISTICLE_TITLE =
    /(^|\W)(\d{1,2}|top|ten)\s+(best|worst|ways?|tips|tools|reasons|things|steps|examples|alternatives|practices|hacks|mistakes|benefits|must[- ]have)\b|\bultimate\s+guide\b|\bcomplete\s+guide\s+to\b|\beverything\s+you\s+need\s+to\s+know\b/i;

/** Discourse-style forum subdomains: `discuss.python.org`, `users.rust-lang.org`, `community.temporal.io`. */
const FORUM_SUBDOMAIN = /^(discuss|forum|forums|community|users|answers|ask)\./i;

/**
 * A year welded onto the END of a slug — `pnpm-vs-npm-2026`, `grpc-vs-rest-2026`.
 *
 * Deliberately narrow. The obvious rule ("a year anywhere in the path") is
 * WRONG in the measured direction: dated blog permalinks (`/2019/03/post`)
 * carry a year as its own path segment and grade well, so a general year rule
 * penalises ordinary blogs and barely touches the farms. What identifies an SEO
 * refresh is specifically the trailing year, because the year is what makes
 * last year's article rank again this year.
 */
const SEO_YEAR_SLUG = /-(?:19|20)\d{2}\/?$/;

/** Query-string and path shapes that mark a monetized outbound link. */
const AFFILIATE_LINK = /[?&](aff|affid|affiliate|irclickid|partnerid|clickid)=/i;
const AFFILIATE_PATH = /\/(recommends|coupon|coupons)\//i;

/** Words too generic to identify a domain as a library's own. */
const GENERIC_DOMAIN_WORDS = new Set([
    "api", "app", "apps", "blog", "cloud", "code", "data", "dev", "doc", "docs",
    "get", "guide", "help", "how", "info", "learn", "net", "new", "news", "org",
    "site", "sites", "the", "tool", "tools", "use", "web", "www",
]);

/** Suffix labels that never carry a brand name, used when picking a host's brand label. */
const TLD_LABELS = new Set([
    "com", "org", "net", "int", "edu", "gov", "mil", "co", "io", "dev", "app",
    "ai", "sh", "rs", "run", "es", "eu", "uk", "us", "au", "ca", "de", "fr",
    "jp", "in", "cn", "br", "nl", "se", "no", "it", "ru", "info", "me", "xyz",
    "tech", "site", "online", "cloud", "page", "land", "team", "tools", "to",
]);

// =============================================================================
// Thresholds
// =============================================================================
//
// Each is a decision boundary on a measured distribution, quoted from tranche 1
// so a later tuner can see what it is moving away from.

/**
 * A node counts as "substantive" at 200 characters — roughly two sentences,
 * which is the shortest span that can state a fact with its mechanism.
 */
const SUBSTANTIVE_NODE_CHARS = 200;

/** Longest node on a page with nothing substantive; below this the page is a stub or a nav dump. */
const STUB_MAX_NODE_CHARS = 400;

/** Extracted body below this is not an article. */
const THIN_BODY_CHARS = 1200;

/** Extracted body below this is not a page: a title, a nav bar, and nothing else. */
const EMPTY_BODY_CHARS = 500;

/**
 * Fraction of a node's characters that must be anchor text before the node is
 * classed as a link rather than as prose.
 */
const NODE_IS_LINK_RATIO = 0.6;

/**
 * Fraction of the whole extracted body that must be link nodes before the page
 * is classed as an index of other pages rather than a page.
 */
const PAGE_IS_LINK_INDEX_RATIO = 0.5;

/** Mentions of the host's own brand per 1000 body characters that read as marketing. */
const SELF_PROMOTION_PER_1K = 3;

/** Below this many body characters the brand-density ratio is too noisy to trust. */
const SELF_PROMOTION_MIN_BODY = 1500;

// =============================================================================
// Helpers
// =============================================================================

function clamp(value: number, low: number, high: number): number {
    if (value < low) return low;
    if (value > high) return high;
    return value;
}

interface UrlParts {
    host: string;
    path: string;
}

function splitUrl(url: string): UrlParts {
    try {
        const parsed = new URL(url);
        return { host: parsed.hostname.toLowerCase().replace(/^www\./, ""), path: parsed.pathname };
    } catch {
        return { host: "", path: url };
    }
}

function hostMatches(host: string, suffixes: string[]): string | null {
    for (const suffix of suffixes) {
        if (host === suffix || host.endsWith(`.${suffix}`)) return suffix;
    }
    return null;
}

/**
 * Words from the raw query that could name a project: alphanumeric runs of 3+
 * characters, plus the pieces of any dotted or scoped symbol. Deliberately NOT
 * the stemmed `terms` — a domain is a proper noun and stemming mangles it
 * (`vitest` -> `vitest`, but `docs` -> `doc`, `express` -> `express`, and
 * `angular` -> `angular` only by luck).
 */
function projectWords(query: ParsedQuery): Set<string> {
    const words = new Set<string>();
    const add = (raw: string): void => {
        const word = raw.toLowerCase();
        if (word.length < 3 || GENERIC_DOMAIN_WORDS.has(word)) return;
        words.add(word);
    };

    for (const piece of query.raw.toLowerCase().split(/[^a-z0-9]+/)) add(piece);
    for (const symbol of query.symbols) {
        for (const piece of symbol.toLowerCase().split(/[^a-z0-9]+/)) add(piece);
    }
    return words;
}

/**
 * Suffixes and prefixes a project's own name legitimately picks up in a domain
 * label: `tailwind` -> `tailwindcss`, `serde` -> `serde-rs`, `vite` -> `vitejs`.
 *
 * Anything else the label adds makes it a DIFFERENT name — `reacttraining` is a
 * training company, not React — which is the failure this list exists to stop.
 */
const PROJECT_NAME_AFFIX = /^(js|ts|css|lang|py|rs|go|rb|db|sql|ui|api|io|hq|labs?|team|core|official)+$/;

/**
 * Is one of the query's project words the domain's own name?
 *
 * An exact label match (`react` === `react` in react.dev) always counts. A
 * containment match counts only when what the label ADDS to the word is either
 * trivially short or a known project affix.
 *
 * Measured on tranche 1, against a baseline of 13.9% bad / 61.2%
 * good-or-canonical:
 *
 *   the rule as written here:            40 graded, bad  0.0%, good 87.5%
 *   the containment matches it rejects:   7 graded, bad 14.3%, good 28.6%
 *
 * The rejected set is worse than the corpus average on both axes, so the old
 * unrestricted containment was handing +0.2 authority — and, when the URL also
 * looked like documentation, a `canonical` flag — to pages that are on average
 * less trustworthy than a page picked at random.
 */
function domainNamesProject(host: string, words: Set<string>): string | null {
    if (host === "") return null;
    const labels = host.split(".");
    for (const label of labels) {
        if (label.length < 2) continue;
        for (const word of words) {
            if (label === word) return `${word} == ${host}`;
            if (word.length < 5 || !label.includes(word)) continue;
            const remainder = label.split(word).join("");
            if (remainder.length <= 2 || PROJECT_NAME_AFFIX.test(remainder)) {
                return `${word} in ${host}`;
            }
        }
    }
    return null;
}

/**
 * The host's brand label: the longest label that is not a public suffix.
 *
 * `graftcode.com` -> `graftcode`, `blog.logrocket.com` -> `logrocket`,
 * `docs.getunleash.io` -> `getunleash`.
 */
function brandLabel(host: string): string {
    let brand = "";
    for (const label of host.split(".")) {
        if (TLD_LABELS.has(label)) continue;
        if (label.length > brand.length) brand = label;
    }
    return brand;
}

interface LinkStats {
    total: number;
    affiliate: number;
    selfReferential: number;
    perNode: number;
}

function linkStats(doc: Doc, host: string): LinkStats {
    let total = 0;
    let affiliate = 0;
    let selfReferential = 0;

    for (const node of doc.nodes) {
        for (const link of node.links ?? []) {
            total++;
            if (AFFILIATE_LINK.test(link.href) || AFFILIATE_PATH.test(link.href)) {
                affiliate++;
                continue;
            }
            const linkHost = splitUrl(link.href).host;
            if (linkHost === "" || linkHost === host) selfReferential++;
        }
    }

    return {
        total,
        affiliate,
        selfReferential,
        perNode: doc.nodes.length > 0 ? total / doc.nodes.length : 0,
    };
}

/** Node kinds that can carry a stated fact. A heading cannot; a code block is not prose. */
function isProseKind(node: DocNode): boolean {
    return (
        node.kind === "prose" ||
        node.kind === "list-item" ||
        node.kind === "definition" ||
        node.kind === "callout" ||
        node.kind === "quote" ||
        node.kind === "question" ||
        node.kind === "answer" ||
        node.kind === "table"
    );
}

/**
 * A node is a LINK rather than prose when most of its characters are anchor
 * text: `Read next: How to migrate to v4` is a teaser, not a sentence.
 */
function isLinkNode(node: DocNode): boolean {
    const links = node.links ?? [];
    if (links.length === 0 || node.text.length === 0) return false;
    let anchorChars = 0;
    for (const link of links) anchorChars += link.text.length;
    return anchorChars / node.text.length > NODE_IS_LINK_RATIO;
}

/** Everything the body-shape signals need, walked once. */
interface BodyShape {
    bodyChars: number;
    /** Prose nodes at or above `SUBSTANTIVE_NODE_CHARS`. */
    substantiveNodes: number;
    /** Longest node of any kind. */
    maxNodeChars: number;
    /** Fraction of body characters sitting in link nodes. */
    linkNodeCharRatio: number;
    hasCode: boolean;
    /** Lowercased body text, for brand counting. */
    bodyText: string;
}

function bodyShape(doc: Doc): BodyShape {
    let bodyChars = 0;
    let substantiveNodes = 0;
    let maxNodeChars = 0;
    let linkChars = 0;
    let hasCode = false;
    const parts: string[] = [];

    for (const node of doc.nodes) {
        const length = node.text.length;
        if (length > maxNodeChars) maxNodeChars = length;
        if (node.kind === "code") hasCode = true;
        if (node.kind === "heading") continue;
        bodyChars += length;
        parts.push(node.text);
        if (isProseKind(node) && length >= SUBSTANTIVE_NODE_CHARS) substantiveNodes++;
        if (isLinkNode(node)) linkChars += length;
    }

    return {
        bodyChars,
        substantiveNodes,
        maxNodeChars,
        linkNodeCharRatio: bodyChars > 0 ? linkChars / bodyChars : 0,
        hasCode,
        bodyText: parts.join(" ").toLowerCase(),
    };
}

/** Non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
    if (needle.length === 0) return 0;
    let count = 0;
    let index = 0;
    for (;;) {
        const at = haystack.indexOf(needle, index);
        if (at === -1) return count;
        count++;
        index = at + needle.length;
    }
}

/**
 * Does the query ask for something that would normally be answered with code?
 *
 * A query naming an identifier (`spawn_blocking`), an error string
 * (`ERR_REQUIRE_ESM`), or a version constraint is asking about software. A page
 * that answers such a query without a single code block is describing the topic
 * from the outside — which is what a marketing page and an SEO summary both do.
 */
function isCodeShapedQuery(query: ParsedQuery): boolean {
    return query.symbols.length > 0 || query.errorStrings.length > 0;
}

// =============================================================================
// Entry point
// =============================================================================

/**
 * Score how much this document's SOURCE should be trusted for this query.
 *
 * `reasons` is always populated, including for a page that scores exactly at
 * base: an unexplained authority score is untunable, and "nothing fired" is
 * itself the explanation.
 */
export function scoreAuthority(doc: Doc, query: ParsedQuery, ctx: AuthorityContext = {}): Authority {
    const config = ctx.config ?? DEFAULT_AUTHORITY_CONFIG;
    const { host, path } = splitUrl(doc.finalUrl ?? doc.url);
    const reasons: string[] = [];

    let score = config.base;
    let canonical = false;

    // --- Positive: is this the source of truth? -----------------------------

    if (ctx.canonicalHosts?.has(host) === true) {
        score += config.declaredHomepage;
        canonical = true;
        reasons.push(`+${config.declaredHomepage} declared homepage/repository for a library in the query`);
    }

    const standards = hostMatches(host, STANDARDS_HOSTS);
    if (standards !== null) {
        score += config.standardsBody;
        canonical = true;
        reasons.push(`+${config.standardsBody} standards body (${standards})`);
    }

    const isGovOrEdu = /(^|\.)(gov|edu|mil)$/.test(host) || /\.gov\.[a-z]{2}$/.test(host);
    const primary = hostMatches(host, PRIMARY_SOURCE_HOSTS);
    if (isGovOrEdu || primary !== null) {
        score += config.primarySource;
        canonical = true;
        reasons.push(`+${config.primarySource} primary source / regulator (${host})`);
    }

    const nameMatch = domainNamesProject(host, projectWords(query));
    if (nameMatch !== null) {
        score += config.domainNameMatch;
        reasons.push(`+${config.domainNameMatch} domain names the project (${nameMatch})`);
    }

    // A documentation URL shape is only evidence when the documentation belongs
    // to the thing being asked about. Measured on tranche 1: a /docs/ path on a
    // host the query names is 92% good-or-canonical, while a /docs/ path on an
    // unrelated host is 48% — no better than the corpus average, because that is
    // exactly the shape of posthog.com/docs/libraries/node answering a question
    // about node's fetch. Rewarding the shape unconditionally promotes an
    // unrelated vendor's manual over the right project's blog post.
    const docsShape = DOCS_PATH.test(path);
    const relatedHost = nameMatch !== null || canonical;
    if (docsShape && relatedHost) {
        score += config.docsUrlShape;
        reasons.push(`+${config.docsUrlShape} documentation URL shape on a related host (${path})`);
    } else if (docsShape) {
        reasons.push(`+0 documentation URL shape ignored: ${host} is not named by the query`);
    }

    // The project's own domain AND documentation content is the ordinary shape
    // of official documentation, and is enough on its own to call it canonical.
    if (nameMatch !== null && (docsShape || doc.kind === "reference")) {
        score += config.projectDocs;
        canonical = true;
        reasons.push(`+${config.projectDocs} canonical: project domain serving reference/docs content`);
    }

    // The candidate set's own citation graph. Positive only, and applied before
    // the negatives so that a heavily-cited page is judged on the same scale as
    // one that merely looks official.
    const citations = ctx.peerCitations ?? 0;
    if (citations > 0) {
        const saturation = Math.max(1, config.peerCitationSaturation);
        const share = Math.min(1, citations / saturation);
        const delta = config.peerCited * share;
        score += delta;
        if (citations >= config.peerCitationCanonical) {
            canonical = true;
            reasons.push(
                `+${delta.toFixed(3)} canonical: cited by ${citations} other documents in the candidate set`,
            );
        } else {
            reasons.push(`+${delta.toFixed(3)} cited by ${citations} other document(s) in the candidate set`);
        }
    }

    if (doc.source !== "html") {
        score += config.structuredSource;
        reasons.push(`+${config.structuredSource} structured source (${doc.source})`);
    }

    // --- Negative: did this page actually publish an article? ---------------
    //
    // These three run before the SEO signals because they are the larger
    // measured failure. Of the pages graded `bad` in tranche 1, the single
    // biggest group is not farms but pages that returned HTTP 200 and no
    // article: teaser grids, newsletter gates, nav-only stubs, splash pages.

    const shape = bodyShape(doc);

    if (shape.linkNodeCharRatio >= PAGE_IS_LINK_INDEX_RATIO) {
        score += config.linkIndex;
        reasons.push(
            `${config.linkIndex} link index: ${Math.round(shape.linkNodeCharRatio * 100)}% of the ` +
                `extracted body is anchor text, not prose`,
        );
    }

    if (shape.substantiveNodes === 0 && shape.maxNodeChars < STUB_MAX_NODE_CHARS) {
        score += config.noSubstance;
        reasons.push(
            `${config.noSubstance} no substantive prose: longest node ${shape.maxNodeChars} chars, ` +
                `none over ${SUBSTANTIVE_NODE_CHARS}`,
        );
    }

    if (shape.bodyChars < THIN_BODY_CHARS) {
        score += config.thinBody;
        reasons.push(`${config.thinBody} thin body (${shape.bodyChars} chars extracted)`);
    }

    if (shape.bodyChars < EMPTY_BODY_CHARS) {
        score += config.emptyBody;
        reasons.push(`${config.emptyBody} effectively empty body (${shape.bodyChars} chars extracted)`);
    }

    // --- Negative: is this a page built to sell rather than to inform? ------

    // The host's own brand, repeated through the body, when the query never
    // named that brand: the page is about its publisher, not about the
    // question. This is what separates a vendor's comparison article from a
    // comparison article — both explain the mechanism, only one keeps returning
    // to its own product.
    const brand = brandLabel(host);
    const brandInQuery = brand.length >= 4 && query.raw.toLowerCase().includes(brand);
    if (brand.length >= 4 && !brandInQuery && shape.bodyChars >= SELF_PROMOTION_MIN_BODY) {
        const mentions = countOccurrences(shape.bodyText, brand);
        const per1k = (mentions / shape.bodyChars) * 1000;
        if (per1k >= SELF_PROMOTION_PER_1K) {
            score += config.selfPromotion;
            reasons.push(
                `${config.selfPromotion} self-promotion: names "${brand}" ${mentions} times ` +
                    `(${per1k.toFixed(1)}/1k chars) and the query never asked about it`,
            );
        }
    }

    if (isCodeShapedQuery(query) && !shape.hasCode) {
        score += config.noCodeOnTechnical;
        reasons.push(`${config.noCodeOnTechnical} no code block on a query naming an identifier or error string`);
    }

    // --- Negative: is this a page built to rank rather than to inform? ------

    // Charged once. `pagekind.ts` already reads the title when deciding
    // `listicle`, so charging both would bill the same evidence twice and let a
    // single signal push a page to the floor on its own.
    if (doc.kind === "listicle") {
        score += config.listicleKind;
        reasons.push(`${config.listicleKind} page kind is listicle`);
    } else if (LISTICLE_TITLE.test(doc.title)) {
        score += config.listicleTitle;
        reasons.push(`${config.listicleTitle} listicle/ultimate-guide title`);
    }

    // An official manual's own cross-references are navigation, not a link
    // farm: pkg.go.dev, doc.rust-lang.org and Wikipedia all sit far above the
    // self-referential-density threshold and are exactly the pages this module
    // exists to promote. So the link-shape penalties are skipped once a page has
    // already been identified as the source of truth for the query.
    const links = linkStats(doc, host);
    if (canonical) {
        reasons.push("+0 link-density penalties skipped: page is the query's own source of truth");
    } else if (links.affiliate >= 3) {
        score += config.linkFarm;
        reasons.push(`${config.linkFarm} ${links.affiliate} affiliate-shaped links`);
    } else if (links.perNode > 1.5 && links.total > 0 && links.selfReferential / links.total > 0.6) {
        score += config.linkFarm;
        reasons.push(
            `${config.linkFarm} self-referential link density (${links.perNode.toFixed(1)}/node, ` +
                `${Math.round((links.selfReferential / links.total) * 100)}% internal)`,
        );
    }

    const endorsedQa = hostMatches(host, ENDORSED_QA_HOSTS) !== null;
    if (!endorsedQa) {
        const social = hostMatches(host, SOCIAL_HOSTS);
        if (social !== null) {
            score += config.socialOrForum;
            reasons.push(`${config.socialOrForum} social host (${social})`);
        } else if (FORUM_SUBDOMAIN.test(host)) {
            score += config.socialOrForum;
            reasons.push(`${config.socialOrForum} forum subdomain (${host})`);
        }
    }

    if (SEO_YEAR_SLUG.test(path)) {
        score += config.seoYearSlug;
        reasons.push(`${config.seoYearSlug} year welded onto the end of the slug (${path})`);
    }

    if (doc.lang !== undefined && !doc.lang.toLowerCase().startsWith("en")) {
        score += config.nonEnglish;
        reasons.push(`${config.nonEnglish} non-English content language (${doc.lang})`);
    }

    score = clamp(score, config.floor, 1);

    if (!canonical && score >= config.canonicalThreshold) {
        canonical = true;
        reasons.push(`canonical: score ${score.toFixed(2)} >= threshold ${config.canonicalThreshold}`);
    }

    if (reasons.length === 0) {
        reasons.push(`no authority signal fired; held at base ${config.base}`);
    }

    return { score, canonical, reasons };
}
