/**
 * Stack Exchange adapter.
 *
 * v1 cannot read Stack Overflow at all — both a `PeekyBot` UA and a real
 * Chrome UA are refused with 403 (verified live this session), and 66 of the
 * 210 HTTP-403 failures in the recorded eval corpus are stackoverflow.com
 * alone. `api.stackexchange.com` answers the same question unauthenticated,
 * in JSON, WITH the vote counts and accepted-answer flag v1 has no way to
 * see. This is the highest-value adapter in v2's fetch layer.
 */

import * as cheerio from "cheerio";
import type { Doc, DocNode, NodeKind } from "../types";
import type { FetchOptions, SourceAdapter } from "./types";
import { htmlToNodes } from "./html-nodes";

/**
 * Decode HTML entities in a plain-text API field.
 *
 * The Stack Exchange API returns titles and display names HTML-escaped, so a
 * question about the `"yield"` keyword arrives as `&quot;yield&quot;`. Bodies
 * are safe already — they go through `htmlToNodes`, which parses them — but the
 * title is used as text, and an undecoded one reaches the caller verbatim.
 */
function decodeEntities(text: string): string {
    if (!text.includes("&")) return text;
    return cheerio.load(`<t>${text}</t>`, null, false)("t").text();
}

/** `decodeEntities` for an optional field, preserving "absent" as undefined. */
function decodeOptional(text: string | undefined): string | undefined {
    return text === undefined ? undefined : decodeEntities(text);
}

const API_BASE = "https://api.stackexchange.com/2.3";
const DEFAULT_TIMEOUT_MS = 8000;
// A real browser UA. v1's dedicated scraper is refused on Stack Exchange's
// HTML pages regardless of UA; the API has no such gate, but we still send a
// real UA rather than an obviously-bot string as a matter of good citizenship.
const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Top-level (non-subdomain) Stack Exchange family sites and their API `site` slug.
const KNOWN_TOP_LEVEL_SITES: Record<string, string> = {
    "stackoverflow.com": "stackoverflow",
    "superuser.com": "superuser",
    "serverfault.com": "serverfault",
    "askubuntu.com": "askubuntu",
    "stackapps.com": "stackapps",
};

/** Resolve a hostname to the Stack Exchange API `site` slug, or null if this isn't an SE family host. */
export function siteFromHostname(hostname: string): string | null {
    const host = hostname.toLowerCase();
    const known = KNOWN_TOP_LEVEL_SITES[host];
    if (known !== undefined) return known;

    const suffix = ".stackexchange.com";
    if (host.endsWith(suffix)) {
        const sub = host.slice(0, -suffix.length);
        if (sub.length > 0 && !sub.includes(".")) return sub;
    }
    return null;
}

export interface ParsedSeUrl {
    site: string;
    /** Present when the URL directly names a question. */
    questionId?: number;
    /** Present when the URL directly names an answer (short-link form: /a/{id}). */
    answerId?: number;
}

/** Parse a Stack Exchange URL into its API site slug and question/answer id, or null if unrecognized. */
export function parseStackExchangeUrl(urlStr: string): ParsedSeUrl | null {
    let url: URL;
    try {
        url = new URL(urlStr);
    } catch {
        return null;
    }

    const site = siteFromHostname(url.hostname);
    if (site === null) return null;

    const questionMatch = /\/(?:questions|q)\/(\d+)/.exec(url.pathname);
    if (questionMatch?.[1] !== undefined) {
        return { site, questionId: Number(questionMatch[1]) };
    }

    const answerMatch = /\/a\/(\d+)/.exec(url.pathname);
    if (answerMatch?.[1] !== undefined) {
        return { site, answerId: Number(answerMatch[1]) };
    }

    return { site };
}

interface SeOwner {
    display_name?: string;
}

interface SeEnvelope<T> {
    items: T[];
    backoff?: number;
    error_id?: number;
    error_name?: string;
    error_message?: string;
}

interface SeQuestion {
    question_id: number;
    title: string;
    body?: string;
    body_markdown?: string;
    score: number;
    accepted_answer_id?: number;
    creation_date?: number;
    owner?: SeOwner;
    link?: string;
    tags?: string[];
}

interface SeAnswer {
    answer_id: number;
    question_id: number;
    body?: string;
    body_markdown?: string;
    score: number;
    is_accepted: boolean;
    creation_date?: number;
    owner?: SeOwner;
}

async function seApiGet<T>(path: string, timeoutMs: number, userAgent: string): Promise<SeEnvelope<T> | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(path, {
            signal: controller.signal,
            headers: {
                "User-Agent": userAgent,
                "Accept": "application/json",
                "Accept-Encoding": "gzip",
            },
        });

        // Unauthenticated quota is 300 req/day; the API returns 400 with a
        // throttle error_id, or 429, when it's exhausted. Either way: fall
        // back, don't throw.
        if (response.status === 429) return null;
        if (!response.ok) return null;

        const json = (await response.json()) as SeEnvelope<T>;

        // `backoff` is the API's courtesy "slow down" signal. Treat its
        // presence as a soft rate limit and let the caller fall back, per
        // the milestone spec.
        if (typeof json.backoff === "number") return null;
        if (json.error_id !== undefined) return null;

        return json;
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

function isoDate(unixSeconds: number | undefined): string | undefined {
    if (unixSeconds === undefined) return undefined;
    return new Date(unixSeconds * 1000).toISOString();
}

/**
 * Convert one Q&A body's HTML into DocNode(s).
 *
 * The body decomposes into structural nodes (heading/code/list-item/table/
 * quote/etc. — see html-nodes.ts) so code blocks and lists keep their own
 * kind for structural scoring. Plain-prose nodes are relabeled to "question"
 * or "answer" — the kind the type contract names for Q&A bodies — since
 * those ARE the question/answer text. Every node from this body carries the
 * same votes/accepted/author/date so a passage can be scored by endorsement
 * regardless of which node(s) within the body it happens to span.
 */
function bodyToDocNodes(
    bodyHtml: string,
    kind: Extract<NodeKind, "question" | "answer">,
    startOrder: number,
    meta: Pick<DocNode, "votes" | "accepted" | "author" | "date">
): DocNode[] {
    const $ = cheerio.load(`<div id="peeky-root">${bodyHtml}</div>`);
    const structural = htmlToNodes($, $("#peeky-root"), { startOrder });

    const withMeta = (n: DocNode): DocNode => ({
        ...n,
        kind: n.kind === "prose" ? kind : n.kind,
        ...(meta.votes !== undefined ? { votes: meta.votes } : {}),
        ...(meta.accepted !== undefined ? { accepted: meta.accepted } : {}),
        ...(meta.author !== undefined ? { author: meta.author } : {}),
        ...(meta.date !== undefined ? { date: meta.date } : {}),
    });

    if (structural.length > 0) {
        return structural.map(withMeta);
    }

    // No structural blocks found (rare: a body that's just inline text with
    // no wrapping <p>). Fall back to one node holding the plain text.
    const text = ($("#peeky-root").text() ?? "").replace(/\s+/g, " ").trim();
    if (text.length === 0) return [];
    return [
        withMeta({
            kind,
            text,
            order: startOrder,
            headingPath: [],
        }),
    ];
}

async function fetchBySite(
    site: string,
    questionId: number,
    timeoutMs: number,
    userAgent: string
): Promise<Doc | null> {
    const questionUrl = `${API_BASE}/questions/${questionId}?site=${encodeURIComponent(site)}&filter=withbody`;
    const answersUrl = `${API_BASE}/questions/${questionId}/answers?site=${encodeURIComponent(
        site
    )}&filter=withbody&sort=votes&order=desc&pagesize=30`;

    const [questionEnv, answersEnv] = await Promise.all([
        seApiGet<SeQuestion>(questionUrl, timeoutMs, userAgent),
        seApiGet<SeAnswer>(answersUrl, timeoutMs, userAgent),
    ]);

    if (questionEnv === null) return null;
    const question = questionEnv.items[0];
    if (question === undefined) return null;

    const nodes: DocNode[] = [];
    let order = 0;

    const questionBody = question.body ?? "";
    const questionDate = isoDate(question.creation_date);
    const questionAuthor = decodeOptional(question.owner?.display_name);
    const questionNodes = bodyToDocNodes(questionBody, "question", order, {
        votes: question.score,
        ...(questionDate !== undefined ? { date: questionDate } : {}),
        ...(questionAuthor !== undefined ? { author: questionAuthor } : {}),
    });
    nodes.push(...questionNodes);
    order += questionNodes.length;

    const answers = answersEnv?.items ?? [];
    for (const answer of answers) {
        const answerDate = isoDate(answer.creation_date);
        const answerAuthor = decodeOptional(answer.owner?.display_name);
        const answerNodes = bodyToDocNodes(answer.body ?? "", "answer", order, {
            votes: answer.score,
            accepted: answer.is_accepted,
            ...(answerDate !== undefined ? { date: answerDate } : {}),
            ...(answerAuthor !== undefined ? { author: answerAuthor } : {}),
        });
        nodes.push(...answerNodes);
        order += answerNodes.length;
    }

    // Renumber densely — bodyToDocNodes numbers each body from its own
    // startOrder, which is already dense across the concatenation above.

    const doc: Doc = {
        url: question.link ?? `https://${site}.stackexchange.com/questions/${questionId}`,
        title: decodeEntities(question.title),
        kind: "qa",
        source: "stackexchange",
        nodes,
        kindEvidence: "stackexchange API: question endpoint returned a valid question_id",
    };
    const publishedAt = isoDate(question.creation_date);
    return publishedAt !== undefined ? { ...doc, publishedAt } : doc;
}

export const stackExchangeAdapter: SourceAdapter = {
    name: "stackexchange",

    canHandle(url: string): boolean {
        const parsed = parseStackExchangeUrl(url);
        return parsed !== null;
    },

    async fetch(url: string, opts: FetchOptions = {}): Promise<Doc | null> {
        const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
        const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

        const parsed = parseStackExchangeUrl(url);
        if (parsed === null) return null;

        if (parsed.questionId !== undefined) {
            return fetchBySite(parsed.site, parsed.questionId, timeoutMs, userAgent);
        }

        if (parsed.answerId !== undefined) {
            // Answer short-link (/a/{id}): resolve the owning question first.
            const answerUrl = `${API_BASE}/answers/${parsed.answerId}?site=${encodeURIComponent(
                parsed.site
            )}&filter=withbody`;
            const env = await seApiGet<SeAnswer>(answerUrl, timeoutMs, userAgent);
            const answer = env?.items[0];
            if (answer === undefined) return null;
            return fetchBySite(parsed.site, answer.question_id, timeoutMs, userAgent);
        }

        return null;
    },
};
