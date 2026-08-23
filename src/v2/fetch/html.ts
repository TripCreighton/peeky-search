/**
 * Generic HTML fallback adapter.
 *
 * The guaranteed last resort: claims every http(s) URL, so the resolver
 * always has something to try once the structured adapters have passed.
 *
 * Parsing goes through `parseHtml` — the SAME function the eval harness runs.
 * That equality is the point, and it was not always true: this adapter used to
 * call v1's `preprocessHtml` and then walk the result with `htmlToNodes`,
 * while the harness called `parseHtml`. Two implementations of one job, and
 * they disagreed where it mattered most — v1's boilerplate list contains
 * `/comment/`, which deletes every answer on a Q&A or discussion page, and
 * avoiding exactly that is why `parse.ts` exists. So every measured number
 * described a parser that no user ever ran.
 *
 * If this file stops calling `parseHtml`, the eval stops describing the
 * product. `html-nodes.ts` is still right for the structured adapters, which
 * walk clean API-returned HTML fragments with no boilerplate to strip.
 */

import type { Doc } from "../types";
import type { FetchOptions, SourceAdapter } from "./types";
import { parseHtml } from "../parse";

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export const htmlAdapter: SourceAdapter = {
    name: "html",

    canHandle(url: string): boolean {
        try {
            const u = new URL(url);
            return u.protocol === "http:" || u.protocol === "https:";
        } catch {
            return false;
        }
    },

    async fetch(url: string, opts: FetchOptions = {}): Promise<Doc | null> {
        const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
        const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        let html: string;
        let finalUrl = url;
        try {
            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    "User-Agent": userAgent,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.5",
                },
                redirect: "follow",
            });
            if (!response.ok) return null;

            const contentType = response.headers.get("content-type") ?? "";
            if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) return null;

            finalUrl = response.url.length > 0 ? response.url : url;
            html = await response.text();
        } catch {
            return null;
        } finally {
            clearTimeout(timeoutId);
        }

        let doc: Doc;
        try {
            doc = parseHtml(html, url, {
                ...(finalUrl !== url ? { finalUrl } : {}),
            });
        } catch {
            // A parse failure means this page is unreadable, not that the query
            // failed. Same disposition as a non-200.
            return null;
        }

        return doc.nodes.length > 0 ? doc : null;
    },
};
