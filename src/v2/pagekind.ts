/**
 * Page-kind detection.
 *
 * The page already announces what it is — through its URL shape, its heading
 * structure, and the kinds of nodes it contains. Asking the calling model to
 * declare "this is technical, search lower in the page" pushes a guess onto
 * someone with strictly less information than we have here.
 *
 * Every signal contributes to a score AND to `evidence`, because a misranked
 * page has to be diagnosable rather than a mystery.
 */

import type { Doc, DocNode, PageKind } from "./types";

/** Result of detection: the kind and the reasoning that produced it. */
export interface PageKindResult {
    kind: PageKind;
    evidence: string;
}

interface Signal {
    kind: PageKind;
    weight: number;
    reason: string;
}

/** Deterministic tie-break order: more specific kinds win an exact tie. */
const KIND_PRIORITY: PageKind[] = [
    "spec",
    "qa",
    "issue",
    "changelog",
    "reference",
    "listicle",
    "guide",
    "blog",
    "unknown",
];

// =============================================================================
// URL signals
// =============================================================================

interface UrlRule {
    pattern: RegExp;
    kind: PageKind;
    weight: number;
    label: string;
}

const HOST_RULES: UrlRule[] = [
    { pattern: /(^|\.)stackoverflow\.com$/i, kind: "qa", weight: 4, label: "host=stackoverflow" },
    { pattern: /(^|\.)(serverfault|superuser|askubuntu)\.com$/i, kind: "qa", weight: 4, label: "host=stackexchange-family" },
    { pattern: /(^|\.)stackexchange\.com$/i, kind: "qa", weight: 4, label: "host=stackexchange" },
    { pattern: /(^|\.)quora\.com$/i, kind: "qa", weight: 3, label: "host=quora" },
    { pattern: /(^|\.)reddit\.com$/i, kind: "qa", weight: 3, label: "host=reddit" },
    { pattern: /(^|\.)news\.ycombinator\.com$/i, kind: "qa", weight: 3, label: "host=hacker-news" },
    { pattern: /(^|\.)lobste\.rs$/i, kind: "qa", weight: 3, label: "host=lobsters" },
    { pattern: /(^|\.)datatracker\.ietf\.org$/i, kind: "spec", weight: 5, label: "host=datatracker.ietf.org" },
    { pattern: /(^|\.)rfc-editor\.org$/i, kind: "spec", weight: 5, label: "host=rfc-editor.org" },
    { pattern: /(^|\.)w3\.org$/i, kind: "spec", weight: 3, label: "host=w3.org" },
    { pattern: /(^|\.)whatwg\.org$/i, kind: "spec", weight: 3, label: "host=whatwg.org" },
];

const PATH_RULES: UrlRule[] = [
    { pattern: /\/questions?\//i, kind: "qa", weight: 4, label: "path=/questions/" },
    { pattern: /\/discussions?\//i, kind: "qa", weight: 3, label: "path=/discussions/" },
    { pattern: /\/(forum|forums|viewtopic|threads?)\//i, kind: "qa", weight: 3, label: "path=forum" },
    { pattern: /\/answers?\//i, kind: "qa", weight: 2, label: "path=/answers/" },
    { pattern: /\/issues?\/\d+/i, kind: "issue", weight: 5, label: "path=/issues/<n>" },
    { pattern: /\/(issues|pull)\//i, kind: "issue", weight: 3, label: "path=/issues/" },
    { pattern: /\/(bug|bugs|ticket)\//i, kind: "issue", weight: 2, label: "path=bug tracker" },
    { pattern: /\/(changelog|release-notes|releases|whats-new|what-s-new)(\/|\.|$)/i, kind: "changelog", weight: 4, label: "path=changelog" },
    { pattern: /\/(migration|upgrading|upgrade-guide)(\/|\.|$)/i, kind: "changelog", weight: 2, label: "path=migration" },
    { pattern: /\/(reference|api-reference|apidocs|api-docs|javadoc|godoc)(\/|\.|$)/i, kind: "reference", weight: 4, label: "path=reference" },
    { pattern: /\/(api)(\/|\.|$)/i, kind: "reference", weight: 3, label: "path=/api/" },
    { pattern: /\/[a-z]*ref\//i, kind: "reference", weight: 2, label: "path=*ref/" },
    { pattern: /\/(docs?|documentation|manual|handbook)(\/|\.|$)/i, kind: "guide", weight: 2, label: "path=/docs/" },
    { pattern: /\/(guide|guides|tutorial|tutorials|how-to|howto|learn|getting-started)(\/|\.|$)/i, kind: "guide", weight: 3, label: "path=guide" },
    { pattern: /\/(blog|posts?|articles?|news)(\/|\.|$)/i, kind: "blog", weight: 3, label: "path=blog" },
    { pattern: /\/\d{4}\/\d{2}\//, kind: "blog", weight: 3, label: "path=/YYYY/MM/" },
    { pattern: /\/(rfc|spec|specification|standard|tr)(\/|\.|$)/i, kind: "spec", weight: 3, label: "path=spec" },
];

/** `10-best-x`, `5-ways-to-y`, `top-10-z` — the SEO listicle URL shape. */
const LISTICLE_URL = /(\b|[-_/])(\d{1,2}[-_](best|ways?|tips|tools|reasons|things|steps|examples|alternatives|practices|hacks|mistakes|benefits)|top[-_]\d{1,2}|best[-_]\d{1,2})/i;

const LISTICLE_TITLE =
    /(^|\W)(\d{1,2}|ten|top)\s+(best|worst|ways?|tips|tools|reasons|things|steps|examples|alternatives|practices|hacks|mistakes|benefits|must[- ]have)\b|^\s*top\s+\d{1,2}\b|\b\d{1,2}\s+(?:best|ways to|things|tips for|reasons)\b/i;

// =============================================================================
// Document signals
// =============================================================================

const REFERENCE_TABLE_HEADERS = new Set([
    "parameter", "parameters", "param", "params", "argument", "arguments",
    "option", "options", "type", "types", "default", "default value",
    "returns", "return", "return value", "property", "properties", "field",
    "fields", "flag", "flags", "method", "methods", "signature", "value",
    "values", "attribute", "attributes", "description",
]);

const VERSION_HEADING = /^v?\d+\.\d+(\.\d+)?([-+][\w.]+)?\b/;
const NUMBERED_HEADING = /^\d{1,2}\s*[.):-]\s+\S/;

function countHeadings(nodes: DocNode[], predicate: (text: string, level: number) => boolean): number {
    let count = 0;
    for (const node of nodes) {
        if (node.kind !== "heading") continue;
        if (predicate(node.text, node.level ?? 1)) count++;
    }
    return count;
}

function normalizeCell(cell: string): string {
    return cell.trim().toLowerCase().replace(/[:*]+$/, "");
}

/**
 * A table whose header row — or, for the vertical layout API docs favour, whose
 * first column — names parameters, types, defaults or return values.
 */
function firstTableHeaderHit(nodes: DocNode[]): string | null {
    for (const node of nodes) {
        if (node.kind !== "table") continue;
        const lines = node.text.split("\n");

        const firstLine = lines[0];
        if (firstLine !== undefined) {
            const hits = firstLine.split("|").map(normalizeCell).filter((c) => REFERENCE_TABLE_HEADERS.has(c));
            if (hits.length >= 2) return hits.slice(0, 3).join("/");
        }

        const firstColumn = lines
            .map((line) => normalizeCell(line.split("|")[0] ?? ""))
            .filter((c) => REFERENCE_TABLE_HEADERS.has(c));
        if (firstColumn.length >= 2) return `${firstColumn.slice(0, 3).join("/")} (first column)`;
    }
    return null;
}

// =============================================================================
// Detection
// =============================================================================

/**
 * Detect the kind of page from the document and its URL.
 *
 * Never accepts a caller-supplied hint: the document is the evidence.
 */
export function detectPageKind(doc: Doc, html: string, url: string): PageKindResult {
    const signals: Signal[] = [];
    const nodes = doc.nodes;

    // --- URL ---------------------------------------------------------------
    let host = "";
    let pathname = url;
    try {
        const parsed = new URL(url);
        host = parsed.hostname;
        pathname = `${parsed.pathname}${parsed.search}`;
    } catch {
        // Non-absolute URL: fall back to matching the whole string as a path.
    }

    for (const rule of HOST_RULES) {
        if (rule.pattern.test(host)) {
            signals.push({ kind: rule.kind, weight: rule.weight, reason: rule.label });
        }
    }
    for (const rule of PATH_RULES) {
        if (rule.pattern.test(pathname)) {
            signals.push({ kind: rule.kind, weight: rule.weight, reason: rule.label });
        }
    }
    if (LISTICLE_URL.test(pathname)) {
        signals.push({ kind: "listicle", weight: 4, reason: "url=listicle slug" });
    }

    // --- Q&A shape ---------------------------------------------------------
    const answerNodes = nodes.filter((n) => n.kind === "answer").length;
    const questionNodes = nodes.filter((n) => n.kind === "question").length;
    if (answerNodes >= 2) {
        signals.push({
            kind: "qa",
            weight: answerNodes >= 5 ? 4 : 3,
            reason: `structure=${answerNodes} answer nodes, ${questionNodes} question nodes`,
        });
    }
    if (nodes.some((n) => n.accepted === true)) {
        signals.push({ kind: "qa", weight: 2, reason: "structure=accepted answer marked" });
    }
    if (/"@type"\s*:\s*"QAPage"/i.test(html)) {
        signals.push({ kind: "qa", weight: 3, reason: "jsonld=QAPage" });
    }
    if (/"@type"\s*:\s*"TechArticle"/i.test(html)) {
        signals.push({ kind: "guide", weight: 1, reason: "jsonld=TechArticle" });
    }

    // --- changelog: a run of version-numbered headings ----------------------
    const versionHeadings = countHeadings(nodes, (text) => VERSION_HEADING.test(text));
    if (versionHeadings >= 3) {
        signals.push({
            kind: "changelog",
            weight: versionHeadings >= 8 ? 5 : 3,
            reason: `structure=${versionHeadings} version-numbered headings`,
        });
    }

    // --- reference: signature + parameter tables, or dense definitions ------
    const tableHit = firstTableHeaderHit(nodes);
    if (tableHit !== null) {
        signals.push({ kind: "reference", weight: 3, reason: `structure=parameter table (${tableHit})` });
    }
    const definitionNodes = nodes.filter((n) => n.kind === "definition").length;
    if (definitionNodes >= 5) {
        signals.push({ kind: "reference", weight: 2, reason: `structure=${definitionNodes} definition nodes` });
    }
    const codeNodes = nodes.filter((n) => n.kind === "code").length;
    const headingNodes = nodes.filter((n) => n.kind === "heading").length;
    if (codeNodes >= 6 && headingNodes >= 6 && codeNodes >= headingNodes * 0.6) {
        signals.push({
            kind: "reference",
            weight: 1,
            reason: `structure=${codeNodes} code blocks against ${headingNodes} headings`,
        });
    }

    // --- listicle: numbered h2 runs, or a listicle title --------------------
    const numberedH2 = countHeadings(nodes, (text, level) => level === 2 && NUMBERED_HEADING.test(text));
    if (numberedH2 >= 4 && versionHeadings < 3) {
        signals.push({ kind: "listicle", weight: 3, reason: `structure=${numberedH2} numbered <h2> headings` });
    }
    if (LISTICLE_TITLE.test(doc.title)) {
        signals.push({ kind: "listicle", weight: 3, reason: "title=listicle phrasing" });
    }

    // --- spec ---------------------------------------------------------------
    const specPhrases = /status of this memo|request for comments|normative references|the key words "MUST"|conformance requirements/i;
    if (specPhrases.test(doc.title) || nodes.slice(0, 60).some((n) => specPhrases.test(n.text))) {
        signals.push({ kind: "spec", weight: 4, reason: "text=RFC/standard boilerplate phrasing" });
    }

    // --- issue --------------------------------------------------------------
    // Headings only: a blog post that merely mentions "steps to reproduce" in
    // its prose is not a bug report.
    const bugReport = /^(bug report|steps to reproduce|to reproduce|reproduction|expected behaviou?r|actual behaviou?r|current behaviou?r)\b/i;
    if (countHeadings(nodes, (text) => bugReport.test(text)) >= 2) {
        signals.push({ kind: "issue", weight: 3, reason: "structure=bug-report headings" });
    }

    // --- blog ---------------------------------------------------------------
    if (doc.publishedAt !== undefined && /"@type"\s*:\s*"(BlogPosting|NewsArticle)"/i.test(html)) {
        signals.push({ kind: "blog", weight: 3, reason: "jsonld=BlogPosting" });
    }

    // --- tally --------------------------------------------------------------
    if (signals.length === 0) {
        return { kind: "unknown", evidence: "no signals matched" };
    }

    const totals = new Map<PageKind, number>();
    for (const signal of signals) {
        totals.set(signal.kind, (totals.get(signal.kind) ?? 0) + signal.weight);
    }

    let best: PageKind = "unknown";
    let bestScore = -1;
    for (const kind of KIND_PRIORITY) {
        const score = totals.get(kind) ?? 0;
        if (score > bestScore) {
            bestScore = score;
            best = kind;
        }
    }
    if (bestScore <= 0) {
        return { kind: "unknown", evidence: "no signals matched" };
    }

    const winning = signals
        .filter((s) => s.kind === best)
        .sort((a, b) => {
            const d = b.weight - a.weight;
            if (d !== 0) return d;
            return a.reason.localeCompare(b.reason);
        })
        .map((s) => `${s.reason} (+${s.weight})`);

    const runnersUp = [...totals.entries()]
        .filter(([kind]) => kind !== best)
        .sort((a, b) => {
            const d = b[1] - a[1];
            if (d !== 0) return d;
            return KIND_PRIORITY.indexOf(a[0]) - KIND_PRIORITY.indexOf(b[0]);
        })
        .slice(0, 2)
        .map(([kind, score]) => `${kind}=${score}`);

    const evidence =
        `${best}=${bestScore}: ${winning.join("; ")}` +
        (runnersUp.length > 0 ? ` | runners-up: ${runnersUp.join(", ")}` : "");

    return { kind: best, evidence };
}
