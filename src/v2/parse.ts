/**
 * v2 HTML parser.
 *
 * Turns raw HTML into a typed `DocNode` tree. Where v1 flattens everything to a
 * sentence list — losing code-block languages, tables, link anchor text, dates,
 * and Q&A endorsement — this keeps the structure that says which part of a page
 * is the answer.
 *
 * Removal policy: deletion is irreversible, down-ranking is not. Where the call
 * is close we keep the text and let ranking sort it out. Notably v1's
 * boilerplate class list contains `/comment/`, which deletes every answer on a
 * Q&A or discussion page; that pattern is deliberately absent here.
 */

import * as cheerio from "cheerio";
import type { AnyNode, Element as CheerioElement } from "domhandler";
import type { Doc, DocLink, DocNode, NodeKind } from "./types";
import { detectPageKind } from "./pagekind";

/** Options for `parseHtml`. */
export interface ParseOptions {
    /** URL after redirects, when it differs from the requested one. */
    finalUrl?: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Elements that never carry content.
 *
 * TODO(v2, deferred): removing `img` and `svg` here discards their `alt` and
 * `<title>` text, and `figure`/`figcaption` pairs lose their subject. On chart-
 * and diagram-heavy pages that is real content. Fixing it needs a NodeKind for
 * figures, which would ripple into the scorer, so it waits — this is the place
 * to change when it does.
 */
const REMOVE_ELEMENTS = [
    "script", "style", "link", "img", "picture", "source", "iframe", "video",
    "audio", "object", "embed", "param", "applet", "noscript", "svg", "canvas",
    "map", "area", "button", "input", "select", "textarea", "form", "label",
    "fieldset", "legend", "datalist", "output", "progress", "meter", "template",
];

/** Removed even inside protected main content: these are never the answer. */
const ALWAYS_REMOVE_SELECTORS = [
    "nav",
    "[role='navigation']",
    "[role='banner']",
    "[role='contentinfo']",
    "[role='search']",
    "[role='tablist']",
];

/** Structural boilerplate, removed only outside protected main content. */
const BOILERPLATE_ELEMENTS = ["nav", "footer", "header", "aside"];

/** Removing one of these removes the document. No pattern match justifies it. */
const STRUCTURAL_TAGS = new Set(["html", "body", "head", "main", "article"]);

/**
 * Consent banners and signup furniture. Narrow by design — see the note at the
 * call site about the three CMSes that put these words on the content itself.
 */
const CONSENT_PATTERNS = [
    /cookie[-_ ]?(notice|banner|consent|bar|policy|popup|law|message|dialog|wall)/i,
    /(^|[-_ ])(gdpr|ccpa)([-_ ]|$)/i,
    /consent[-_ ]?(banner|manager|dialog|modal|popup|form|notice)/i,
    /newsletter[-_ ]?(signup|sign[-_ ]?up|form|cta|box|banner|widget|subscribe|prompt)/i,
    /subscribe[-_ ]?(form|box|cta|banner|widget|prompt)/i,
];

/**
 * Boilerplate class/id patterns. This is v1's list with `/comment/` REMOVED —
 * on a Q&A or discussion page that pattern deletes the answers, and a deleted
 * answer cannot be recovered by any amount of clever ranking downstream.
 */
const BOILERPLATE_PATTERNS = [
    /nav(igation)?/i,
    /footer/i,
    /header/i,
    /sidebar/i,
    /menu/i,
    /breadcrumb/i,
    /cookie/i,
    /consent/i,
    /banner/i,
    /advert(isement)?/i,
    /ads?[-_]/i,
    /social[-_ ]?(share|links|media|icons)/i,
    /share[-_ ]?(bar|buttons?|widget|links)/i,
    /related[-_ ]?(posts?|articles?|content|links)/i,
    /recommend(ed|ations?)?[-_ ]?(posts?|articles?|content|for[-_ ]?you)/i,
    /popup/i,
    /newsletter/i,
    /subscribe/i,
    /signup/i,
    /login/i,
    /signin/i,
    /widget/i,
    /toolbar/i,
    /promo/i,
    /skip[-_ ]?to[-_ ]?(content|main)/i,
];

/** Interface chrome. Removed inside content too, but only on a tight match. */
const UI_ELEMENT_PATTERNS = [
    /copy[-_]?(button|link|code|markdown)/i,
    /clipboard/i,
    /btn[-_]?(copy|share|action)/i,
    /page[-_]?actions?/i,
    /(^|[-_ ])toc([-_ ]|$)/i,
    /table[-_]?of[-_]?contents/i,
    /on[-_]?this[-_]?page/i,
    /edit[-_]?(page|this[-_]?page|on[-_]?github)/i,
    /blankslate/i, // GitHub's "Uh oh! There was an error while loading." placeholder
];

/**
 * Never-content selectors: copy affordances, line-number gutters, and
 * screen-reader-only labels that duplicate text already present.
 */
const NOISE_SELECTORS = [
    "[data-clipboard-text]",
    "[aria-label*='Copy' i]",
    "a[href^='#']:empty",
    ".linenos",
    ".linenodiv",
    ".blob-num",
    ".lineno",
    ".line-number",
    ".sr-only",
    ".visually-hidden",
    ".visuallyhidden",
    ".screen-reader-text",
];

/** Text that only ever appears on a control. */
const UI_TEXT_PATTERNS = [
    /^copy\s*(as\s*)?(markdown|code|text)?$/i,
    /^open\s+in\s+\w+/i,
    /^(share|copy)\s*(this|link|page)?$/i,
    /^edit\s*(this\s*)?(page|on\s*github)?$/i,
    /^(give\s*)?feedback$/i,
    /^(scroll\s*to\s*)?top$/i,
    /^on\s+this\s+page$/i,
    /^table\s+of\s+contents$/i,
    /^skip\s+to\s+(main\s+)?content$/i,
    /^you\s+must\s+be\s+logged\s+in\s+to\s+vote$/i,
];

/**
 * Admonition containers become `callout` regardless of the tag that carried
 * them. Deliberately excludes `info`, which sites use for bylines and post
 * metadata far more often than for admonitions.
 */
const CALLOUT_PATTERNS = [
    /(^|[-_ ])(note|notice|warning|tip|caution|important|danger|hint|admonition|callout)([-_ ]|$)/i,
];

/** Blocks we descend into rather than flattening. */
const BLOCK_SELECTOR =
    "h1,h2,h3,h4,h5,h6,p,pre,table,ul,ol,dl,li,blockquote,figure,figcaption,article,section,aside,details";

/** Trailing artifacts glued onto code blocks by copy widgets. */
const CODE_CLEANUP_PATTERNS = [
    /\s*(Try|Run|Copy)\s*$/,
    /\s*Open in (Playground|CodeSandbox|StackBlitz)\s*$/i,
    /\s*(Edit|View) on GitHub\s*$/i,
];

const KNOWN_LANGS = new Set([
    "js", "jsx", "javascript", "ts", "tsx", "typescript", "python", "py",
    "rust", "rs", "go", "golang", "java", "c", "cpp", "c++", "csharp", "cs",
    "ruby", "rb", "php", "shell", "sh", "bash", "zsh", "console", "powershell",
    "sql", "html", "xml", "css", "scss", "less", "json", "json5", "yaml", "yml",
    "toml", "ini", "markdown", "md", "mdx", "diff", "patch", "dockerfile",
    "docker", "kotlin", "swift", "scala", "r", "perl", "lua", "dart", "elixir",
    "erlang", "haskell", "clojure", "graphql", "protobuf", "proto", "make",
    "cmake", "nginx", "apache", "vim", "text", "plaintext", "tsql", "plsql",
]);

const MAX_LINKS_PER_NODE = 24;
/** How far above a `<pre>` to look for a wrapper that declares the language. */
const MAX_LANG_ANCESTORS = 6;
const MAX_TABLE_CHARS = 2000;
const MIN_LINKS_FOR_NAV = 3;
const LINK_RATIO_THRESHOLD = 0.8;
const NAV_TEXT_MAX_LENGTH = 200;
const MANY_LINKS_FOR_NAV = 12;
const DENSE_LINK_RATIO = 0.9;
const UI_TEXT_MAX_LENGTH = 60;
/** A pattern-matched element this large, with this little link text, is content. */
const KEEP_ANYWAY_TEXT_CHARS = 1200;
const KEEP_ANYWAY_LINK_RATIO = 0.3;
/** No class name justifies deleting this much of a page. */
const MAX_BOILERPLATE_TEXT_SHARE = 0.3;
/** Below this an `<aside>` is a sidebar widget, not an admonition worth keeping. */
const ASIDE_MIN_PROSE_CHARS = 30;
const ASIDE_LINK_RATIO = 0.5;

// =============================================================================
// Small helpers
// =============================================================================

function isElement(node: AnyNode): node is CheerioElement {
    return node.type === "tag";
}

function tagOf(el: CheerioElement): string {
    return el.tagName.toLowerCase();
}

function collapse(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function identifiers(el: CheerioElement): string {
    const id = el.attribs?.["id"] ?? "";
    const cls = el.attribs?.["class"] ?? "";
    return `${id} ${cls}`;
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
    return patterns.some((p) => p.test(value));
}

function headingLevel(tag: string): number | null {
    if (!/^h[1-6]$/.test(tag)) return null;
    const c = tag[1];
    return c === undefined ? null : Number.parseInt(c, 10);
}

/** Link-text share of an element's text. 1 means the element is nothing but links. */
function linkRatio($: cheerio.CheerioAPI, $el: cheerio.Cheerio<AnyNode>): number {
    const total = collapse($el.text()).length;
    if (total === 0) return 0;
    let linkLen = 0;
    $el.find("a").each((_, a) => {
        linkLen += collapse($(a).text()).length;
    });
    return linkLen / total;
}

// =============================================================================
// Metadata
// =============================================================================

function metaContent($: cheerio.CheerioAPI, names: string[]): string | undefined {
    for (const name of names) {
        const byProp = $(`meta[property="${name}"]`).attr("content");
        if (byProp !== undefined && byProp.trim() !== "") return byProp.trim();
        const byName = $(`meta[name="${name}"]`).attr("content");
        if (byName !== undefined && byName.trim() !== "") return byName.trim();
        const byItem = $(`meta[itemprop="${name}"]`).attr("content");
        if (byItem !== undefined && byItem.trim() !== "") return byItem.trim();
    }
    return undefined;
}

function toIsoDate(raw: string): string | undefined {
    const trimmed = raw.trim();
    if (trimmed === "") return undefined;
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) return undefined;
    const iso = new Date(ms).toISOString();
    // Guard against Date.parse being generous with things like "2" or "12".
    if (!/\d{4}/.test(trimmed)) return undefined;
    return iso;
}

/** Parsed JSON-LD payloads, flattened. Extracted before scripts are stripped. */
function readJsonLd($: cheerio.CheerioAPI): unknown[] {
    const out: unknown[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        const raw = $(el).text();
        if (raw.trim() === "") return;
        try {
            out.push(JSON.parse(raw) as unknown);
        } catch {
            // Malformed JSON-LD is common; ignore it rather than failing the parse.
        }
    });
    return out;
}

/** Depth-first search for a string-valued key anywhere in a JSON-LD payload. */
function findJsonLdString(value: unknown, keys: string[], depth = 0): string | undefined {
    if (depth > 8 || value === null || typeof value !== "object") return undefined;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findJsonLdString(item, keys, depth + 1);
            if (found !== undefined) return found;
        }
        return undefined;
    }
    const record = value as Record<string, unknown>;
    for (const key of keys) {
        const v = record[key];
        if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    for (const v of Object.values(record)) {
        const found = findJsonLdString(v, keys, depth + 1);
        if (found !== undefined) return found;
    }
    return undefined;
}

function extractPublishedAt($: cheerio.CheerioAPI, jsonLd: unknown[]): string | undefined {
    const meta = metaContent($, [
        "article:published_time",
        "og:published_time",
        "datePublished",
        "publish_date",
        "date",
        "DC.date.issued",
    ]);
    if (meta !== undefined) {
        const iso = toIsoDate(meta);
        if (iso !== undefined) return iso;
    }

    const fromLd = findJsonLdString(jsonLd, ["datePublished", "dateCreated", "uploadDate"]);
    if (fromLd !== undefined) {
        const iso = toIsoDate(fromLd);
        if (iso !== undefined) return iso;
    }

    let fromTime: string | undefined;
    $("time[datetime]").each((_, el) => {
        if (fromTime !== undefined) return;
        const dt = $(el).attr("datetime");
        if (dt === undefined) return;
        const iso = toIsoDate(dt);
        if (iso !== undefined) fromTime = iso;
    });
    return fromTime;
}

function extractTitle($: cheerio.CheerioAPI): string {
    const titleTag = collapse($("title").first().text());
    if (titleTag !== "") return titleTag;
    const og = metaContent($, ["og:title", "twitter:title"]);
    if (og !== undefined) return collapse(og);
    const h1 = collapse($("h1").first().text());
    return h1;
}

// =============================================================================
// Boilerplate removal
// =============================================================================

/**
 * A pattern-matched element that is mostly prose and mostly not links is
 * content that happened to sit in a suspiciously named container. Keep it.
 */
function looksLikeRealContent($: cheerio.CheerioAPI, $el: cheerio.Cheerio<AnyNode>): boolean {
    const textLen = collapse($el.text()).length;
    if (textLen < KEEP_ANYWAY_TEXT_CHARS) return false;
    return linkRatio($, $el) < KEEP_ANYWAY_LINK_RATIO;
}

/**
 * True when an `<aside>` is a sidebar rather than an admonition: classed as
 * boilerplate, mostly links, or too short to be saying anything.
 */
function isNavigationAside(
    $: cheerio.CheerioAPI,
    $el: cheerio.Cheerio<AnyNode>,
    el: CheerioElement,
): boolean {
    if (matchesAny(identifiers(el), BOILERPLATE_PATTERNS)) return true;
    const textLen = collapse($el.text()).length;
    if (textLen < ASIDE_MIN_PROSE_CHARS) return true;
    return linkRatio($, $el) > ASIDE_LINK_RATIO;
}

/** Share of the page's text held by an element. */
function textShare($el: cheerio.Cheerio<AnyNode>, bodyTextLen: number): number {
    if (bodyTextLen === 0) return 0;
    return collapse($el.text()).length / bodyTextLen;
}

/** Remove structural boilerplate. Exported so its aggressiveness can be tested directly. */
export function removeBoilerplate($: cheerio.CheerioAPI): void {
    const protectedRoots = $("main, article, [role='main']");
    protectedRoots.attr("data-peeky-protect", "true");
    protectedRoots.find("*").attr("data-peeky-protect", "true");

    const bodyLenBefore = collapse($("body").text()).length;

    // Never content, protected or not.
    for (const selector of ALWAYS_REMOVE_SELECTORS) {
        $(selector).each((_, el) => {
            if (!isElement(el)) return;
            if (STRUCTURAL_TAGS.has(tagOf(el))) return;
            $(el).remove();
        });
    }

    // Consent and signup furniture. These patterns must be narrow: WordPress
    // puts `cookies-not-set` on <body>, Squarespace puts a consent token there,
    // and Substack labels the article itself `newsletter-post` — a loose match
    // on any of the three deletes the entire document.
    $("*").each((_, el) => {
        if (!isElement(el)) return;
        if (STRUCTURAL_TAGS.has(tagOf(el))) return;
        if (!matchesAny(identifiers(el), CONSENT_PATTERNS)) return;
        const $el = $(el);
        if (textShare($el, bodyLenBefore) >= MAX_BOILERPLATE_TEXT_SHARE) return;
        $el.remove();
    });

    for (const selector of BOILERPLATE_ELEMENTS) {
        $(selector).each((_, el) => {
            if (!isElement(el)) return;
            const $el = $(el);
            if ($el.attr("data-peeky-protect") !== undefined) return;
            if ($el.find("[data-peeky-protect]").length > 0) return;
            // <aside> carries two different things: sidebar navigation, and
            // admonitions that are part of the argument. Only the link-dense,
            // navigation-shaped ones go.
            if (tagOf(el) === "aside" && !isNavigationAside($, $el, el)) return;
            $el.remove();
        });
    }

    const bodyTextLen = collapse($("body").text()).length;
    $("*").each((_, el) => {
        if (!isElement(el)) return;
        const $el = $(el);
        if ($el.attr("data-peeky-protect") !== undefined) return;
        if ($el.find("[data-peeky-protect]").length > 0) return;
        if (STRUCTURAL_TAGS.has(tagOf(el))) return;
        if (!matchesAny(identifiers(el), BOILERPLATE_PATTERNS)) return;
        // A class name is not licence to delete a third of the page. w3schools
        // wraps its entire article in `id="belowtopnav"`; v1's /nav/ pattern
        // removes the document. Descendants stay individually eligible.
        if (textShare($el, bodyTextLen) >= MAX_BOILERPLATE_TEXT_SHARE) return;
        if (looksLikeRealContent($, $el)) return;
        $el.remove();
    });

    $("[data-peeky-protect]").removeAttr("data-peeky-protect");
}

/** Remove interface chrome from the chosen container. Exported for the same reason. */
export function removeUIElements($: cheerio.CheerioAPI, container: cheerio.Cheerio<AnyNode>): void {
    const containerLen = collapse(container.text()).length;
    container.find("*").each((_, el) => {
        if (!isElement(el)) return;
        if (STRUCTURAL_TAGS.has(tagOf(el))) return;
        if (!matchesAny(identifiers(el), UI_ELEMENT_PATTERNS)) return;
        const $el = $(el);
        if (textShare($el, containerLen) >= MAX_BOILERPLATE_TEXT_SHARE) return;
        if (looksLikeRealContent($, $el)) return;
        $el.remove();
    });

    container.find("a, span, div, p").each((_, el) => {
        const $el = $(el);
        // Never inside code. A syntax highlighter wraps every token in its own
        // span, so this sweep reaches individual identifiers — and several of
        // these patterns are ordinary code tokens. `/^(scroll\s*to\s*)?top$/i`
        // has an OPTIONAL prefix, so it reduces to /^top$/i and deleted the
        // `top` from every `top: 0` in a Shiki-highlighted CSS block, leaving
        // `: 0;`. `copy`, `share` and `feedback` are the same hazard.
        if ($el.closest("pre, code").length > 0) return;
        const text = $el.text();
        if (text.length < UI_TEXT_MAX_LENGTH && matchesAny(collapse(text), UI_TEXT_PATTERNS)) {
            $el.remove();
        }
    });

    for (const selector of NOISE_SELECTORS) {
        container.find(selector).remove();
    }

    // Link-dense, text-poor blocks are navigation wherever they sit.
    container.find("p, div, span, ul").each((_, el) => {
        const $el = $(el);
        const links = $el.find("a");
        if (links.length < MIN_LINKS_FOR_NAV) return;
        const ratio = linkRatio($, $el);
        // Many links and essentially nothing but link text: a link index,
        // whatever its length. Short and link-dense: an inline nav strip.
        if (links.length >= MANY_LINKS_FOR_NAV && ratio > DENSE_LINK_RATIO) {
            $el.remove();
            return;
        }
        if (collapse($el.text()).length >= NAV_TEXT_MAX_LENGTH) return;
        if (ratio > LINK_RATIO_THRESHOLD) $el.remove();
    });
}

// =============================================================================
// Main content selection
// =============================================================================

/**
 * Pick the container to walk. Prefers `<main>`/`<article>`, but only when it
 * actually holds the page's text — a tiny `<article>` on a page whose content
 * lives elsewhere is the classic way to lose an entire document.
 */
export function selectContainer($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode> {
    const $body = $("body");
    const bodyLen = collapse($body.text()).length;
    if (bodyLen === 0) return $body;

    for (const selector of ["main", "[role='main']", "article"]) {
        const $el = $(selector);
        if ($el.length !== 1) continue;
        const len = collapse($el.text()).length;
        if (len >= bodyLen * 0.4) return $el;
    }

    interface Candidate {
        element: cheerio.Cheerio<AnyNode>;
        selector: string;
        score: number;
        textLen: number;
    }
    const candidates: Candidate[] = [];
    const consider = ($el: cheerio.Cheerio<AnyNode>, selector: string): void => {
        const textLen = collapse($el.text()).length;
        if (textLen === 0) return;
        const score = textLen * (1 - linkRatio($, $el));
        candidates.push({ element: $el, selector, score, textLen });
    };

    $body.children().each((_, el) => {
        if (!isElement(el)) return;
        const tag = tagOf(el);
        if (BOILERPLATE_ELEMENTS.includes(tag)) return;
        let selector = tag;
        const id = el.attribs?.["id"];
        if (id !== undefined && id !== "") selector += `#${id}`;
        consider($(el), selector);
    });

    for (const sel of ["#main", "#content", "#main-content", "#page-content", ".content", ".main-content", ".post-content", ".article-content", ".entry-content"]) {
        const $el = $(sel);
        if ($el.length > 0) consider($el, sel);
    }

    candidates.sort((a, b) => {
        const d = b.score - a.score;
        if (d !== 0) return d;
        return a.selector.localeCompare(b.selector);
    });

    const best = candidates[0];
    if (best === undefined) return $body;
    // A "best" candidate holding a quarter of the page is not a main-content
    // container, it is a fragment. Walk the whole body instead.
    if (best.textLen < bodyLen * 0.25) return $body;
    return best.element;
}

// =============================================================================
// Q&A container detection
// =============================================================================

interface QaInfo {
    role: "question" | "answer";
    votes?: number;
    accepted?: boolean;
    author?: string;
    date?: string;
}

const QA_CONTAINER_PATTERNS = [
    /(^|[-_ ])timeline-comment-group([-_ ]|$)/i,
    /(^|[-_ ])js-comment-container([-_ ]|$)/i,
    /(^|[-_ ])(answer|answercell|post-layout)([-_ ]|$)/i,
    /(^|[-_ ])(comment|discussion-comment)([-_ ]|$)/i,
    /(^|[-_ ])topic-post([-_ ]|$)/i,
];

const QA_BODY_SELECTOR =
    ".comment-body, .js-comment-body, .markdown-body, .s-prose, .post-text, .postcell, [itemprop='text'], .cooked, .message-body, .post-body, .entry-content";

const ACCEPTED_PATTERNS = [
    /(^|[-_ ])(accepted|chosen-answer|is-accepted|answer-accepted|best-answer|solved|solution)([-_ ]|$)/i,
    /timeline-chosen-answer/i,
];

const VOTE_PATTERNS = [/(^|[-_ ])(vote-count|js-vote-count|upvote-count|votecell|js-upvote|score)([-_ ]|$)/i];

function parseLeadingInt(text: string): number | undefined {
    const m = collapse(text).match(/-?\d[\d,]*/);
    if (m === null || m[0] === undefined) return undefined;
    const n = Number.parseInt(m[0].replace(/,/g, ""), 10);
    return Number.isNaN(n) ? undefined : n;
}

function readVotes($: cheerio.CheerioAPI, $el: cheerio.Cheerio<AnyNode>): number | undefined {
    const dataVotes = $el.attr("data-votes") ?? $el.attr("data-score");
    if (dataVotes !== undefined) {
        const n = parseLeadingInt(dataVotes);
        if (n !== undefined) return n;
    }
    let votes: number | undefined;
    $el.find("*").each((_, el) => {
        if (votes !== undefined) return;
        if (!isElement(el)) return;
        if (!matchesAny(identifiers(el), VOTE_PATTERNS)) return;
        const n = parseLeadingInt($(el).text());
        if (n !== undefined) votes = n;
    });
    return votes;
}

function readAuthor($el: cheerio.Cheerio<AnyNode>): string | undefined {
    for (const sel of ["[itemprop='author'] [itemprop='name']", "[itemprop='author']", "a[data-hovercard-type='user']", "[rel='author']", ".author", ".username", ".user-name"]) {
        const text = collapse($el.find(sel).first().text());
        if (text !== "" && text.length <= 60) return text;
    }
    return undefined;
}

function readDate($el: cheerio.Cheerio<AnyNode>): string | undefined {
    const dt = $el.find("time[datetime]").first().attr("datetime");
    if (dt === undefined) return undefined;
    return toIsoDate(dt);
}

/**
 * Map the outermost Q&A post containers to their endorsement signals.
 *
 * Only activates when the page has at least two such containers, so a blog with
 * a single stray `.comment` class does not get re-typed as a thread.
 */
export function detectQaContainers(
    $: cheerio.CheerioAPI,
    container: cheerio.Cheerio<AnyNode>,
): Map<CheerioElement, QaInfo> {
    const found: CheerioElement[] = [];
    const walk = (el: CheerioElement): void => {
        const $el = $(el);
        const isCandidate =
            matchesAny(identifiers(el), QA_CONTAINER_PATTERNS) &&
            $el.find(QA_BODY_SELECTOR).length > 0 &&
            collapse($el.text()).length >= 40;
        if (isCandidate) {
            found.push(el);
            return; // outermost only
        }
        $el.children().each((_, child) => {
            if (isElement(child)) walk(child);
        });
    };
    container.each((_, el) => {
        if (isElement(el)) walk(el);
    });

    const map = new Map<CheerioElement, QaInfo>();
    if (found.length < 2) return map;

    for (let i = 0; i < found.length; i++) {
        const el = found[i];
        if (el === undefined) continue;
        const $el = $(el);
        const accepted =
            matchesAny(identifiers(el), ACCEPTED_PATTERNS) ||
            $el.find("*").toArray().some((c) => isElement(c) && matchesAny(identifiers(c), ACCEPTED_PATTERNS)) ||
            /marked as answer/i.test(collapse($el.text()).slice(0, 4000));
        const votes = readVotes($, $el);
        const author = readAuthor($el);
        const date = readDate($el);
        map.set(el, {
            role: i === 0 ? "question" : "answer",
            ...(votes !== undefined ? { votes } : {}),
            ...(accepted ? { accepted: true } : {}),
            ...(author !== undefined ? { author } : {}),
            ...(date !== undefined ? { date } : {}),
        });
    }
    return map;
}

// =============================================================================
// Code blocks
// =============================================================================

const LANG_PATTERNS = [
    /(?:^|\s)lang(?:uage)?[-:]([a-z0-9+#.]+)/i,
    /(?:^|\s)highlight-source-([a-z0-9+#.]+)/i,
    /(?:^|\s)brush:\s*([a-z0-9+#.]+)/i,
    /(?:^|\s)sourceCode\s+([a-z0-9+#.]+)/i,
];

/** `code-block` is a wrapper class, not a language; only known names count here. */
const NAMED_LANG_PATTERNS = [/(?:^|\s)code-([a-z0-9+#.]+)/i];

function langFromClassString(value: string): string | undefined {
    for (const pattern of LANG_PATTERNS) {
        const m = value.match(pattern);
        const captured = m?.[1];
        if (captured !== undefined && captured !== "") return captured.toLowerCase();
    }
    for (const pattern of NAMED_LANG_PATTERNS) {
        const m = value.match(pattern);
        const captured = m?.[1]?.toLowerCase();
        if (captured !== undefined && KNOWN_LANGS.has(captured)) return captured;
    }
    // hljs / highlight containers often carry a bare language token.
    if (/(?:^|\s)(hljs|highlight|prettyprint|prism)(?:\s|$)/i.test(value)) {
        for (const token of value.split(/\s+/)) {
            const t = token.toLowerCase();
            if (KNOWN_LANGS.has(t)) return t;
        }
    }
    return undefined;
}

/**
 * Language of a code block, from whichever of the usual conventions the page
 * uses. Looks a few levels up as well: MkDocs and Docusaurus declare the
 * language on a wrapper (`div.language-go`) rather than on the `<pre>`.
 */
export function detectCodeLang($: cheerio.CheerioAPI, $el: cheerio.Cheerio<AnyNode>): string | undefined {
    const sources: cheerio.Cheerio<AnyNode>[] = [$el, $el.find("code").first()];
    $el.parents().slice(0, MAX_LANG_ANCESTORS).each((_, parent) => {
        sources.push($(parent));
    });
    for (const $src of sources) {
        if ($src.length === 0) continue;
        for (const attr of ["data-language", "data-lang", "data-code-language", "lang"]) {
            const v = $src.attr(attr);
            if (v !== undefined && v.trim() !== "") return v.trim().toLowerCase();
        }
        const cls = $src.attr("class");
        if (cls !== undefined) {
            const lang = langFromClassString(cls);
            if (lang !== undefined) return lang;
        }
    }
    return undefined;
}

/**
 * Code text with line breaks intact.
 *
 * Sites express code lines three different ways — one element per line, `<br>`
 * separators, or literal newlines — and a code block collapsed to one line is
 * useless to both the reader and to matching.
 */
export function extractCodeText($: cheerio.CheerioAPI, $el: cheerio.Cheerio<AnyNode>): string {
    // `[data-line]` is Shiki's per-line wrapper, which carries no class at all.
    // Shiki is what Astro/Starlight, VitePress and a lot of modern doc sites
    // render code with, so missing it sends those pages down the flattening
    // path below, where cheerio's .text() concatenates every line into one -
    // "…dark mode togglepick 9f8e7d6 fix typo…". Multi-line code arrives
    // unusable.
    const $lines = $el.find(".line, .code-line, .cm-line, .loc, [data-line]");
    if ($lines.length >= 2) {
        const lines: string[] = [];
        $lines.each((_, el) => {
            lines.push($(el).text().replace(/\s+$/, ""));
        });
        const joined = lines.join("\n").replace(/^\s*\n+/, "").replace(/\s+$/, "");
        if (joined.trim() !== "") return cleanCode(joined);
    }

    const html = $el.html() ?? "";
    if (/<br\b/i.test(html)) {
        const withNewlines = html.replace(/<br\s*\/?>/gi, "\n");
        const $tmp = cheerio.load(`<div id="peeky-code">${withNewlines}</div>`);
        return cleanCode($tmp("#peeky-code").text().replace(/\s+$/, ""));
    }

    return cleanCode(($el.text() ?? "").replace(/\s+$/, "").replace(/^\n+/, ""));
}

/** A `<pre>` holding nothing but ascending integers is a line-number gutter. */
function isLineNumberGutter(text: string): boolean {
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    if (lines.length < 2) return false;
    return lines.every((l) => /^\s*\d+\s*$/.test(l));
}

function cleanCode(text: string): string {
    let out = text;
    for (const pattern of CODE_CLEANUP_PATTERNS) {
        out = out.replace(pattern, "");
    }
    return out.replace(/\s+$/, "");
}

const CODE_CONTAINER_PATTERNS = [
    /(^|[-_ ])(code-?block|codehilite|highlight|sourceCode|snippet|code-?sample|code)([-_ ]|$)/i,
];

/**
 * A code block expressed without `<pre>`: line divs in a `.code-block` wrapper,
 * or `<br>`-separated lines in a `.w3-code` div. Both are common enough that
 * missing them loses the only code on the page.
 */
function isCodeContainer($: cheerio.CheerioAPI, el: CheerioElement): boolean {
    if (!matchesAny(identifiers(el), CODE_CONTAINER_PATTERNS)) return false;
    const $el = $(el);
    if ($el.find("pre, table, ul, ol, h1, h2, h3, h4, h5, h6, p").length > 0) return false;
    if ($el.find(".line, .code-line, .cm-line").length >= 1) return true;
    if ($el.children("code").length > 0) return true;
    return /<br\b/i.test($el.html() ?? "");
}

// =============================================================================
// Tables
// =============================================================================

/**
 * MkDocs, Pygments and GitHub render code blocks as a two-column table with a
 * line-number gutter. Rendering that as a table produces an unreadable row and
 * loses the code; it should be descended into instead.
 */
export function isCodeTable($table: cheerio.Cheerio<AnyNode>): boolean {
    if ($table.find("pre").length === 0) return false;
    if ($table.find(".linenos, .linenodiv, .blob-num, .line-number, .lineno").length > 0) return true;
    const el = $table.get(0);
    if (el !== undefined && isElement(el) && /highlight|syntax|code/i.test(identifiers(el))) return true;
    return false;
}

/**
 * Render a table as readable text with its header row retained. API reference
 * tables are pure signal and v1 cannot see them at all.
 *
 * Returns null when the table is not carrying data — layout scaffolding, or a
 * code block wearing a table for its line numbers.
 */
export function renderTable($: cheerio.CheerioAPI, $table: cheerio.Cheerio<AnyNode>): string | null {
    if ($table.find("table").length > 0) return null; // nested: outer is layout
    if (isCodeTable($table)) return null;

    const rows: string[][] = [];
    let sawTh = false;
    let maxCols = 0;
    $table.find("tr").each((_, tr) => {
        const cells: string[] = [];
        $(tr).children("th, td").each((_, cell) => {
            if (isElement(cell) && tagOf(cell) === "th") sawTh = true;
            cells.push(collapse($(cell).text()));
        });
        if (cells.length === 0) return;
        if (cells.every((c) => c === "")) return;
        maxCols = Math.max(maxCols, cells.length);
        rows.push(cells);
    });

    if (rows.length === 0) return null;
    // Layout tables: no header cells and not actually tabular.
    if (!sawTh && (rows.length < 2 || maxCols < 2)) return null;

    const caption = collapse($table.find("caption").first().text());

    const lines: string[] = [];
    if (caption !== "") lines.push(caption);
    for (const row of rows) {
        lines.push(row.join(" | "));
    }

    // Cap by whole rows, keeping at least the header and one row: slicing on a
    // raw character count can drop every row of a wide table and leave a stub.
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
        if (kept.length >= 2 && used + line.length > MAX_TABLE_CHARS) break;
        kept.push(line);
        used += line.length + 1;
    }
    let text = kept.join("\n");
    if (kept.length < lines.length) text += "\n…";
    if (text.length > MAX_TABLE_CHARS * 2) text = `${text.slice(0, MAX_TABLE_CHARS * 2)}…`;
    return text;
}

// =============================================================================
// Links
// =============================================================================

function resolveHref(href: string, base: string | undefined): string | null {
    const trimmed = href.trim();
    if (trimmed === "") return null;
    if (/^(javascript|mailto|tel|data):/i.test(trimmed)) return null;
    if (base === undefined) return trimmed;
    try {
        return new URL(trimmed, base).toString();
    } catch {
        return trimmed;
    }
}

function collectLinks(
    $: cheerio.CheerioAPI,
    $el: cheerio.Cheerio<AnyNode>,
    base: string | undefined,
): DocLink[] | undefined {
    const links: DocLink[] = [];
    const seen = new Set<string>();
    $el.find("a[href]").each((_, a) => {
        if (links.length >= MAX_LINKS_PER_NODE) return;
        const href = $(a).attr("href");
        if (href === undefined) return;
        const resolved = resolveHref(href, base);
        if (resolved === null) return;
        const text = collapse($(a).text());
        if (text === "") return;
        const key = `${text} ${resolved}`;
        if (seen.has(key)) return;
        seen.add(key);
        links.push({ text, href: resolved });
    });
    return links.length > 0 ? links : undefined;
}

// =============================================================================
// Walker
// =============================================================================

interface WalkContext {
    $: cheerio.CheerioAPI;
    base: string | undefined;
    nodes: DocNode[];
    path: string[];
    order: { value: number };
    qaMap: Map<CheerioElement, QaInfo>;
    calloutDepth: number;
    qa: QaInfo | null;
}

interface EmitExtras {
    level?: number;
    lang?: string;
    links?: DocLink[];
}

function emit(ctx: WalkContext, kind: NodeKind, text: string, extras: EmitExtras = {}): void {
    if (text === "") return;
    if (text.length < UI_TEXT_MAX_LENGTH && matchesAny(collapse(text), UI_TEXT_PATTERNS)) return;

    const qa = ctx.qa;
    const node: DocNode = {
        kind,
        text,
        order: ctx.order.value++,
        headingPath: [...ctx.path],
        ...(extras.level !== undefined ? { level: extras.level } : {}),
        ...(extras.lang !== undefined ? { lang: extras.lang } : {}),
        ...(extras.links !== undefined ? { links: extras.links } : {}),
        ...(qa?.votes !== undefined ? { votes: qa.votes } : {}),
        ...(qa?.accepted !== undefined ? { accepted: qa.accepted } : {}),
        ...(qa?.author !== undefined ? { author: qa.author } : {}),
        ...(qa?.date !== undefined ? { date: qa.date } : {}),
    };
    ctx.nodes.push(node);
}

/** Prose takes on the identity of whatever context it sits in. */
function proseKind(ctx: WalkContext): NodeKind {
    if (ctx.calloutDepth > 0) return "callout";
    if (ctx.qa !== null) return ctx.qa.role;
    return "prose";
}

const PARAM_LIST_PATTERN = /^[`'"]?[A-Za-z_$][\w.$\-[\]]{0,48}[`'"]?\s*(?:\([^)]{0,60}\))?\s*(?::|—|–|\s-\s|\s{2,})\s*\S/;
const PARAM_LEAD_TAGS = new Set(["code", "strong", "b", "dfn", "var", "tt", "em", "kbd", "samp"]);

function isParameterListItem($: cheerio.CheerioAPI, el: CheerioElement, text: string): boolean {
    if (!PARAM_LIST_PATTERN.test(text)) return false;
    const first = $(el).children().first();
    if (first.length === 0) return false;
    const firstEl = first.get(0);
    if (firstEl === undefined || !isElement(firstEl)) return false;
    return PARAM_LEAD_TAGS.has(tagOf(firstEl));
}

/** Tags that flow inside a line of text rather than starting a new block. */
const INLINE_TAGS = new Set([
    "a", "span", "em", "strong", "b", "i", "u", "s", "del", "ins", "mark",
    "small", "sub", "sup", "abbr", "cite", "q", "time", "code", "kbd", "var",
    "samp", "big", "font", "tt", "dfn", "bdi", "bdo", "ruby", "rt", "rp",
    "wbr", "br", "nobr",
]);

/**
 * Walk an element's children, grouping consecutive inline content into a single
 * prose node.
 *
 * Emitting one node per `<a>` would shred a paragraph of linked text into
 * dozens of fragments and hand ranking a pile of two-word passages.
 */
function walkChildren(ctx: WalkContext, $el: cheerio.Cheerio<AnyNode>): void {
    const { $ } = ctx;
    let buffer = "";
    let bufferLinks: DocLink[] = [];

    const flush = (): void => {
        const text = collapse(buffer);
        const links = bufferLinks;
        buffer = "";
        bufferLinks = [];
        if (text === "") return;
        emit(ctx, proseKind(ctx), text, links.length > 0 ? { links } : {});
    };

    for (const child of $el.contents().toArray()) {
        if (child.type === "text") {
            buffer += child.data ?? "";
            continue;
        }
        if (!isElement(child)) continue;

        const tag = tagOf(child);
        if (INLINE_TAGS.has(tag)) {
            if (tag === "br" || tag === "wbr") {
                buffer += " ";
                continue;
            }
            const $child = $(child);
            buffer += $child.text();
            const links = collectLinks($, $child, ctx.base);
            if (links !== undefined) {
                for (const link of links) {
                    if (bufferLinks.length >= MAX_LINKS_PER_NODE) break;
                    bufferLinks.push(link);
                }
            }
            if (tag === "a") {
                const href = $child.attr("href");
                const text = collapse($child.text());
                if (href !== undefined && text !== "" && bufferLinks.length < MAX_LINKS_PER_NODE) {
                    const resolved = resolveHref(href, ctx.base);
                    if (resolved !== null) bufferLinks.push({ text, href: resolved });
                }
            }
            continue;
        }

        flush();
        walkElement(ctx, child);
    }
    flush();
}

function walkElement(ctx: WalkContext, el: CheerioElement): void {
    const { $ } = ctx;
    const tag = tagOf(el);
    const $el = $(el);

    // --- Q&A post container ------------------------------------------------
    if (ctx.qa === null) {
        const info = ctx.qaMap.get(el);
        if (info !== undefined) {
            ctx.qa = info;
            walkChildren(ctx, $el);
            ctx.qa = null;
            return;
        }
    }

    // --- headings ----------------------------------------------------------
    const level = headingLevel(tag);
    if (level !== null) {
        // Drop the permalink glyph docs generators append ("Graceful Shutdown#").
        const $clone = $el.clone();
        $clone.find(PERMALINK_SELECTOR).remove();
        const text = collapse($clone.text());
        if (text === "") return;
        // Truncate to the parent level BEFORE capturing the path, so a heading
        // carries only its ancestors and never its siblings.
        if (level - 1 < ctx.path.length) ctx.path.length = level - 1;
        const links = collectLinks($, $el, ctx.base);
        emit(ctx, "heading", text, { level, ...(links !== undefined ? { links } : {}) });
        ctx.path.push(text);
        return;
    }

    // --- code --------------------------------------------------------------
    if (tag === "pre" || isCodeContainer($, el)) {
        const text = extractCodeText($, $el);
        if (text.trim() === "") return;
        if (isLineNumberGutter(text)) return;
        const lang = detectCodeLang($, $el);
        emit(ctx, "code", text, lang !== undefined ? { lang } : {});
        return;
    }

    // --- tables ------------------------------------------------------------
    if (tag === "table") {
        const rendered = renderTable($, $el);
        if (rendered === null) {
            walkChildren(ctx, $el);
            return;
        }
        const links = collectLinks($, $el, ctx.base);
        emit(ctx, "table", rendered, links !== undefined ? { links } : {});
        return;
    }

    // --- definition lists --------------------------------------------------
    if (tag === "dl") {
        walkDefinitionList(ctx, $el);
        return;
    }

    // --- callouts ----------------------------------------------------------
    const isAdmonition =
        tag === "aside" ||
        el.attribs?.["role"] === "note" ||
        el.attribs?.["role"] === "alert" ||
        matchesAny(identifiers(el), CALLOUT_PATTERNS);
    if (isAdmonition && $el.find(BLOCK_SELECTOR).length > 0) {
        ctx.calloutDepth++;
        walkChildren(ctx, $el);
        ctx.calloutDepth--;
        return;
    }
    if (isAdmonition) {
        const text = collapse($el.text());
        const links = collectLinks($, $el, ctx.base);
        emit(ctx, "callout", text, links !== undefined ? { links } : {});
        return;
    }

    // --- quotes ------------------------------------------------------------
    if (tag === "blockquote") {
        if ($el.find("pre, table").length > 0) {
            walkChildren(ctx, $el);
            return;
        }
        const text = collapse($el.text());
        const links = collectLinks($, $el, ctx.base);
        emit(ctx, "quote", text, links !== undefined ? { links } : {});
        return;
    }

    // --- list items --------------------------------------------------------
    if (tag === "li") {
        walkListItem(ctx, el, $el);
        return;
    }

    // --- paragraphs: always exactly one node --------------------------------
    if (PARAGRAPH_TAGS.has(tag)) {
        const text = collapse($el.text());
        if (text === "") return;
        const links = collectLinks($, $el, ctx.base);
        emit(ctx, proseKind(ctx), text, links !== undefined ? { links } : {});
        return;
    }

    // --- generic containers -------------------------------------------------
    walkChildren(ctx, $el);
}

const PARAGRAPH_TAGS = new Set(["p", "figcaption", "caption", "dd", "dt", "address", "summary"]);

/** Permalink anchors documentation generators append to every heading. */
const PERMALINK_SELECTOR =
    "a.headerlink, a.anchor, a.hash-link, a.header-anchor, a.permalink, a.anchorjs-link, a[aria-hidden='true'][href^='#']";

const LIST_BLOCK_CHILDREN = "pre, table, ul, ol, dl, blockquote";
/**
 * How many wrapper elements a list item's block content may sit under before
 * we give up. Expressive Code (Docusaurus/Starlight) wraps a `<pre>` as
 * `<li><div class="expressive-code"><figure><pre>` — three wrappers deep —
 * and there is no reason a fourth CMS won't add one more. This bounds the
 * search rather than hard-coding a depth.
 */
const MAX_LIST_WRAPPER_DEPTH = 6;

/**
 * Find the outermost `LIST_BLOCK_CHILDREN` elements at or under `el`,
 * stopping as soon as one is found on a given path. A match's own descendants
 * (e.g. a nested `<li>` inside a matched `<ul>`) are `walkElement`'s concern,
 * not this search's — descending past a match would visit them twice.
 */
function findListBlockChildren($: cheerio.CheerioAPI, el: CheerioElement, depth: number): CheerioElement[] {
    const $el = $(el);
    if ($el.is(LIST_BLOCK_CHILDREN)) return [el];
    if (depth >= MAX_LIST_WRAPPER_DEPTH) return [];
    const found: CheerioElement[] = [];
    $el.children().each((_, child) => {
        if (!isElement(child)) return;
        found.push(...findListBlockChildren($, child, depth + 1));
    });
    return found;
}

function walkListItem(ctx: WalkContext, el: CheerioElement, $el: cheerio.Cheerio<AnyNode>): void {
    const { $ } = ctx;
    const $clone = $el.clone();
    $clone.find(LIST_BLOCK_CHILDREN).remove();
    const ownText = collapse($clone.text());

    if (ownText !== "") {
        const links = collectLinks($, $clone, ctx.base);
        const kind: NodeKind = isParameterListItem($, el, ownText) ? "definition" : "list-item";
        emit(ctx, kind, ownText, links !== undefined ? { links } : {});
    }

    // Block content (code, tables, nested lists, quotes) may sit directly under
    // the <li> or under any number of wrapper elements — a plain <div>, or the
    // <div><figure> pairing Expressive Code / Docusaurus / Starlight generate.
    // Walk each top-level child in document order and descend into it only
    // until the first block element is found, so wrappers never get re-walked
    // (and their text never re-emitted — `ownText` already accounted for it,
    // since the clone above strips LIST_BLOCK_CHILDREN at any depth).
    $el.children().each((_, child) => {
        if (!isElement(child)) return;
        for (const block of findListBlockChildren($, child, 0)) {
            walkElement(ctx, block);
        }
    });
}

function walkDefinitionList(ctx: WalkContext, $dl: cheerio.Cheerio<AnyNode>): void {
    const { $ } = ctx;
    const children = $dl.children().toArray().filter(isElement);
    let terms: string[] = [];
    let descriptions: string[] = [];
    const blocks: CheerioElement[] = [];

    const flush = (): void => {
        if (terms.length === 0 && descriptions.length === 0) return;
        const term = terms.join(", ");
        const desc = descriptions.join(" ");
        const text = term !== "" && desc !== "" ? `${term}: ${desc}` : `${term}${desc}`;
        if (text !== "") emit(ctx, "definition", text);
        for (const block of blocks) walkElement(ctx, block);
        terms = [];
        descriptions = [];
        blocks.length = 0;
    };

    for (const child of children) {
        const tag = tagOf(child);
        if (tag === "dt") {
            if (descriptions.length > 0) flush();
            const t = collapse($(child).text());
            if (t !== "") terms.push(t);
        } else if (tag === "dd") {
            const $clone = $(child).clone();
            $clone.find("pre, table").remove();
            const d = collapse($clone.text());
            if (d !== "") descriptions.push(d);
            $(child).find("pre, table").each((_, b) => {
                if (isElement(b)) blocks.push(b);
            });
        }
    }
    flush();
}

// =============================================================================
// Entry point
// =============================================================================

/**
 * Parse HTML into a typed document.
 *
 * `kind` is detected from the document and URL rather than supplied, and every
 * structural fact the page states — code language, table headers, link targets,
 * dates, Q&A endorsement — stays attached to the text it describes.
 */
export function parseHtml(html: string, url: string, options: ParseOptions = {}): Doc {
    const $ = cheerio.load(html);

    const jsonLd = readJsonLd($);
    const title = extractTitle($);
    const rawLang = $("html").attr("lang");
    const lang = rawLang !== undefined && rawLang.trim() !== "" ? rawLang.trim().toLowerCase() : undefined;
    const publishedAt = extractPublishedAt($, jsonLd);
    const baseHref = $("base[href]").first().attr("href");
    let base: string | undefined = url;
    if (baseHref !== undefined && baseHref.trim() !== "") {
        try {
            base = new URL(baseHref, url).toString();
        } catch {
            base = url;
        }
    }

    for (const selector of REMOVE_ELEMENTS) {
        $(selector).remove();
    }
    removeBoilerplate($);

    const container = selectContainer($);
    removeUIElements($, container);

    const qaMap = detectQaContainers($, container);

    const ctx: WalkContext = {
        $,
        base,
        nodes: [],
        path: [],
        order: { value: 0 },
        qaMap,
        calloutDepth: 0,
        qa: null,
    };
    container.each((_, el) => {
        if (isElement(el)) walkElement(ctx, el);
    });

    const doc: Doc = {
        url,
        ...(options.finalUrl !== undefined && options.finalUrl !== url ? { finalUrl: options.finalUrl } : {}),
        title,
        kind: "unknown",
        source: "html",
        nodes: ctx.nodes,
        ...(publishedAt !== undefined ? { publishedAt } : {}),
        ...(lang !== undefined ? { lang } : {}),
    };

    const detected = detectPageKind(doc, html, options.finalUrl ?? url);
    doc.kind = detected.kind;
    doc.kindEvidence = detected.evidence;
    return doc;
}
