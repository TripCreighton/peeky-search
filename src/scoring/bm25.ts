import type { DocumentStats, Sentence, TermFrequencyMap } from "../types";
import { buildTermFrequencyMap } from "../preprocessing/tokenize";

// BM25 parameters
const DEFAULT_K1 = 1.5; // Term frequency saturation parameter
const DEFAULT_B = 0.75; // Length normalization parameter

export interface BM25Config {
    k1?: number;
    b?: number;
}

export interface BM25Scorer {
    score: (queryTokens: string[], docTokens: string[]) => number;
    scoreWithTf: (queryTokens: string[], docTf: TermFrequencyMap, docLength: number) => number;
    getIdf: (term: string) => number;
    stats: DocumentStats;
}

/**
 * Compute document statistics for IDF calculation
 */
export function computeDocumentStats(sentences: Sentence[]): DocumentStats {
    const docFrequency: TermFrequencyMap = {};
    let totalLength = 0;

    for (const sentence of sentences) {
        // Count unique terms per document (sentence)
        const uniqueTerms = new Set(sentence.tokens);
        for (const term of uniqueTerms) {
            docFrequency[term] = (docFrequency[term] ?? 0) + 1;
        }
        totalLength += sentence.tokens.length;
    }

    return {
        totalDocs: sentences.length,
        avgDocLength: sentences.length > 0 ? totalLength / sentences.length : 0,
        docFrequency,
    };
}

/**
 * Calculate IDF (Inverse Document Frequency) for a term
 * Using the BM25 variant: log((N - df + 0.5) / (df + 0.5) + 1)
 */
export function calculateIdf(term: string, stats: DocumentStats): number {
    const df = stats.docFrequency[term] ?? 0;
    const N = stats.totalDocs;

    if (df === 0) {
        // Term not in corpus - give it a small positive IDF
        return Math.log((N + 0.5) / 0.5 + 1);
    }

    // Standard BM25 IDF formula
    return Math.log((N - df + 0.5) / (df + 0.5) + 1);
}

/**
 * Create a BM25 scorer for a corpus of sentences
 */
export function createBM25Scorer(
    sentences: Sentence[],
    config: BM25Config = {}
): BM25Scorer {
    const { k1 = DEFAULT_K1, b = DEFAULT_B } = config;
    const stats = computeDocumentStats(sentences);

    /**
     * Get IDF for a term
     */
    function getIdf(term: string): number {
        return calculateIdf(term, stats);
    }

    /**
     * Score a document against a query using pre-computed term frequency
     */
    function scoreWithTf(
        queryTokens: string[],
        docTf: TermFrequencyMap,
        docLength: number
    ): number {
        let score = 0;

        for (const term of queryTokens) {
            const tf = docTf[term] ?? 0;
            if (tf === 0) continue;

            const idf = getIdf(term);

            // BM25 term score
            const numerator = tf * (k1 + 1);
            const denominator = tf + k1 * (1 - b + b * (docLength / stats.avgDocLength));
            const termScore = idf * (numerator / denominator);

            score += termScore;
        }

        return score;
    }

    /**
     * Score a document against a query
     */
    function score(queryTokens: string[], docTokens: string[]): number {
        const docTf = buildTermFrequencyMap(docTokens);
        return scoreWithTf(queryTokens, docTf, docTokens.length);
    }

    return {
        score,
        scoreWithTf,
        getIdf,
        stats,
    };
}

/**
 * Score all sentences against a query
 */
export function scoreSentences(
    sentences: Sentence[],
    queryTokens: string[],
    config: BM25Config = {}
): Map<number, number> {
    const scorer = createBM25Scorer(sentences, config);
    const scores = new Map<number, number>();

    for (const sentence of sentences) {
        const docTf = buildTermFrequencyMap(sentence.tokens);
        const bm25Score = scorer.scoreWithTf(queryTokens, docTf, sentence.tokens.length);
        scores.set(sentence.globalIndex, bm25Score);
    }

    return scores;
}
