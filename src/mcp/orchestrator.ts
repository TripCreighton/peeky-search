/**
 * Main orchestration for MCP search pipeline
 */

import type { SearchConfig, SearchResult, PageExtraction, SearxngResult, PageDiagnostics, PageStatus } from "./types";
import type { Block } from "../types";
import { DEFAULT_CONFIG } from "./types";
import type { RelevanceMetrics } from "../pipeline";
import { searchSearxng } from "./searxng";
import { scrapeUrls } from "./scraper";
import { extractExcerpts, type PipelineConfig } from "../pipeline";
import { tokenize } from "../preprocessing/tokenize";
import { parseSearchOperators } from "./query-parser";
import { preprocessHtml } from "../preprocessing/strip";
import { extractBlocks } from "../preprocessing/segment";
import Logger from "../utils/logger";

const logger = Logger.getInstance();

/**
 * Session-based URL+query tracking for cross-call deduplication.
 * Maps sessionKey -> { urls: Set of composite keys (url:sortedTokens), lastUsed: timestamp }
 *
 * Composite keys allow the same URL to be re-fetched for substantially different queries
 * while deduplicating near-identical queries (stemming normalizes "hooks" → "hook").
 */
interface SessionData {
    urls: Set<string>;
    lastUsed: number;
}

const sessionCache = new Map<string, SessionData>();

/** Session TTL: 10 seconds (short to allow retries with same key) */
const SESSION_TTL_MS = 10 * 1000;

/**
 * Clean up expired sessions (older than TTL)
 */
function cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [key, session] of sessionCache) {
        if (now - session.lastUsed > SESSION_TTL_MS) {
            sessionCache.delete(key);
        }
    }
}

/**
 * Get or create a session by key
 */
function getSession(sessionKey: string): SessionData {
    cleanupExpiredSessions();

    let session = sessionCache.get(sessionKey);
    if (!session) {
        session = { urls: new Set(), lastUsed: Date.now() };
        sessionCache.set(sessionKey, session);
    } else {
        session.lastUsed = Date.now();
    }
    return session;
}

/**
 * Create a composite cache key from URL + sorted query tokens.
 * This allows the same URL to be re-fetched for substantially different queries
 * while deduplicating near-identical queries (stemming normalizes variations).
 *
 * Exported for testing.
 */
export function createSessionCacheKey(url: string, tokens: string[]): string {
    const uniqueSorted = [...new Set(tokens)].sort();
    return `${url}:${uniqueSorted.join(",")}`;
}

/**
 * Add URLs to a session's seen set (with query-specific composite keys)
 */
function addUrlsToSession(sessionKey: string, urls: string[], queryTokens: string[]): void {
    const session = getSession(sessionKey);
    for (const url of urls) {
        const cacheKey = createSessionCacheKey(url, queryTokens);
        session.urls.add(cacheKey);
    }
}

/**
 * Filter out URLs already seen in this session for the same query.
 * Uses composite keys (url + tokens) so the same URL can be re-fetched
 * for substantially different queries.
 * Returns { newUrls, skippedUrls }
 */
function filterSessionUrls(
    sessionKey: string | undefined,
    urls: string[],
    queryTokens: string[]
): { newUrls: string[]; skippedUrls: string[] } {
    if (!sessionKey) {
        return { newUrls: urls, skippedUrls: [] };
    }

    const session = getSession(sessionKey);
    const newUrls: string[] = [];
    const skippedUrls: string[] = [];

    for (const url of urls) {
        const cacheKey = createSessionCacheKey(url, queryTokens);
        if (session.urls.has(cacheKey)) {
            skippedUrls.push(url);
        } else {
            newUrls.push(url);
        }
    }

    return { newUrls, skippedUrls };
}

/**
 * Blocklist of domains that are blocked for various reasons:
 * - medium.com: 403 Forbidden for bots, obfuscated CSS, often paywalled
 * - npmjs.com: 403 Forbidden for bots
 * - researchgate.net: Heavy metadata noise, often paywalled/login-gated
 * - grokipedia.org: AI-generated content, low quality
 *
 * Note: GitHub issues/discussions work fine, only repo main pages use JSON.
 * Stack Exchange sites (stackoverflow, etc.) are server-rendered and work well.
 */
const BLOCKED_DOMAINS = new Set([
    "medium.com",
    "npmjs.com",
    "researchgate.net",
    "grokipedia.org",
]);

/**
 * GitHub repo main pages are JS-rendered (README loaded dynamically).
 * But issues, discussions, PRs, and other subpages are server-rendered.
 * Pattern: github.com/{user}/{repo} or github.com/{user}/{repo}/ (no further path)
 */
function isGitHubRepoMainPage(url: string): boolean {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.replace(/^www\./, "");
        if (hostname !== "github.com") return false;

        // Path like /user/repo or /user/repo/
        const path = urlObj.pathname.replace(/\/$/, ""); // strip trailing slash
        const segments = path.split("/").filter(s => s.length > 0);

        // Exactly 2 segments = repo main page (e.g., /xhluca/bm25s)
        // More segments = subpage (issues, pulls, discussions, blob, tree, etc.)
        return segments.length === 2;
    } catch {
        return false;
    }
}

/**
 * Check if a URL is from a known JS-rendered domain or blocked pattern
 */
function isBlockedDomain(url: string): boolean {
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, "");

        // Check exact match or subdomain match
        for (const blocked of BLOCKED_DOMAINS) {
            if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
                return true;
            }
        }

        // Special case: Check GitHub repo main pages specifically
        if (isGitHubRepoMainPage(url)) {
            return true;
        }

        return false;
    } catch {
        return false;
    }
}

/**
 * Patterns to strip from URL paths for deduplication
 * Matches version segments like /v1/, /v2/, /stable/, /latest/, /4.3/, etc.
 */
const VERSION_PATH_PATTERNS = [
    /\/v\d+(\.\d+)*\//gi,           // /v1/, /v2/, /v1.2.3/
    /\/\d+\.\d+(\.\d+)*\//gi,       // /4.3/, /3.0.0/
    /\/(stable|latest|current|master|main|dev|nightly)\//gi,
    /\/(en|en-us|en-gb)\//gi,       // Language prefixes (often redundant)
];

/**
 * Patterns to strip from hostnames for deduplication
 * Matches version subdomains like v1.example.com, v2.example.com
 * and language subdomains like en.example.com, he.example.com
 */
const VERSION_SUBDOMAIN_PATTERNS = [
    /^v\d+\./i,                     // v1., v2., etc.
    /^\d+\.\d+\./,                  // 4.3., 3.0., etc.
    /^(stable|latest|current|docs)\./i,
    /^[a-z]{2}\./i,                 // Two-letter language codes: en., he., fr., etc.
    /^[a-z]{2}-[a-z]{2}\./i,        // Regional codes: en-us., pt-br., etc.
];

/**
 * Normalize URL for deduplication by stripping version paths and subdomains
 */
function normalizeUrlForDedup(url: string): string {
    try {
        const urlObj = new URL(url);
        let hostname = urlObj.hostname;
        let path = urlObj.pathname;

        // Strip version subdomains (v1.tailwindcss.com -> tailwindcss.com)
        for (const pattern of VERSION_SUBDOMAIN_PATTERNS) {
            hostname = hostname.replace(pattern, "");
        }

        // Strip version patterns from path
        for (const pattern of VERSION_PATH_PATTERNS) {
            path = path.replace(pattern, "/");
        }

        // Normalize multiple slashes
        path = path.replace(/\/+/g, "/");

        return `${hostname}${path}`;
    } catch {
        return url;
    }
}

/**
 * Deduplicate URLs by normalized path, keeping the first (highest-ranked) one
 */
function deduplicateUrls(results: SearxngResult[]): SearxngResult[] {
    const seen = new Map<string, SearxngResult>();

    for (const result of results) {
        const normalized = normalizeUrlForDedup(result.url);
        if (!seen.has(normalized)) {
            seen.set(normalized, result);
        }
    }

    return Array.from(seen.values());
}

/**
 * Weights for computing page relevance scores.
 * Title and excerpt content are weighted equally (0.35 each) as primary signals.
 * URL path matching (0.15) helps identify relevant technical documentation.
 * SearXNG score (0.15) incorporates search engine ranking as a baseline.
 */
const PAGE_RELEVANCE_WEIGHTS = {
    titleMatch: 0.35,
    urlMatch: 0.15,
    excerptScore: 0.35,
    searxngScore: 0.15,
} as const;

/**
 * Search-optimized pipeline config for multi-page extraction
 * Uses looser relevance detection and balanced excerpts
 */
const SEARCH_PIPELINE_CONFIG: PipelineConfig = {
    ranker: {
        relevanceMode: "search", // Looser relevance for multi-page search
    },
    anchors: {
        maxAnchors: 5, // More anchors for comprehensive docs coverage
    },
    expand: {
        maxChunkChars: 2000,  // Larger chunks for better context
        contextAfter: 12,     // More trailing context for code explanations
        contextBefore: 8,     // More leading context
    },
};

/**
 * Extract title from HTML
 */
function extractTitle(html: string): string {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch?.[1]) {
        return titleMatch[1].trim();
    }
    return "";
}

/**
 * Minimum pre-scrape relevance threshold.
 * Results below this are filtered before scraping to save bandwidth/time.
 * 0.4 = at least 40% of query tokens must appear in title + snippet + URL
 */
const MIN_PRESCRAPE_RELEVANCE = 0.4;

/**
 * Compute pre-scrape relevance score for a SearXNG result.
 * Uses title, snippet (content), and URL path to determine if worth scraping.
 * Returns a score from 0-1 representing what fraction of query tokens are found.
 */
export function computePreScrapeRelevance(
    result: SearxngResult,
    queryTokens: string[]
): number {
    if (queryTokens.length === 0) return 1; // No query = accept all

    const titleTokens = tokenize(result.title);
    const snippetTokens = tokenize(result.content);
    const urlTokens = getUrlPathTokens(result.url);

    // Combined token pool from title + snippet + URL
    const allTokens = new Set([...titleTokens, ...snippetTokens, ...urlTokens]);

    // What fraction of query tokens appear somewhere?
    let matches = 0;
    for (const qt of queryTokens) {
        if (allTokens.has(qt)) matches++;
    }

    return matches / queryTokens.length;
}

/**
 * Compute token overlap ratio between two token sets
 */
function tokenOverlap(tokensA: string[], tokensB: string[]): number {
    if (tokensA.length === 0 || tokensB.length === 0) return 0;

    const setB = new Set(tokensB);
    let matches = 0;
    for (const token of tokensA) {
        if (setB.has(token)) matches++;
    }
    return matches / tokensA.length;
}

/**
 * Extract path segments from URL for matching
 */
function getUrlPathTokens(url: string): string[] {
    try {
        const urlObj = new URL(url);
        // Split path, filter empty, tokenize each segment
        const segments = urlObj.pathname.split("/").filter(s => s.length > 0);
        const tokens: string[] = [];
        for (const segment of segments) {
            // Tokenize segment (handles camelCase, kebab-case, etc.)
            tokens.push(...tokenize(segment.replace(/-/g, " ")));
        }
        return tokens;
    } catch {
        return [];
    }
}

/**
 * Compute relevance score for a page based on multiple factors
 */
function computePageRelevance(
    page: PageExtraction,
    queryTokens: string[],
    searxngScore: number
): number {
    // Factor 1: Title match (0-1, weight: 0.35)
    const titleTokens = tokenize(page.title);
    const titleMatch = tokenOverlap(queryTokens, titleTokens);

    // Factor 2: URL path match (0-1, weight: 0.15)
    const urlTokens = getUrlPathTokens(page.url);
    const urlMatch = tokenOverlap(queryTokens, urlTokens);

    // Factor 3: Best excerpt score (0-1, weight: 0.35)
    const bestExcerptScore = page.excerpts.length > 0
        ? Math.max(...page.excerpts.map(e => e.score))
        : 0;

    // Factor 4: SearXNG score (normalized 0-1, weight: 0.15)
    // SearXNG scores vary, normalize assuming max ~10
    const normalizedSearxng = Math.min(searxngScore / 10, 1);

    // Weighted combination
    return (
        PAGE_RELEVANCE_WEIGHTS.titleMatch * titleMatch +
        PAGE_RELEVANCE_WEIGHTS.urlMatch * urlMatch +
        PAGE_RELEVANCE_WEIGHTS.excerptScore * bestExcerptScore +
        PAGE_RELEVANCE_WEIGHTS.searxngScore * normalizedSearxng
    );
}

interface ProcessPageResult {
    extraction: PageExtraction;
    relevanceMetrics: RelevanceMetrics | undefined;
}

/**
 * Process a single page: extract excerpts using the IR pipeline
 */
function processPage(
    url: string,
    html: string,
    query: string,
    charBudget: number,
    searchResult?: SearxngResult
): ProcessPageResult {
    try {
        const result = extractExcerpts(html, query, {
            ...SEARCH_PIPELINE_CONFIG,
            excerpts: {
                charBudget,
                maxExcerpts: 5,  // More excerpts for comprehensive docs
            },
        });

        const title = searchResult?.title ?? extractTitle(html) ?? url;

        return {
            extraction: {
                url,
                title,
                excerpts: result.excerpts.map(e => ({
                    text: e.text,
                    headingPath: e.headingPath,
                    score: e.score,
                })),
                totalChars: result.totalChars,
            },
            relevanceMetrics: result.relevanceMetrics,
        };
    } catch (error) {
        return {
            extraction: {
                url,
                title: searchResult?.title ?? url,
                excerpts: [],
                totalChars: 0,
                error: error instanceof Error ? error.message : "Unknown extraction error",
            },
            relevanceMetrics: undefined,
        };
    }
}

/**
 * Extract domain from URL for display
 */
function getDomain(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return url;
    }
}

/**
 * Get a short URL for diagnostics (domain + truncated path)
 */
function getShortUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const domain = parsed.hostname.replace(/^www\./, "");
        let path = parsed.pathname;
        // Truncate long paths
        if (path.length > 40) {
            path = path.slice(0, 37) + "...";
        }
        return domain + path;
    } catch {
        return url;
    }
}

/**
 * Format a single page's diagnostic status
 */
function formatPageStatus(diag: PageDiagnostics): string {
    const shortUrl = getShortUrl(diag.url);

    switch (diag.status) {
        case "success":
            return `+ [${shortUrl}] ${diag.excerptCount} excerpt(s), ${diag.charCount} chars`;
        case "scrape_failed":
            return `- [${shortUrl}] FAILED: ${diag.error ?? "Could not fetch page"}`;
        case "no_content":
            return `- [${shortUrl}] SKIPPED: No extractable content`;
        case "not_relevant": {
            const coverage = diag.metrics?.queryTermCoverage ?? 0;
            const bm25 = diag.metrics?.maxBm25 ?? 0;
            const coveragePct = (coverage * 100).toFixed(0);
            return `- [${shortUrl}] SKIPPED: Not relevant (${coveragePct}% terms, score: ${bm25.toFixed(2)})`;
        }
        case "budget_exceeded":
            return `~ [${shortUrl}] TRUNCATED: Output limit reached`;
        case "blocked_js":
            return `x [${shortUrl}] SKIPPED: JS-rendered site`;
        case "low_quality":
            return `x [${shortUrl}] SKIPPED: ${diag.error ?? "Low quality content"}`;
        case "session_cached":
            return `= [${shortUrl}] SKIPPED: Already fetched in this session`;
        case "title_filtered": {
            const coverage = diag.metrics?.queryTermCoverage ?? 0;
            const coveragePct = (coverage * 100).toFixed(0);
            return `x [${shortUrl}] SKIPPED: Low title/snippet relevance (${coveragePct}% match)`;
        }
        default:
            return `? [${shortUrl}] Unknown status`;
    }
}

/**
 * Generate actionable suggestions based on diagnostic results
 */
function generateSuggestions(
    diagnostics: PageDiagnostics[],
    queryTokens: string[]
): string[] {
    const suggestions: string[] = [];

    const successCount = diagnostics.filter(d => d.status === "success").length;
    const notRelevantPages = diagnostics.filter(d => d.status === "not_relevant");
    const noContentCount = diagnostics.filter(d => d.status === "no_content").length;
    const scrapeFailedCount = diagnostics.filter(d => d.status === "scrape_failed").length;
    const budgetExceededCount = diagnostics.filter(d => d.status === "budget_exceeded").length;
    const blockedJsCount = diagnostics.filter(d => d.status === "blocked_js").length;
    const lowQualityCount = diagnostics.filter(d => d.status === "low_quality").length;
    const sessionCachedCount = diagnostics.filter(d => d.status === "session_cached").length;
    const titleFilteredCount = diagnostics.filter(d => d.status === "title_filtered").length;

    // Exclude session-cached and title-filtered from the total when calculating success rate
    // (they're not failures, just pre-filtered URLs)
    const relevantDiagCount = diagnostics.length - sessionCachedCount - titleFilteredCount;

    // No results at all (but don't count session-cached as failures)
    if (successCount === 0 && relevantDiagCount > 0) {
        suggestions.push("NO RESULTS EXTRACTED. Your query may be too vague or not match the content.");
        suggestions.push("Try a more specific query with exact library names, function names, or error messages.");
        suggestions.push(`Current query tokens: [${queryTokens.join(", ")}] - ensure these terms appear in documentation you're looking for.`);
        if (blockedJsCount > 0) {
            suggestions.push(`${blockedJsCount} result(s) from Stack Overflow/GitHub were skipped (JavaScript-rendered sites not supported).`);
        }
        return suggestions;
    }

    // Low success rate (exclude session-cached from denominator)
    if (relevantDiagCount > 0 && successCount < relevantDiagCount / 2) {
        suggestions.push(`Only ${successCount}/${relevantDiagCount} pages had relevant content.`);
    }

    // Many pages not relevant - query might be too vague
    if (notRelevantPages.length >= 2) {
        const avgCoverage = notRelevantPages.reduce((sum, p) => sum + (p.metrics?.queryTermCoverage ?? 0), 0) / notRelevantPages.length;
        if (avgCoverage < 0.3) {
            suggestions.push("Query terms not found on many pages. Try adding the exact library/framework name (e.g., 'React', 'Next.js', 'Express').");
        } else {
            suggestions.push("Pages contained some query terms but lacked focused content. Try adding method names or error codes.");
        }
    }

    // Many pages couldn't be scraped
    if (scrapeFailedCount >= 2) {
        suggestions.push("Multiple pages failed to load. This is normal for paywalled or bot-protected sites.");
    }

    // Many pages had no content
    if (noContentCount >= 2) {
        suggestions.push("Multiple pages had no extractable content. These may require login or have unusual page structures.");
    }

    // Budget exceeded - results were truncated
    if (budgetExceededCount > 0) {
        suggestions.push(`${budgetExceededCount} additional page(s) had content but were omitted due to output size limits.`);
    }

    // Note about blocked JS sites (only if there were some and we got results)
    if (blockedJsCount > 0) {
        suggestions.push(`${blockedJsCount} result(s) from Stack Overflow/GitHub were skipped (JavaScript-rendered).`);
    }

    // Note about low quality pages (metadata, fragments, etc.)
    if (lowQualityCount > 0) {
        suggestions.push(`${lowQualityCount} page(s) had low quality content (mostly metadata or fragments).`);
    }

    // Note about session-cached URLs
    if (sessionCachedCount > 0) {
        suggestions.push(`${sessionCachedCount} page(s) were skipped (already fetched earlier in this session).`);
    }

    // Note about title-filtered URLs (low pre-scrape relevance)
    if (titleFilteredCount > 0) {
        suggestions.push(`${titleFilteredCount} result(s) were skipped (title/snippet didn't match query terms).`);
    }

    return suggestions;
}

/**
 * Format search results into a readable string
 */
function formatResults(result: SearchResult, includeDiagnostics: boolean): string {
    const lines: string[] = [];

    // Terse status line with session info if applicable
    let statusLine = `${result.successfulPages}/${result.totalPages} pages matched.`;
    if (result.sessionSkippedCount && result.sessionSkippedCount > 0) {
        statusLine += ` (${result.sessionSkippedCount} already returned in this session)`;
    }
    lines.push(statusLine);

    for (const page of result.pages) {
        if (page.excerpts.length === 0) continue;

        // Markdown link combines title + URL
        lines.push(`\n---\n\n## [${page.title}](${page.url})`);

        for (const excerpt of page.excerpts) {
            if (excerpt.headingPath.length > 0) {
                // Blockquote for heading path - lighter than ### heading
                lines.push(`> ${excerpt.headingPath.join(" > ")}`);
            }
            lines.push(excerpt.text);
        }
    }

    // Determine if we should show failure messaging
    const hasExcerpts = result.pages.some(p => p.excerpts.length > 0);
    const hasSessionCached = (result.sessionSkippedCount ?? 0) > 0;
    const showFailureInfo = !hasExcerpts && !hasSessionCached;

    if (showFailureInfo) {
        lines.push("\nNo relevant content extracted.");
    }

    if (includeDiagnostics) {
        lines.push("\n---\n\n## Diagnostics");
        lines.push(`Tokens: [${result.queryTokens.join(", ")}]\n`);
        for (const diag of result.diagnostics) {
            lines.push(formatPageStatus(diag));
        }
        const suggestions = generateSuggestions(result.diagnostics, result.queryTokens);
        if (suggestions.length > 0) {
            lines.push("\n**Tips:**");
            for (const suggestion of suggestions) {
                lines.push(`- ${suggestion}`);
            }
        }
    }

    return lines.join("\n");
}

export interface SearchOptions extends SearchConfig {
    debug?: boolean;
    /** Include diagnostic information about page extraction results */
    diagnostics?: boolean;
}

/**
 * Main search function: orchestrates the full pipeline
 */
export async function search(
    query: string,
    config: SearchOptions = {}
): Promise<string> {
    const debug = config.debug ?? false;
    const includeDiagnostics = config.diagnostics ?? false;

    // Parse site: notation - keep it for SearXNG, remove for extraction
    const { searchQuery, extractionQuery } = parseSearchOperators(query);

    // Merge config with defaults (sessionKey is optional, not required)
    const cfg = {
        searxngUrl: config.searxngUrl ?? DEFAULT_CONFIG.searxngUrl,
        maxResults: config.maxResults ?? DEFAULT_CONFIG.maxResults,
        timeout: config.timeout ?? DEFAULT_CONFIG.timeout,
        perPageCharBudget: config.perPageCharBudget ?? DEFAULT_CONFIG.perPageCharBudget,
        totalCharBudget: config.totalCharBudget ?? DEFAULT_CONFIG.totalCharBudget,
        sessionKey: config.sessionKey,
    };

    // Step 1: Search SearXNG (use full query with site: notation)
    // Request extra results to compensate for blocked JS-rendered domains
    const requestMultiplier = 2; // Request 2x to account for ~50% blocked domains
    let searchResults: SearxngResult[];
    try {
        searchResults = await logger.timeAsync("MCP: SearXNG search", async () => searchSearxng(searchQuery, {
            baseUrl: cfg.searxngUrl,
            maxResults: cfg.maxResults * requestMultiplier,
            timeout: cfg.timeout,
        }));
    } catch (error) {
        return `Error searching SearXNG: ${error instanceof Error ? error.message : "Unknown error"}`;
    }

    if (searchResults.length === 0) {
        return `No search results found for: "${query}"`;
    }

    // Step 1b: Deduplicate URLs (removes version duplicates like /v1/ vs /v2/)
    const deduplicatedResults = deduplicateUrls(searchResults);
    logger.debug(`Deduplicated ${searchResults.length} URLs to ${deduplicatedResults.length}`, debug);

    // Sort by score descending for deterministic processing order (best first)
    deduplicatedResults.sort((a, b) => {
        const scoreDiff = b.score - a.score;
        if (scoreDiff !== 0) return scoreDiff;
        return a.url.localeCompare(b.url);
    });

    // Step 1c: Filter out blocked JS-rendered domains
    const blockedResults: SearxngResult[] = [];
    const scrapableResults: SearxngResult[] = [];

    for (const result of deduplicatedResults) {
        if (isBlockedDomain(result.url)) {
            blockedResults.push(result);
        } else {
            scrapableResults.push(result);
        }
    }

    // Step 1d: Filter by pre-scrape title/snippet relevance
    // Tokenize query once for reuse
    const queryTokens = tokenize(extractionQuery);
    const titleFilteredResults: SearxngResult[] = [];
    const relevantResults: SearxngResult[] = [];

    for (const result of scrapableResults) {
        const relevance = computePreScrapeRelevance(result, queryTokens);
        if (relevance >= MIN_PRESCRAPE_RELEVANCE) {
            relevantResults.push(result);
        } else {
            titleFilteredResults.push(result);
            logger.debug(`Title-filtered [relevance=${(relevance * 100).toFixed(0)}%]: ${result.title}`, debug);
        }
    }

    logger.debug(`Pre-scrape filter: ${relevantResults.length} passed, ${titleFilteredResults.length} filtered`, debug);

    // Limit relevant results to maxResults
    let resultsToScrape = relevantResults.slice(0, cfg.maxResults);

    // Step 1e: Filter out URLs already fetched in this session for the same query
    let sessionSkippedResults: SearxngResult[] = [];
    if (cfg.sessionKey) {
        const urlsToCheck = resultsToScrape.map(r => r.url);
        const { newUrls, skippedUrls } = filterSessionUrls(cfg.sessionKey, urlsToCheck, queryTokens);

        if (skippedUrls.length > 0) {
            // Separate skipped from new
            const skippedSet = new Set(skippedUrls);
            sessionSkippedResults = resultsToScrape.filter(r => skippedSet.has(r.url));
            resultsToScrape = resultsToScrape.filter(r => !skippedSet.has(r.url));

            logger.debug(`Session '${cfg.sessionKey}': skipped ${skippedUrls.length} already-fetched URLs`, debug);
        }
    }

    // Debug: log filtering results
    logger.debug(`SearXNG returned ${searchResults.length} URLs, ${blockedResults.length} blocked, ${titleFilteredResults.length} title-filtered, ${sessionSkippedResults.length} session-cached, ${resultsToScrape.length} to scrape:`, debug);
    for (let i = 0; i < resultsToScrape.length; i++) {
        const r = resultsToScrape[i];
        if (r) {
            logger.debug(`  ${i + 1}. [score=${r.score.toFixed(2)}] ${r.url}`, debug);
        }
    }
    if (blockedResults.length > 0) {
        logger.debug(`Blocked domains:`, debug);
        for (const r of blockedResults) {
            logger.debug(`  - ${r.url}`, debug);
        }
    }

    // Step 2: Scrape pages in parallel (only non-blocked URLs)
    const urls = resultsToScrape.map(r => r.url);
    const scrapeResults = await logger.timeAsync("MCP: Scrape pages", async () => scrapeUrls(urls, { timeout: cfg.timeout }));

    // Build URL to search result mapping
    const searchResultMap = new Map<string, SearxngResult>();
    for (const sr of resultsToScrape) {
        searchResultMap.set(sr.url, sr);
    }

    // Step 3: Extract excerpts from each page and collect diagnostics
    const diagnostics: PageDiagnostics[] = [];

    // Add diagnostics for blocked domains (only include first few to keep output manageable)
    const blockedToShow = blockedResults.slice(0, 3);
    for (const blocked of blockedToShow) {
        diagnostics.push({
            url: blocked.url,
            title: blocked.title,
            status: "blocked_js" as PageStatus,
        });
    }

    // Add diagnostics for session-skipped URLs
    for (const skipped of sessionSkippedResults) {
        diagnostics.push({
            url: skipped.url,
            title: skipped.title,
            status: "session_cached" as PageStatus,
        });
    }

    // Add diagnostics for title-filtered URLs (low pre-scrape relevance)
    const titleFilteredToShow = titleFilteredResults.slice(0, 5);
    for (const filtered of titleFilteredToShow) {
        const relevance = computePreScrapeRelevance(filtered, queryTokens);
        diagnostics.push({
            url: filtered.url,
            title: filtered.title,
            status: "title_filtered" as PageStatus,
            metrics: {
                sentenceCount: 0,
                queryTermCoverage: relevance,
                maxBm25: 0,
                maxCooccurrence: 0,
            },
        });
    }

    const pageExtractions: PageExtraction[] = [];

    const extractionStart = performance.now();
    for (const scrape of scrapeResults) {
        const searchResultInfo = searchResultMap.get(scrape.url);
        const title = searchResultInfo?.title ?? scrape.url;

        if (scrape.html === null) {
            // Scrape failed
            const diagEntry: PageDiagnostics = {
                url: scrape.url,
                title,
                status: "scrape_failed" as PageStatus,
            };
            if (scrape.error !== undefined) {
                diagEntry.error = scrape.error;
            }
            diagnostics.push(diagEntry);

            const extraction: PageExtraction = {
                url: scrape.url,
                title,
                excerpts: [],
                totalChars: 0,
            };
            if (scrape.error !== undefined) {
                extraction.error = scrape.error;
            }
            pageExtractions.push(extraction);
            continue;
        }

        const result = processPage(
            scrape.url,
            scrape.html,
            extractionQuery,
            cfg.perPageCharBudget,
            searchResultInfo
        );

        pageExtractions.push(result.extraction);

        if (result.extraction.excerpts.length === 0) {
            // No excerpts - determine why
            const metrics = result.relevanceMetrics;
            let status: PageStatus;
            if (metrics?.qualityRejectReason) {
                status = "low_quality";
            } else if (metrics && metrics.hasRelevantResults === false) {
                status = "not_relevant";
            } else if (metrics && metrics.sentenceCount === 0) {
                status = "no_content";
            } else {
                status = "no_content";
            }

            const diagEntry: PageDiagnostics = {
                url: scrape.url,
                title: result.extraction.title,
                status,
            };
            if (metrics?.qualityRejectReason) {
                diagEntry.error = metrics.qualityRejectReason;
            }
            if (metrics) {
                diagEntry.metrics = {
                    sentenceCount: metrics.sentenceCount,
                    queryTermCoverage: metrics.queryTermCoverage,
                    maxBm25: metrics.maxBm25,
                    maxCooccurrence: metrics.maxCooccurrence,
                };
            }
            diagnostics.push(diagEntry);
        } else {
            // Success
            diagnostics.push({
                url: scrape.url,
                title: result.extraction.title,
                status: "success" as PageStatus,
                excerptCount: result.extraction.excerpts.length,
                charCount: result.extraction.totalChars,
            });
        }
    }
    // Record extraction timing
    const extractionDuration = performance.now() - extractionStart;
    logger.recordTiming(`MCP: Extract excerpts (${scrapeResults.length} pages)`, extractionDuration);

    // Step 4: Compute relevance scores and sort
    const rankingStart = performance.now();
    // queryTokens already computed in Step 1d for pre-scrape filtering
    const successfulPages = pageExtractions.filter(p => p.excerpts.length > 0);

    // Compute relevance for each page
    const pagesWithRelevance = successfulPages.map(page => {
        const searxngScore = searchResultMap.get(page.url)?.score ?? 0;
        const relevance = computePageRelevance(page, queryTokens, searxngScore);
        return { page, relevance };
    });

    // Sort by relevance score; tie-break by URL for deterministic order
    pagesWithRelevance.sort((a, b) => {
        const d = b.relevance - a.relevance;
        if (d !== 0) return d;
        return a.page.url.localeCompare(b.page.url);
    });

    // Trim to total character budget
    let totalChars = 0;
    const budgetedPages: PageExtraction[] = [];
    const includedUrls = new Set<string>();

    for (const { page } of pagesWithRelevance) {
        if (totalChars + page.totalChars > cfg.totalCharBudget) {
            // Try to include partial excerpts
            const remainingBudget = cfg.totalCharBudget - totalChars;
            if (remainingBudget > 200) {
                let pageChars = 0;
                const trimmedExcerpts = [];

                for (const excerpt of page.excerpts) {
                    const excerptChars = excerpt.text.length;
                    if (pageChars + excerptChars <= remainingBudget) {
                        trimmedExcerpts.push(excerpt);
                        pageChars += excerptChars;
                    }
                }

                if (trimmedExcerpts.length > 0) {
                    budgetedPages.push({
                        ...page,
                        excerpts: trimmedExcerpts,
                        totalChars: pageChars,
                    });
                    includedUrls.add(page.url);
                    totalChars += pageChars;
                }
            }
            break;
        }

        budgetedPages.push(page);
        includedUrls.add(page.url);
        totalChars += page.totalChars;
    }

    // Update diagnostics for pages excluded due to budget
    for (const { page } of pagesWithRelevance) {
        if (!includedUrls.has(page.url)) {
            // Find and update the diagnostic for this page
            const diagIndex = diagnostics.findIndex(d => d.url === page.url);
            if (diagIndex !== -1) {
                diagnostics[diagIndex] = {
                    url: page.url,
                    title: page.title,
                    status: "budget_exceeded" as PageStatus,
                    excerptCount: page.excerpts.length,
                    charCount: page.totalChars,
                };
            }
        }
    }
    logger.recordTiming("MCP: Rank and budget pages", performance.now() - rankingStart);

    // Step 5: Add successfully scraped URLs to session cache for future deduplication
    if (cfg.sessionKey) {
        // Add all URLs we attempted to scrape (not just successful ones)
        // This prevents re-scraping failed URLs too
        const scrapedUrls = resultsToScrape.map(r => r.url);
        addUrlsToSession(cfg.sessionKey, scrapedUrls, queryTokens);
        logger.debug(`Session '${cfg.sessionKey}': cached ${scrapedUrls.length} URL+query keys for future deduplication`, debug);
    }

    // Step 6: Format results
    const result: SearchResult = {
        query,
        pages: budgetedPages,
        totalPages: resultsToScrape.length, // Pages we actually attempted to scrape
        successfulPages: budgetedPages.length,
        totalChars,
        diagnostics,
        queryTokens,
        ...(sessionSkippedResults.length > 0 && { sessionSkippedCount: sessionSkippedResults.length }),
    };

    const formatted = logger.time("MCP: Format results", () => formatResults(result, includeDiagnostics));

    // Print timing summary if enabled
    logger.printTimings();

    return formatted;
}

/**
 * Default character budget for single page fetch
 * Higher than per-page search budget since user committed to this specific page
 */
const FETCH_PAGE_CHAR_BUDGET = 12000;

/**
 * Options for fetchPage
 */
export interface FetchPageOptions {
    /** Optional query to focus extraction (if omitted, returns full cleaned content) */
    query?: string;
    /** Character budget for output (default: 8000) */
    charBudget?: number;
    /** Request timeout in ms (default: 10000) */
    timeout?: number;
}

/**
 * Assemble blocks into readable markdown-like format
 * Preserves heading hierarchy and code blocks
 */
function assembleBlocksAsContent(blocks: Block[], charBudget: number): string {
    const lines: string[] = [];
    let totalChars = 0;
    let lastHeadingLevel = 0;

    for (const block of blocks) {
        // Check if we'd exceed budget
        const blockLen = block.text.length + 10; // +10 for formatting overhead
        if (totalChars + blockLen > charBudget) {
            // Try to include at least partial content
            const remaining = charBudget - totalChars;
            if (remaining > 100 && block.type === "p") {
                // Truncate paragraph
                lines.push(block.text.slice(0, remaining - 3) + "...");
                totalChars += remaining;
            }
            break;
        }

        // Format based on block type
        if (/^h([1-6])$/.test(block.type)) {
            const levelMatch = block.type.match(/^h([1-6])$/);
            const level = levelMatch?.[1] ? parseInt(levelMatch[1], 10) : 1;
            lastHeadingLevel = level;

            // Add blank line before headings (except at start)
            if (lines.length > 0) {
                lines.push("");
            }

            // Use markdown heading syntax
            const prefix = "#".repeat(level);
            lines.push(`${prefix} ${block.text}`);
            totalChars += block.text.length + level + 2;
        } else if (block.type === "pre") {
            // Code block
            lines.push("```");
            lines.push(block.text);
            lines.push("```");
            totalChars += block.text.length + 8;
        } else if (block.type === "li") {
            // List item
            lines.push(`- ${block.text}`);
            totalChars += block.text.length + 2;
        } else {
            // Paragraph
            lines.push(block.text);
            totalChars += block.text.length;
        }
    }

    return lines.join("\n");
}

/**
 * Fetch a single page and return its content
 * - With query: returns focused excerpts (like search results)
 * - Without query: returns full cleaned content with structure preserved
 */
export async function fetchPage(
    url: string,
    options: FetchPageOptions = {}
): Promise<string> {
    const {
        query,
        charBudget = FETCH_PAGE_CHAR_BUDGET,
        timeout = 10000,
    } = options;

    // Fetch the page
    const scrapeResults = await scrapeUrls([url], { timeout });
    const scrapeResult = scrapeResults[0];

    if (!scrapeResult || scrapeResult.html === null) {
        const error = scrapeResult?.error ?? "Failed to fetch page";
        return `Error fetching ${url}: ${error}`;
    }

    const html = scrapeResult.html;

    // Extract title
    const title = extractTitle(html) || getDomain(url);

    // If query provided, use the full extraction pipeline
    // Use "search" mode (looser) since user already selected this specific page
    // Use same expand config as web_search for consistency
    if (query) {
        const result = extractExcerpts(html, query, {
            ranker: { relevanceMode: "search" },
            anchors: { maxAnchors: 10 },
            expand: {
                maxChunkChars: 3000,
                contextAfter: 15,
                contextBefore: 10,
            },
            excerpts: { charBudget, maxExcerpts: 15 },
        });

        if (result.excerpts.length === 0) {
            return `# ${title}\nSource: ${url}\n\nNo relevant content found for query "${query}".`;
        }

        // Format like search results but for single page
        const lines: string[] = [];
        lines.push(`# ${title}`);
        lines.push(`Source: ${url}\n`);

        for (const excerpt of result.excerpts) {
            if (excerpt.headingPath.length > 0) {
                lines.push(`> ${excerpt.headingPath.join(" > ")}`);
            }
            lines.push(excerpt.text);
            lines.push("");
        }

        return lines.join("\n").trim();
    }

    // No query - return full cleaned content
    const { $, mainContent, selector } = preprocessHtml(html);

    if (!mainContent) {
        return `# ${title}\nSource: ${url}\n\nCould not extract main content from page.`;
    }

    // Extract blocks from main content
    const blocks = extractBlocks($, mainContent, { skipNav: true });

    if (blocks.length === 0) {
        return `# ${title}\nSource: ${url}\n\nNo content blocks found on page.`;
    }

    // Assemble into readable format
    const content = assembleBlocksAsContent(blocks, charBudget);

    const lines: string[] = [];
    lines.push(`# ${title}`);
    lines.push(`Source: ${url}\n`);
    lines.push(content);

    return lines.join("\n").trim();
}
