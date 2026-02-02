import type { Chunk } from "../types";
import { jaccardSimilarity } from "../preprocessing/tokenize";
import { buildChunkText } from "./expand";

export interface DedupeConfig {
    overlapThreshold?: number;
    tokenSimilarityThreshold?: number;
}

const DEFAULT_CONFIG: Required<DedupeConfig> = {
    overlapThreshold: 0.5, // Sentence index overlap ratio to trigger merge
    tokenSimilarityThreshold: 0.72, // Token Jaccard similarity to consider duplicate
};

/**
 * Calculate overlap ratio between two chunks based on sentence indices
 */
function calculateSentenceOverlap(chunkA: Chunk, chunkB: Chunk): number {
    const indicesA = new Set(chunkA.sentences.map(s => s.globalIndex));
    const indicesB = new Set(chunkB.sentences.map(s => s.globalIndex));

    let intersection = 0;
    for (const idx of indicesA) {
        if (indicesB.has(idx)) {
            intersection++;
        }
    }

    const smaller = Math.min(indicesA.size, indicesB.size);
    if (smaller === 0) return 0;

    return intersection / smaller;
}

/**
 * Merge two overlapping chunks, keeping the higher-scoring anchor
 */
function mergeChunks(chunkA: Chunk, chunkB: Chunk): Chunk {
    // Combine sentence indices and dedupe
    const sentenceMap = new Map<number, typeof chunkA.sentences[number]>();

    for (const s of chunkA.sentences) {
        sentenceMap.set(s.globalIndex, s);
    }
    for (const s of chunkB.sentences) {
        sentenceMap.set(s.globalIndex, s);
    }

    // Sort by global index
    const mergedSentences = Array.from(sentenceMap.values())
        .sort((a, b) => a.globalIndex - b.globalIndex);

    // Keep the higher-scoring anchor
    const keepChunk = chunkA.score >= chunkB.score ? chunkA : chunkB;

    // Rebuild text with proper formatting (headings, code fences, lists)
    const text = buildChunkText(mergedSentences);

    return {
        sentences: mergedSentences,
        anchorIndex: keepChunk.anchorIndex,
        score: Math.max(chunkA.score, chunkB.score),
        text,
        charCount: text.length,
        headingPath: keepChunk.headingPath,
    };
}

/**
 * Get all tokens from a chunk's sentences
 */
function getChunkTokens(chunk: Chunk): string[] {
    const tokens: string[] = [];
    for (const s of chunk.sentences) {
        tokens.push(...s.tokens);
    }
    return tokens;
}

/**
 * Deduplicate and merge overlapping chunks
 */
export function dedupeChunks(
    chunks: Chunk[],
    config: DedupeConfig = {}
): Chunk[] {
    const {
        overlapThreshold = DEFAULT_CONFIG.overlapThreshold,
        tokenSimilarityThreshold = DEFAULT_CONFIG.tokenSimilarityThreshold,
    } = config;

    if (chunks.length <= 1) {
        return chunks;
    }

    // Sort chunks by score descending; tie-break by anchorIndex for determinism
    const sorted = [...chunks].sort((a, b) => {
        const d = b.score - a.score;
        if (d !== 0) return d;
        return a.anchorIndex - b.anchorIndex;
    });
    const result: Chunk[] = [];
    const merged = new Set<number>();

    for (let i = 0; i < sorted.length; i++) {
        if (merged.has(i)) continue;

        let accumulatedChunk = sorted[i];
        if (accumulatedChunk === undefined) continue;

        // Check for overlaps with remaining chunks
        for (let j = i + 1; j < sorted.length; j++) {
            if (merged.has(j)) continue;

            const other = sorted[j];
            if (other === undefined) continue;

            // Check sentence index overlap
            const overlap = calculateSentenceOverlap(accumulatedChunk, other);
            if (overlap >= overlapThreshold) {
                // Merge the chunks
                accumulatedChunk = mergeChunks(accumulatedChunk, other);
                merged.add(j);
                continue;
            }

            // Check token similarity (for near-duplicate detection)
            const accumulatedTokens = getChunkTokens(accumulatedChunk);
            const otherTokens = getChunkTokens(other);
            const similarity = jaccardSimilarity(accumulatedTokens, otherTokens);

            if (similarity >= tokenSimilarityThreshold) {
                // Very similar content - keep the higher-scoring one
                merged.add(j);
            }
        }

        result.push(accumulatedChunk);
    }

    // Re-sort by score; tie-break by anchorIndex for determinism
    result.sort((a, b) => {
        const d = b.score - a.score;
        if (d !== 0) return d;
        return a.anchorIndex - b.anchorIndex;
    });

    return result;
}

/**
 * Remove chunks that are subsets of other chunks
 * Optimized: pre-builds index sets and uses early termination
 */
export function removeSubsetChunks(chunks: Chunk[]): Chunk[] {
    if (chunks.length <= 1) {
        return chunks;
    }

    // Sort by number of sentences descending; tie-break by anchorIndex for determinism
    // This ensures larger chunks are processed first, so subsets are checked against them
    const sorted = [...chunks].sort((a, b) => {
        const d = b.sentences.length - a.sentences.length;
        if (d !== 0) return d;
        return a.anchorIndex - b.anchorIndex;
    });

    // Pre-build index sets for all chunks to avoid repeated Set creation
    const chunkIndexSets = sorted.map(chunk =>
        new Set(chunk.sentences.map(s => s.globalIndex))
    );

    const result: Chunk[] = [];
    const resultIndexSets: Set<number>[] = [];

    for (let i = 0; i < sorted.length; i++) {
        const chunk = sorted[i];
        const chunkIndices = chunkIndexSets[i];
        if (chunk === undefined || chunkIndices === undefined) continue;

        // A chunk can only be a subset of larger chunks already in result
        // Since we sorted by size descending, all result chunks are >= current size
        let isSubset = false;

        for (const existingIndices of resultIndexSets) {
            // Early termination: if existing is smaller, chunk can't be its subset
            if (existingIndices.size < chunkIndices.size) continue;

            // Check if all of chunk's indices are in existing
            let allInExisting = true;
            for (const idx of chunkIndices) {
                if (!existingIndices.has(idx)) {
                    allInExisting = false;
                    break;
                }
            }

            if (allInExisting) {
                isSubset = true;
                break;
            }
        }

        if (!isSubset) {
            result.push(chunk);
            resultIndexSets.push(chunkIndices);
        }
    }

    // Re-sort by score; tie-break by anchorIndex for determinism
    result.sort((a, b) => {
        const d = b.score - a.score;
        if (d !== 0) return d;
        return a.anchorIndex - b.anchorIndex;
    });

    return result;
}

/**
 * Full deduplication pipeline
 */
export function fullDedupe(
    chunks: Chunk[],
    config: DedupeConfig = {}
): Chunk[] {
    // First merge overlapping chunks
    const merged = dedupeChunks(chunks, config);

    // Then remove any remaining subsets
    return removeSubsetChunks(merged);
}
