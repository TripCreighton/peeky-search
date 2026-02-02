import type { ScoredSentence } from "../types";
import { jaccardSimilarity } from "../preprocessing/tokenize";

export interface AnchorConfig {
    maxAnchors?: number;
    minScore?: number;
    diversityThreshold?: number;
}

/** Minimum global index gap between anchors for position diversity */
const DEFAULT_MIN_POSITION_GAP = 3;

const DEFAULT_CONFIG: Required<AnchorConfig> = {
    maxAnchors: 5,
    minScore: 0.1,
    diversityThreshold: 0.5,
};

/**
 * Check if a sentence is too similar to any existing anchor
 * Used by both anchor selection functions
 */
function isTooSimilarToAnchors(
    sentence: ScoredSentence,
    anchors: ScoredSentence[],
    diversityThreshold: number,
    minPositionGap?: number
): boolean {
    for (const anchor of anchors) {
        const similarity = jaccardSimilarity(sentence.tokens, anchor.tokens);
        if (similarity > diversityThreshold) {
            return true;
        }

        if (minPositionGap !== undefined) {
            const positionGap = Math.abs(sentence.globalIndex - anchor.globalIndex);
            if (positionGap < minPositionGap) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Core anchor selection logic shared by both selection functions
 */
function selectAnchorsCore(
    rankedSentences: ScoredSentence[],
    maxAnchors: number,
    minScore: number,
    diversityThreshold: number,
    minPositionGap?: number
): ScoredSentence[] {
    const anchors: ScoredSentence[] = [];

    for (const sentence of rankedSentences) {
        if (sentence.combinedScore < minScore) {
            continue;
        }

        if (!isTooSimilarToAnchors(sentence, anchors, diversityThreshold, minPositionGap)) {
            anchors.push(sentence);
            if (anchors.length >= maxAnchors) {
                break;
            }
        }
    }

    return anchors;
}

/**
 * Select top-K anchor sentences with diversity filtering
 * Anchors are high-scoring sentences that will serve as the center of excerpts
 */
export function selectAnchors(
    rankedSentences: ScoredSentence[],
    config: AnchorConfig = {}
): ScoredSentence[] {
    const {
        maxAnchors = DEFAULT_CONFIG.maxAnchors,
        minScore = DEFAULT_CONFIG.minScore,
        diversityThreshold = DEFAULT_CONFIG.diversityThreshold,
    } = config;

    return selectAnchorsCore(rankedSentences, maxAnchors, minScore, diversityThreshold);
}

/**
 * Select anchors with position diversity
 * Ensures anchors are spread across different parts of the document
 */
export function selectAnchorsWithPositionDiversity(
    rankedSentences: ScoredSentence[],
    config: AnchorConfig & { minPositionGap?: number } = {}
): ScoredSentence[] {
    const {
        maxAnchors = DEFAULT_CONFIG.maxAnchors,
        minScore = DEFAULT_CONFIG.minScore,
        diversityThreshold = DEFAULT_CONFIG.diversityThreshold,
        minPositionGap = DEFAULT_MIN_POSITION_GAP,
    } = config;

    return selectAnchorsCore(rankedSentences, maxAnchors, minScore, diversityThreshold, minPositionGap);
}
