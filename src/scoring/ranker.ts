import type { Sentence, ScoredSentence } from "../types";
import { createBM25Scorer, type BM25Config } from "./bm25";
import { scoreAllSentencesHeuristics, type HeuristicWeights } from "./heuristics";
import { buildTermFrequencyMap } from "../preprocessing/tokenize";

export interface RankerConfig {
    bm25Weight?: number;
    heuristicWeight?: number;
    bm25Config?: BM25Config;
    heuristicWeights?: HeuristicWeights;
    /** 'strict' for single-doc extraction, 'search' for multi-page search (looser) */
    relevanceMode?: "strict" | "search";
}

export interface RankingResult {
    sentences: ScoredSentence[];
    hasRelevantResults: boolean;
    maxRawBm25: number;
    queryTermCoverage: number;
    maxCooccurrence: number;
}

const DEFAULT_CONFIG: Required<Omit<RankerConfig, "bm25Config" | "heuristicWeights">> = {
    bm25Weight: 0.6,
    heuristicWeight: 0.4,
    relevanceMode: "strict",
};

/**
 * Thresholds for determining relevance in search mode (looser)
 */
const SEARCH_RELEVANCE_THRESHOLDS = {
    strongSentenceBm25: 0.8,      // Was 1.2
    strongSentenceCoverage: 0.25,
    cooccurrenceMinTerms: 2,
    cooccurrenceBm25: 0.5,        // Was 0.8
    centralTermBm25: 0.4,         // Was 0.6
    goodCoverage: 0.5,
    goodCoverageBm25: 0.3,        // Was 0.4
} as const;

/**
 * Thresholds for determining relevance in strict mode (stricter)
 */
const STRICT_RELEVANCE_THRESHOLDS = {
    cooccurrenceMinTerms: 2,
    cooccurrenceBm25: 1.0,
    centralTermBm25: 0.8,
    highCoverage: 0.8,
    highCoverageBm25: 0.5,
} as const;

/**
 * Determine if results are relevant based on mode and metrics
 * Extracted for readability and testability
 */
function checkRelevance(
    mode: "strict" | "search",
    maxBm25: number,
    queryTermCoverage: number,
    maxCooccurrence: number,
    hasCentralTerm: boolean
): boolean {
    if (mode === "search") {
        // Single strong sentence with decent coverage
        if (maxBm25 > SEARCH_RELEVANCE_THRESHOLDS.strongSentenceBm25 &&
            queryTermCoverage >= SEARCH_RELEVANCE_THRESHOLDS.strongSentenceCoverage) {
            return true;
        }
        // Multiple query terms in same sentence
        if (maxCooccurrence >= SEARCH_RELEVANCE_THRESHOLDS.cooccurrenceMinTerms &&
            maxBm25 > SEARCH_RELEVANCE_THRESHOLDS.cooccurrenceBm25) {
            return true;
        }
        // A matching term is central to the document
        if (hasCentralTerm && maxBm25 > SEARCH_RELEVANCE_THRESHOLDS.centralTermBm25) {
            return true;
        }
        // Good coverage
        if (queryTermCoverage >= SEARCH_RELEVANCE_THRESHOLDS.goodCoverage &&
            maxBm25 > SEARCH_RELEVANCE_THRESHOLDS.goodCoverageBm25) {
            return true;
        }
        return false;
    }

    // Strict mode
    // Multiple query terms in same sentence with good BM25
    if (maxCooccurrence >= STRICT_RELEVANCE_THRESHOLDS.cooccurrenceMinTerms &&
        maxBm25 > STRICT_RELEVANCE_THRESHOLDS.cooccurrenceBm25) {
        return true;
    }
    // A matching term is central to the document (topic match)
    if (hasCentralTerm && maxBm25 > STRICT_RELEVANCE_THRESHOLDS.centralTermBm25) {
        return true;
    }
    // Very high coverage
    if (queryTermCoverage >= STRICT_RELEVANCE_THRESHOLDS.highCoverage &&
        maxBm25 > STRICT_RELEVANCE_THRESHOLDS.highCoverageBm25) {
        return true;
    }
    return false;
}

/**
 * Normalize scores to [0, 1] range using min-max normalization
 */
function normalizeScores(scores: Map<number, number>): Map<number, number> {
    if (scores.size === 0) return new Map();

    let min = Infinity;
    let max = -Infinity;

    for (const score of scores.values()) {
        if (score < min) min = score;
        if (score > max) max = score;
    }

    const range = max - min;
    const normalized = new Map<number, number>();

    for (const [id, score] of scores) {
        // If all scores are the same, normalize to 0.5
        normalized.set(id, range === 0 ? 0.5 : (score - min) / range);
    }

    return normalized;
}

/**
 * Rank sentences by combining BM25 and heuristic scores
 * Returns both ranked sentences and relevance metrics
 */
export function rankSentencesWithRelevance(
    sentences: Sentence[],
    queryTokens: string[],
    config: RankerConfig = {}
): RankingResult {
    const {
        bm25Weight = DEFAULT_CONFIG.bm25Weight,
        heuristicWeight = DEFAULT_CONFIG.heuristicWeight,
        bm25Config,
        heuristicWeights,
        relevanceMode = DEFAULT_CONFIG.relevanceMode,
    } = config;

    if (sentences.length === 0 || queryTokens.length === 0) {
        return {
            sentences: sentences.map(s => ({
                ...s,
                bm25Score: 0,
                heuristicScore: 0,
                combinedScore: 0,
            })),
            hasRelevantResults: false,
            maxRawBm25: 0,
            queryTermCoverage: 0,
            maxCooccurrence: 0,
        };
    }

    // Calculate BM25 scores
    const bm25Scorer = createBM25Scorer(sentences, bm25Config);
    const rawBm25Scores = new Map<number, number>();
    let maxRawBm25 = 0;

    for (const sentence of sentences) {
        const docTf = buildTermFrequencyMap(sentence.tokens);
        const score = bm25Scorer.scoreWithTf(queryTokens, docTf, sentence.tokens.length);
        rawBm25Scores.set(sentence.globalIndex, score);
        if (score > maxRawBm25) {
            maxRawBm25 = score;
        }
    }

    // Check query term coverage across all sentences
    const queryTermSet = new Set(queryTokens);
    const foundTerms = new Set<string>();
    for (const sentence of sentences) {
        for (const token of sentence.tokens) {
            if (queryTermSet.has(token)) {
                foundTerms.add(token);
            }
        }
    }
    const queryTermCoverage = queryTokens.length > 0 ? foundTerms.size / queryTokens.length : 0;

    // Check co-occurrence: do multiple query terms appear in the SAME sentence?
    let maxCooccurrence = 0;
    // Also track how many sentences contain each query term (centrality)
    const termSentenceCount = new Map<string, number>();

    for (const sentence of sentences) {
        const uniqueInSentence = new Set<string>();
        for (const token of sentence.tokens) {
            if (queryTermSet.has(token)) {
                uniqueInSentence.add(token);
            }
        }
        if (uniqueInSentence.size > maxCooccurrence) {
            maxCooccurrence = uniqueInSentence.size;
        }
        // Track centrality
        for (const term of uniqueInSentence) {
            termSentenceCount.set(term, (termSentenceCount.get(term) ?? 0) + 1);
        }
    }

    // Check if any matching term is "central" (appears in many sentences)
    // A term appearing in 10%+ of sentences indicates topic relevance
    const centralTermThreshold = Math.max(3, sentences.length * 0.1);
    let hasCentralTerm = false;
    for (const count of termSentenceCount.values()) {
        if (count >= centralTermThreshold) {
            hasCentralTerm = true;
            break;
        }
    }

    // Determine if results are relevant
    const hasRelevantResults = checkRelevance(
        relevanceMode,
        maxRawBm25,
        queryTermCoverage,
        maxCooccurrence,
        hasCentralTerm
    );

    // Calculate heuristic scores
    const heuristicScores = scoreAllSentencesHeuristics(
        sentences,
        queryTokens,
        bm25Scorer.getIdf,
        heuristicWeights
    );

    // Normalize BM25 scores
    const normalizedBm25 = normalizeScores(rawBm25Scores);

    // Build scored sentences
    const scoredSentences: ScoredSentence[] = sentences.map(sentence => {
        const bm25Score = normalizedBm25.get(sentence.globalIndex) ?? 0;
        const heuristics = heuristicScores.get(sentence.globalIndex);
        const heuristicScore = heuristics?.combined ?? 0;

        const combinedScore = bm25Weight * bm25Score + heuristicWeight * heuristicScore;

        return {
            ...sentence,
            bm25Score,
            heuristicScore,
            combinedScore,
        };
    });

    // Sort by combined score descending; tie-break by globalIndex for determinism
    scoredSentences.sort((a, b) => {
        const d = b.combinedScore - a.combinedScore;
        if (d !== 0) return d;
        return a.globalIndex - b.globalIndex;
    });

    return {
        sentences: scoredSentences,
        hasRelevantResults,
        maxRawBm25,
        queryTermCoverage,
        maxCooccurrence,
    };
}

/**
 * Get top-K ranked sentences
 */
export function getTopSentences(
    sentences: Sentence[],
    queryTokens: string[],
    k: number,
    config: RankerConfig = {}
): ScoredSentence[] {
    const result = rankSentencesWithRelevance(sentences, queryTokens, config);
    return result.sentences.slice(0, k);
}
