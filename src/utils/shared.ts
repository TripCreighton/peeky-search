/**
 * Shared utility functions used across the codebase
 */

// =============================================================================
// Heading utilities
// =============================================================================

/** Regex pattern to match heading block types (h1-h6) */
export const HEADING_PATTERN = /^h[1-6]$/;

/** Type guard to check if a tag name is a heading */
export function isHeadingTag(tag: string): boolean {
    return HEADING_PATTERN.test(tag);
}

/** Extract heading level (1-6) from a heading tag name, returns null if not a heading */
export function getHeadingLevel(tag: string): number | null {
    if (!isHeadingTag(tag)) return null;
    const levelChar = tag[1];
    return levelChar !== undefined ? parseInt(levelChar, 10) : null;
}

// =============================================================================
// Math utilities
// =============================================================================

/**
 * Calculate median of an array of numbers
 * Returns 0 for empty arrays
 */
export function calculateMedian(values: number[]): number {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        const left = sorted[mid - 1];
        const right = sorted[mid];
        if (left !== undefined && right !== undefined) {
            return (left + right) / 2;
        }
        return 0;
    }

    return sorted[mid] ?? 0;
}

// =============================================================================
// String utilities
// =============================================================================

/**
 * Normalize whitespace in text: collapse multiple spaces to single, trim
 */
export function normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/**
 * Truncate text to maxLen characters, adding ellipsis if truncated
 */
export function truncateText(text: string, maxLen: number = 100): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + "...";
}

// =============================================================================
// Sorting utilities
// =============================================================================

/**
 * Interface for items that can be sorted by score with deterministic tie-breaking
 */
export interface Scoreable {
    score: number;
    anchorIndex: number;
}

/**
 * Sort items by score descending with deterministic tie-break by anchorIndex ascending
 * Returns a new sorted array (does not mutate input)
 */
export function sortByScoreDesc<T extends Scoreable>(items: T[]): T[] {
    return [...items].sort((a, b) => {
        const scoreDiff = b.score - a.score;
        if (scoreDiff !== 0) return scoreDiff;
        return a.anchorIndex - b.anchorIndex;
    });
}

/**
 * Interface for items that can be sorted by combined score with globalIndex tie-break
 */
export interface ScoredItem {
    combinedScore: number;
    globalIndex: number;
}

/**
 * Sort items by combinedScore descending with deterministic tie-break by globalIndex ascending
 * Returns a new sorted array (does not mutate input)
 */
export function sortByCombinedScoreDesc<T extends ScoredItem>(items: T[]): T[] {
    return [...items].sort((a, b) => {
        const scoreDiff = b.combinedScore - a.combinedScore;
        if (scoreDiff !== 0) return scoreDiff;
        return a.globalIndex - b.globalIndex;
    });
}

// =============================================================================
// Pattern matching utilities
// =============================================================================

/**
 * Check if a combined id/class string matches any of the provided patterns
 */
export function matchesPatterns(combined: string, patterns: RegExp[]): boolean {
    return patterns.some(pattern => pattern.test(combined));
}

// =============================================================================
// IDF-weighted metric utilities
// =============================================================================

/**
 * Compute IDF-weighted overlap between query terms and a token set
 * Returns a value in [0, 1] representing how much of the query's IDF weight is covered
 */
export function computeIdfWeightedOverlap(
    queryTokens: string[],
    tokenSet: Set<string>,
    getIdf: (term: string) => number
): number {
    if (queryTokens.length === 0) return 0;

    let matchedIdfSum = 0;
    let totalIdfSum = 0;

    for (const queryTerm of queryTokens) {
        const idf = getIdf(queryTerm);
        totalIdfSum += idf;
        if (tokenSet.has(queryTerm)) {
            matchedIdfSum += idf;
        }
    }

    if (totalIdfSum === 0) return 0;
    return matchedIdfSum / totalIdfSum;
}
