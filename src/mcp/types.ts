/**
 * MCP-specific type definitions
 */

export type PageStatus =
    | "success"           // Excerpts extracted
    | "scrape_failed"     // HTTP error, timeout, non-HTML
    | "no_content"        // No main content detected
    | "not_relevant"      // Failed relevance check
    | "low_quality"       // Failed document quality check (too many fragments, etc.)
    | "budget_exceeded"   // Dropped due to budget
    | "blocked_js"        // Known JS-rendered domain, skipped
    | "session_cached"    // Already fetched in this session
    | "title_filtered";   // Filtered pre-scrape due to low title/snippet relevance

export interface PageDiagnostics {
    url: string;
    title: string;
    status: PageStatus;
    error?: string;              // For scrape_failed
    excerptCount?: number;       // For success
    charCount?: number;          // For success
    metrics?: {                  // For not_relevant
        sentenceCount: number;
        queryTermCoverage: number;
        maxBm25: number;
        maxCooccurrence: number;
    };
}

export interface SearchConfig {
    /** SearXNG instance URL */
    searxngUrl?: string;
    /** Maximum number of pages to scrape */
    maxResults?: number;
    /** Timeout in ms for scraping each page */
    timeout?: number;
    /** Character budget per page for excerpts */
    perPageCharBudget?: number;
    /** Total character budget for all results */
    totalCharBudget?: number;
    /** Session key for cross-call URL deduplication */
    sessionKey?: string;
}

export interface SearxngResult {
    url: string;
    title: string;
    content: string;
    score: number;
    engine: string;
}

export interface SearxngResponse {
    results: Array<{
        url: string;
        title: string;
        content: string;
        score?: number;
        engine: string;
    }>;
    query: string;
    number_of_results: number;
}

export interface ScrapeResult {
    url: string;
    html: string | null;
    error?: string;
}

export interface PageExtraction {
    url: string;
    title: string;
    excerpts: Array<{
        text: string;
        headingPath: string[];
        score: number;
    }>;
    totalChars: number;
    error?: string;
}

export interface SearchResult {
    query: string;
    pages: PageExtraction[];
    totalPages: number;
    successfulPages: number;
    totalChars: number;
    diagnostics: PageDiagnostics[];
    queryTokens: string[];
    sessionSkippedCount?: number;
}

export const DEFAULT_CONFIG: Required<Omit<SearchConfig, "sessionKey">> = {
    searxngUrl: "http://localhost:8888",
    maxResults: 5,
    timeout: 5000,
    perPageCharBudget: 3000,  // Increased for docs pages
    totalCharBudget: 12000,   // Increased to accommodate larger excerpts
};
