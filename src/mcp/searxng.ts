/**
 * SearXNG API client
 */

import type { SearxngResult, SearxngResponse } from "./types";

export interface SearxngOptions {
    baseUrl: string;
    maxResults: number;
    timeout?: number;
}

/**
 * Search SearXNG for a query and return top results
 */
export async function searchSearxng(
    query: string,
    options: SearxngOptions
): Promise<SearxngResult[]> {
    const { baseUrl, maxResults, timeout = 10000 } = options;

    // Build search URL
    const searchUrl = new URL("/search", baseUrl);
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("format", "json");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(searchUrl.toString(), {
            signal: controller.signal,
            headers: {
                "Accept": "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`SearXNG returned ${response.status}: ${response.statusText}`);
        }

        const data = await response.json() as SearxngResponse;

        // Map and filter results
        return data.results
            .slice(0, maxResults)
            .map(r => ({
                url: r.url,
                title: r.title ?? "",
                content: r.content ?? "",
                score: r.score ?? 1,
                engine: r.engine ?? "unknown",
            }));
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`SearXNG request timed out after ${timeout}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}
