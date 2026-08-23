/**
 * Markdown-sibling adapter.
 *
 * Some doc sites serve clean markdown at the page URL plus `.md`
 * (react.dev, docs.anthropic.com, nextjs.org — verified live this session).
 * Others don't (tailwindcss.com, hono.dev, docs.astro.build — also verified
 * 404 this session; roughly 40% hit rate across the doc hosts checked).
 * This is opportunistic, not a foundation.
 *
 * The two probe outcomes carry different information and are cached
 * asymmetrically:
 *   - A HIT generalizes well: it proves the host serves markdown siblings at
 *     all, so we keep trying on every subsequent URL for that host forever.
 *   - A MISS does NOT generalize: measured live this session, vite.dev/guide/
 *     404s while vite.dev/guide/why returns 200 markdown — one 404 says
 *     nothing about other paths on the same host. Caching "no" after a
 *     single miss would permanently and silently disable a working adapter
 *     for the whole domain depending on which page happened to be probed
 *     first. So a host is only marked as not supporting the technique after
 *     MAX_CONSECUTIVE_MISSES misses IN A ROW with no hit ever recorded; any
 *     hit resets the streak.
 */

import type { Doc } from "../types";
import type { FetchOptions, SourceAdapter } from "./types";
import { markdownToNodes } from "./markdown-nodes";

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Hosts already owned by a more specific structured adapter; probing a `.md`
// sibling there would only waste a request.
const EXCLUDED_HOST_SUFFIXES = ["stackexchange.com", "stackoverflow.com", "superuser.com", "serverfault.com", "askubuntu.com", "stackapps.com", "github.com", "npmjs.com"];

function isExcludedHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return EXCLUDED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** A host is only considered permanently unsupported after this many consecutive misses with no hit ever recorded. */
export const MAX_CONSECUTIVE_MISSES = 3;
/** Upper bound on distinct hosts tracked, so a long session can't grow the cache without limit. Oldest entry is evicted on overflow. */
export const MAX_TRACKED_HOSTS = 500;

interface HostProbeState {
    /** Consecutive misses since the last hit (or since tracking started). Reset to 0 on any hit. */
    consecutiveMisses: number;
    /** Whether this host has EVER returned a valid markdown response. Once true, the host is never disabled. */
    confirmedGood: boolean;
}

/** Per-host probe state, process lifetime, bounded by MAX_TRACKED_HOSTS. Exported for tests to reset/inspect between cases. */
export const hostProbeState = new Map<string, HostProbeState>();

function setHostState(host: string, state: HostProbeState): void {
    if (!hostProbeState.has(host) && hostProbeState.size >= MAX_TRACKED_HOSTS) {
        // Bound the cache: evict the oldest-tracked host (Map preserves insertion order).
        const oldestKey = hostProbeState.keys().next().value;
        if (oldestKey !== undefined) hostProbeState.delete(oldestKey);
    }
    hostProbeState.set(host, state);
}

function recordHit(host: string): void {
    setHostState(host, { consecutiveMisses: 0, confirmedGood: true });
}

function recordMiss(host: string): void {
    const prev = hostProbeState.get(host);
    setHostState(host, {
        consecutiveMisses: (prev?.consecutiveMisses ?? 0) + 1,
        confirmedGood: prev?.confirmedGood ?? false,
    });
}

/** A host is skipped without a network call only once it has racked up MAX_CONSECUTIVE_MISSES misses with no hit ever. */
function isPermanentlyUnsupported(host: string): boolean {
    const state = hostProbeState.get(host);
    if (state === undefined) return false;
    if (state.confirmedGood) return false;
    return state.consecutiveMisses >= MAX_CONSECUTIVE_MISSES;
}

function looksLikeHtmlErrorPage(text: string): boolean {
    const head = text.slice(0, 512).toLowerCase();
    return head.includes("<!doctype html") || head.includes("<html");
}

function isMarkdownish(contentType: string): boolean {
    const ct = contentType.toLowerCase();
    return ct.includes("text/markdown") || ct.includes("text/plain");
}

async function fetchCandidate(
    mdUrl: string,
    timeoutMs: number,
    userAgent: string
): Promise<{ text: string } | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(mdUrl, {
            signal: controller.signal,
            headers: { "User-Agent": userAgent, "Accept": "text/markdown,text/plain,*/*;q=0.1" },
            redirect: "follow",
        });
        if (!response.ok) return null;

        const contentType = response.headers.get("content-type") ?? "";
        if (!isMarkdownish(contentType)) return null;

        const text = await response.text();
        if (looksLikeHtmlErrorPage(text)) return null;
        if (text.trim().length === 0) return null;

        return { text };
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

export const markdownAdapter: SourceAdapter = {
    name: "markdown",

    canHandle(url: string): boolean {
        try {
            const u = new URL(url);
            if (u.protocol !== "http:" && u.protocol !== "https:") return false;
            return !isExcludedHost(u.hostname);
        } catch {
            return false;
        }
    },

    async fetch(url: string, opts: FetchOptions = {}): Promise<Doc | null> {
        const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
        const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return null;
        }

        const host = parsed.hostname.toLowerCase();

        // Only skip the network call once this host has proven itself
        // unsupported MAX_CONSECUTIVE_MISSES times in a row with no hit ever
        // — a single miss (or even two) says nothing about the rest of the
        // host's pages.
        if (isPermanentlyUnsupported(host)) return null;

        const mdUrl = url.endsWith(".md") ? url : `${url}.md`;
        const candidate = await fetchCandidate(mdUrl, timeoutMs, userAgent);

        if (candidate === null) {
            recordMiss(host);
            return null;
        }

        recordHit(host);

        const nodes = markdownToNodes(candidate.text);
        if (nodes.length === 0) return null;

        const headingNode = nodes.find((n) => n.kind === "heading");
        const title = headingNode?.text ?? parsed.pathname.split("/").filter((s) => s.length > 0).pop() ?? url;

        return {
            url,
            finalUrl: mdUrl,
            title,
            kind: "guide",
            source: "markdown",
            nodes,
            kindEvidence: "markdown: page URL + .md returned a markdown/plain response",
        };
    },
};
