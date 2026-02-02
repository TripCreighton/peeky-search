/**
 * Parse search operators/dorks from queries
 * Separates search engine operators from extraction keywords
 */

export interface ParsedQuery {
    /** Full query with all operators - sent to SearXNG */
    searchQuery: string;
    /** Cleaned query without operators - used for excerpt extraction */
    extractionQuery: string;
}

/**
 * Supported operators:
 * - site:domain.com - limit to specific domain
 * - "exact phrase" - exact match (quotes removed for extraction)
 * - -term - exclude term (removed from extraction)
 * - filetype:pdf - file type filter (removed from extraction)
 */
export function parseSearchOperators(query: string): ParsedQuery {
    let extractionQuery = query;

    // Remove site:domain.com
    extractionQuery = extractionQuery.replace(/\bsite:[\w.-]+/gi, "");

    // Remove -excluded terms (handles both start of string and mid-string)
    extractionQuery = extractionQuery.replace(/(^|\s)-\w+/g, " ");

    // Remove filetype:xxx
    extractionQuery = extractionQuery.replace(/\bfiletype:\w+/gi, "");

    // Remove quotes but keep the phrase content
    extractionQuery = extractionQuery.replace(/"([^"]+)"/g, "$1");

    // Clean up whitespace
    extractionQuery = extractionQuery.replace(/\s+/g, " ").trim();

    return {
        searchQuery: query,
        extractionQuery,
    };
}
