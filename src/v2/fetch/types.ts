/**
 * Contract for a structured source adapter.
 *
 * v1 scrapes HTML for everything, which is why it cannot read Stack Overflow
 * at all (403 on every UA, verified) while `api.stackexchange.com` answers
 * the same question with vote counts and accepted flags attached. An adapter
 * is a source-specific shortcut that reaches a structured API (or a markdown
 * sibling) before falling back to scraping HTML.
 */

import type { Doc } from "../types";

export interface FetchOptions {
    /** Abort timeout in milliseconds. */
    timeout?: number;
    /** Overrides the adapter's default User-Agent. */
    userAgent?: string;
}

export interface SourceAdapter {
    /** Short identifier for logging/debugging. Matches `Doc.source` where applicable. */
    name: string;
    /** Cheap, synchronous check: does this URL belong to the source this adapter knows how to fetch? */
    canHandle(url: string): boolean;
    /**
     * Fetch and parse the URL into a Doc.
     *
     * MUST NOT throw on network failure, timeout, or a source-specific soft
     * failure (rate limit, 404, non-matching content type) — return null so
     * the resolver falls through to the next adapter instead.
     */
    fetch(url: string, opts?: FetchOptions): Promise<Doc | null>;
}
