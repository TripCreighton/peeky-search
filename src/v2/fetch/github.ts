/**
 * GitHub adapter.
 *
 * A repo's main page is JS-rendered — v1 blocklists `github.com` entirely.
 * The README is plain markdown at a stable raw URL with no rendering
 * involved, and issues/discussions have an unauthenticated public REST API
 * that returns the body and comments as JSON. Both are faster and more
 * reliable than scraping the rendered page.
 */

import type { Doc, DocNode } from "../types";
import type { FetchOptions, SourceAdapter } from "./types";
import { markdownToNodes } from "./markdown-nodes";
import { htmlToNodes } from "./html-nodes";
import * as cheerio from "cheerio";

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

interface ParsedGithubUrl {
    owner: string;
    repo: string;
    kind: "repo" | "issue" | "discussion";
    number?: number;
}

/** Parse a github.com URL into owner/repo and what kind of page it is. */
export function parseGithubUrl(urlStr: string): ParsedGithubUrl | null {
    let url: URL;
    try {
        url = new URL(urlStr);
    } catch {
        return null;
    }

    if (url.hostname.toLowerCase() !== "github.com") return null;

    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    const owner = segments[0];
    const repo = segments[1];
    if (owner === undefined || repo === undefined) return null;

    if (segments[2] === "issues" && segments[3] !== undefined && /^\d+$/.test(segments[3])) {
        return { owner, repo, kind: "issue", number: Number(segments[3]) };
    }
    if (segments[2] === "discussions" && segments[3] !== undefined && /^\d+$/.test(segments[3])) {
        return { owner, repo, kind: "discussion", number: Number(segments[3]) };
    }
    if (segments.length === 2) {
        return { owner, repo, kind: "repo" };
    }

    return null;
}

async function fetchText(url: string, timeoutMs: number, userAgent: string, accept: string): Promise<string | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { "User-Agent": userAgent, "Accept": accept },
        });
        if (!response.ok) return null;
        return await response.text();
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchJson<T>(url: string, timeoutMs: number, userAgent: string): Promise<T | null> {
    const text = await fetchText(url, timeoutMs, userAgent, "application/vnd.github+json");
    if (text === null) return null;
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

async function fetchReadme(owner: string, repo: string, timeoutMs: number, userAgent: string): Promise<Doc | null> {
    // README name/case/extension varies; try the common candidates against
    // both the default branch alias and the two conventional branch names.
    const candidates = [
        `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/readme.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.markdown`,
        `https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/README.md`,
    ];

    for (const candidate of candidates) {
        const text = await fetchText(candidate, timeoutMs, userAgent, "text/plain,text/markdown,*/*;q=0.5");
        if (text !== null && text.trim().length > 0) {
            const nodes = markdownToNodes(text);
            if (nodes.length === 0) continue;
            return {
                url: `https://github.com/${owner}/${repo}`,
                title: `${owner}/${repo}`,
                kind: "guide",
                source: "github",
                nodes,
                kindEvidence: `github: raw README fetched from ${candidate}`,
            };
        }
    }

    return null;
}

interface GhIssue {
    title: string;
    body?: string;
    user?: { login?: string };
    created_at?: string;
    number: number;
    html_url?: string;
}

interface GhComment {
    body?: string;
    user?: { login?: string };
    created_at?: string;
}

async function fetchIssueOrDiscussion(
    owner: string,
    repo: string,
    kindPath: "issues",
    number: number,
    timeoutMs: number,
    userAgent: string
): Promise<Doc | null> {
    const issueUrl = `https://api.github.com/repos/${owner}/${repo}/${kindPath}/${number}`;
    const commentsUrl = `https://api.github.com/repos/${owner}/${repo}/${kindPath}/${number}/comments`;

    const [issue, comments] = await Promise.all([
        fetchJson<GhIssue>(issueUrl, timeoutMs, userAgent),
        fetchJson<GhComment[]>(commentsUrl, timeoutMs, userAgent),
    ]);

    if (issue === null) return null;

    const nodes: DocNode[] = [];
    let order = 0;

    if (issue.body !== undefined && issue.body.trim().length > 0) {
        const bodyNodes = htmlBodyToNodes(issue.body, "question", order);
        const author = issue.user?.login;
        const date = issue.created_at;
        for (const n of bodyNodes) {
            nodes.push({
                ...n,
                ...(author !== undefined ? { author } : {}),
                ...(date !== undefined ? { date } : {}),
            });
        }
        order += bodyNodes.length;
    }

    for (const comment of comments ?? []) {
        if (comment.body === undefined || comment.body.trim().length === 0) continue;
        const commentNodes = htmlBodyToNodes(comment.body, "answer", order);
        const author = comment.user?.login;
        const date = comment.created_at;
        for (const n of commentNodes) {
            nodes.push({
                ...n,
                ...(author !== undefined ? { author } : {}),
                ...(date !== undefined ? { date } : {}),
            });
        }
        order += commentNodes.length;
    }

    if (nodes.length === 0) return null;

    const doc: Doc = {
        url: issue.html_url ?? `https://github.com/${owner}/${repo}/issues/${number}`,
        title: issue.title,
        kind: "issue",
        source: "github",
        nodes,
        kindEvidence: "github: issues REST API returned a body",
    };
    return issue.created_at !== undefined ? { ...doc, publishedAt: issue.created_at } : doc;
}

/**
 * GitHub issue/comment bodies are markdown-in-a-JSON-field (GFM), not HTML.
 * We don't have a markdown renderer here, so treat structural markdown cues
 * (fenced code, headings) via the markdown-nodes helper, which is built for
 * exactly this text shape.
 */
function htmlBodyToNodes(markdownBody: string, fallbackKind: "question" | "answer", startOrder: number): DocNode[] {
    const nodes = markdownToNodes(markdownBody, { startOrder });
    if (nodes.length > 0) {
        return nodes.map((n) => (n.kind === "prose" ? { ...n, kind: fallbackKind } : n));
    }
    const text = markdownBody.replace(/\s+/g, " ").trim();
    if (text.length === 0) return [];
    return [{ kind: fallbackKind, text, order: startOrder, headingPath: [] }];
}

export const githubAdapter: SourceAdapter = {
    name: "github",

    canHandle(url: string): boolean {
        return parseGithubUrl(url) !== null;
    },

    async fetch(url: string, opts: FetchOptions = {}): Promise<Doc | null> {
        const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
        const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

        const parsed = parseGithubUrl(url);
        if (parsed === null) return null;

        if (parsed.kind === "repo") {
            return fetchReadme(parsed.owner, parsed.repo, timeoutMs, userAgent);
        }

        if (parsed.kind === "issue" && parsed.number !== undefined) {
            const doc = await fetchIssueOrDiscussion(parsed.owner, parsed.repo, "issues", parsed.number, timeoutMs, userAgent);
            if (doc !== null) return doc;
            return fetchIssueHtmlFallback(url, timeoutMs, userAgent);
        }

        if (parsed.kind === "discussion") {
            // Discussions have no stable public REST endpoint without auth
            // (they're GraphQL-only); fall back to scraping the page.
            return fetchIssueHtmlFallback(url, timeoutMs, userAgent);
        }

        return null;
    },
};

/** Last-resort HTML scrape for pages the REST API can't reach unauthenticated (e.g. discussions). */
async function fetchIssueHtmlFallback(url: string, timeoutMs: number, userAgent: string): Promise<Doc | null> {
    const html = await fetchText(url, timeoutMs, userAgent, "text/html");
    if (html === null) return null;

    const $ = cheerio.load(html);
    const title = ($("title").first().text() ?? "").replace(/\s+/g, " ").trim();
    const main = $("main, [role='main'], article").first();
    const container = main.length > 0 ? main : $("body");
    const nodes = htmlToNodes($, container);
    if (nodes.length === 0) return null;

    return {
        url,
        title: title.length > 0 ? title : url,
        kind: "issue",
        source: "github",
        nodes,
        kindEvidence: "github: HTML fallback (no unauthenticated REST endpoint for this page type)",
    };
}
