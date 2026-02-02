import { stemmer } from "stemmer";
import type { TermFrequencyMap } from "../types";

// Common English stop words to filter out
const STOP_WORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
    "has", "he", "in", "is", "it", "its", "of", "on", "that", "the",
    "to", "was", "were", "will", "with", "this", "but", "they",
    "have", "had", "what", "when", "where", "who", "which", "why", "how",
    "all", "each", "every", "both", "few", "more", "most", "other", "some",
    "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too",
    "very", "can", "just", "should", "now", "or", "if", "then", "else",
    "been", "being", "do", "does", "did", "doing", "would", "could", "might",
    "must", "shall", "may", "about", "above", "after", "again", "against",
    "below", "between", "into", "through", "during", "before", "under",
    "over", "out", "up", "down", "off", "once", "here", "there", "any",
    "your", "you", "we", "our", "us", "i", "me", "my", "myself", "him",
    "her", "them", "their", "his", "she", "itself",
]);

/**
 * Split camelCase and PascalCase into separate words
 * e.g., "createOrganizationInvitation" → "create Organization Invitation"
 */
function splitCamelCase(text: string): string {
    return text
        // Insert space before uppercase letters that follow lowercase
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        // Insert space before uppercase letters followed by lowercase (for acronyms)
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

/**
 * Normalize text: split camelCase, lowercase, remove punctuation
 */
export function normalizeText(text: string): string {
    return splitCamelCase(text)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ") // Remove non-alphanumeric (Unicode-aware)
        .replace(/\s+/g, " ")
        .trim();
}


/**
 * Tokenize text into normalized tokens
 * @param text - Input text
 * @param options - Tokenization options
 */
export function tokenize(
    text: string,
    options: {
        removeStopWords?: boolean;
        applyStemming?: boolean;
        minLength?: number;
    } = {}
): string[] {
    const {
        removeStopWords = true,
        applyStemming = true,
        minLength = 2,
    } = options;

    const normalized = normalizeText(text);
    let tokens = normalized.split(/\s+/).filter(t => t.length >= minLength);

    if (removeStopWords) {
        tokens = tokens.filter(t => !STOP_WORDS.has(t));
    }

    if (applyStemming) {
        tokens = tokens.map(stemmer);
    }

    return tokens;
}

/**
 * Build a term frequency map from tokens
 */
export function buildTermFrequencyMap(tokens: string[]): TermFrequencyMap {
    const tf: TermFrequencyMap = {};
    for (const token of tokens) {
        tf[token] = (tf[token] ?? 0) + 1;
    }
    return tf;
}

/**
 * Get unique terms from tokens
 */
export function getUniqueTerms(tokens: string[]): Set<string> {
    return new Set(tokens);
}

/**
 * Calculate Jaccard similarity between two token sets
 */
export function jaccardSimilarity(tokensA: string[], tokensB: string[]): number {
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);

    let intersection = 0;
    for (const token of setA) {
        if (setB.has(token)) {
            intersection++;
        }
    }

    const union = setA.size + setB.size - intersection;
    if (union === 0) return 0;

    return intersection / union;
}

/**
 * Calculate term overlap ratio (how much of A is in B)
 */
export function termOverlapRatio(tokensA: string[], tokensB: string[]): number {
    if (tokensA.length === 0) return 0;

    const setB = new Set(tokensB);
    let overlap = 0;
    for (const token of tokensA) {
        if (setB.has(token)) {
            overlap++;
        }
    }

    return overlap / tokensA.length;
}
