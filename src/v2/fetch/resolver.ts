/**
 * Adapter resolver: tries structured sources first, falls back to generic HTML.
 *
 * Order matters. Stack Exchange, GitHub, and the npm registry are checked
 * first because their `canHandle` is host-specific and precise. Markdown is
 * checked next because it's opportunistic across any remaining host and
 * cheap to rule out (one request, then cached per host). Generic HTML is
 * last because it claims every http(s) URL and must never pre-empt a
 * structured source that could have answered instead.
 */

import type { Doc } from "../types";
import type { FetchOptions, SourceAdapter } from "./types";
import { stackExchangeAdapter } from "./stackexchange";
import { githubAdapter } from "./github";
import { registryAdapter } from "./registry";
import { markdownAdapter } from "./markdown";
import { htmlAdapter } from "./html";

export const adapters: SourceAdapter[] = [stackExchangeAdapter, githubAdapter, registryAdapter, markdownAdapter, htmlAdapter];

/**
 * Fetch a URL as a Doc, trying each adapter that claims it in priority order
 * and falling through on a null result (network failure, rate limit, no
 * markdown sibling, etc.) until one succeeds or all are exhausted.
 */
export async function fetchDoc(url: string, opts: FetchOptions = {}): Promise<Doc | null> {
    for (const adapter of adapters) {
        if (!adapter.canHandle(url)) continue;
        const doc = await adapter.fetch(url, opts);
        if (doc !== null) return doc;
    }
    return null;
}

/** The first adapter that claims a URL, without fetching. Useful for diagnostics/tests. */
export function resolveAdapter(url: string): SourceAdapter | null {
    for (const adapter of adapters) {
        if (adapter.canHandle(url)) return adapter;
    }
    return null;
}
