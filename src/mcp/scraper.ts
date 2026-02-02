/**
 * Parallel web scraper for fetching HTML content
 */

import type { ScrapeResult } from "./types";

export interface ScraperOptions {
    timeout?: number;
    userAgent?: string;
    maxConcurrent?: number;
}

const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; PeekyBot/1.0; +https://github.com/peeky-search)";
const DEFAULT_MAX_CONCURRENT = 3;

/**
 * Run async tasks with limited concurrency
 */
async function runWithConcurrency<T>(
    items: T[],
    fn: (item: T) => Promise<unknown>,
    maxConcurrent: number
): Promise<void> {
    const queue = [...items];
    const workers: Promise<void>[] = [];

    for (let i = 0; i < Math.min(maxConcurrent, queue.length); i++) {
        workers.push((async () => {
            while (queue.length > 0) {
                const item = queue.shift();
                if (item !== undefined) {
                    await fn(item);
                }
            }
        })());
    }

    await Promise.all(workers);
}

/**
 * Scrape a single URL and return its HTML content
 */
async function scrapeUrl(
    url: string,
    options: ScraperOptions
): Promise<ScrapeResult> {
    const { timeout = 5000, userAgent = DEFAULT_USER_AGENT } = options;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

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

        if (!response.ok) {
            return {
                url,
                html: null,
                error: `HTTP ${response.status}: ${response.statusText}`,
            };
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
            return {
                url,
                html: null,
                error: `Non-HTML content type: ${contentType}`,
            };
        }

        const html = await response.text();
        return { url, html };
    } catch (error) {
        if (error instanceof Error) {
            if (error.name === "AbortError") {
                return {
                    url,
                    html: null,
                    error: `Timeout after ${timeout}ms`,
                };
            }
            return {
                url,
                html: null,
                error: error.message,
            };
        }
        return {
            url,
            html: null,
            error: "Unknown error",
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Scrape multiple URLs with limited concurrency
 */
export async function scrapeUrls(
    urls: string[],
    options: ScraperOptions = {}
): Promise<ScrapeResult[]> {
    const { maxConcurrent = DEFAULT_MAX_CONCURRENT } = options;
    const results: ScrapeResult[] = [];

    await runWithConcurrency(
        urls,
        async (url) => {
            const result = await scrapeUrl(url, options);
            results.push(result);
        },
        maxConcurrent
    );

    return results;
}
