import { describe, it, expect } from "vitest";
import { dedupeChunks, removeSubsetChunks, fullDedupe } from "../dedupe";
import type { Chunk, Sentence } from "../../types";

function createSentence(text: string, globalIndex: number): Sentence {
    return {
        text,
        tokens: text.split(" ").map(t => t.toLowerCase()),
        blockIndex: globalIndex,
        sentenceIndex: 0,
        globalIndex,
        headingPath: [],
        position: globalIndex / 10,
        blockType: "p",
    };
}

function createChunk(
    sentences: Array<{ text: string; globalIndex: number }>,
    score: number,
    anchorIndex: number
): Chunk {
    const chunkSentences = sentences.map(s => createSentence(s.text, s.globalIndex));
    return {
        sentences: chunkSentences,
        anchorIndex,
        score,
        text: chunkSentences.map(s => s.text).join(" "),
        charCount: chunkSentences.reduce((sum, s) => sum + s.text.length, 0),
        headingPath: [],
    };
}

describe("dedupeChunks", () => {
    it("merges chunks with >= 50% sentence overlap", () => {
        // Chunk A: sentences 0, 1, 2, 3
        // Chunk B: sentences 2, 3, 4, 5
        // Overlap: 2, 3 = 2/4 = 50%
        const chunkA = createChunk([
            { text: "Sent0", globalIndex: 0 },
            { text: "Sent1", globalIndex: 1 },
            { text: "Sent2", globalIndex: 2 },
            { text: "Sent3", globalIndex: 3 },
        ], 0.9, 1);

        const chunkB = createChunk([
            { text: "Sent2", globalIndex: 2 },
            { text: "Sent3", globalIndex: 3 },
            { text: "Sent4", globalIndex: 4 },
            { text: "Sent5", globalIndex: 5 },
        ], 0.8, 4);

        const result = dedupeChunks([chunkA, chunkB], { overlapThreshold: 0.5 });

        expect(result).toHaveLength(1);
        // Merged chunk should have sentences 0-5
        expect(result[0]?.sentences).toHaveLength(6);
    });

    it("preserves higher score in merged chunk", () => {
        const chunkA = createChunk([
            { text: "Sent0", globalIndex: 0 },
            { text: "Sent1", globalIndex: 1 },
        ], 0.5, 0);

        const chunkB = createChunk([
            { text: "Sent0", globalIndex: 0 },
            { text: "Sent1", globalIndex: 1 },
        ], 0.9, 1);

        const result = dedupeChunks([chunkA, chunkB]);

        expect(result).toHaveLength(1);
        expect(result[0]?.score).toBe(0.9);
        expect(result[0]?.anchorIndex).toBe(1); // From higher-scoring chunk
    });

    it("does not merge chunks with low overlap", () => {
        // Chunk A: sentences 0, 1
        // Chunk B: sentences 5, 6
        // No overlap
        const chunkA = createChunk([
            { text: "Sent0", globalIndex: 0 },
            { text: "Sent1", globalIndex: 1 },
        ], 0.9, 0);

        const chunkB = createChunk([
            { text: "Sent5", globalIndex: 5 },
            { text: "Sent6", globalIndex: 6 },
        ], 0.8, 5);

        const result = dedupeChunks([chunkA, chunkB]);

        expect(result).toHaveLength(2);
    });

    it("removes near-duplicates by token similarity", () => {
        const chunkA = createChunk([
            { text: "react hooks are great", globalIndex: 0 },
        ], 0.9, 0);

        const chunkB = createChunk([
            { text: "react hooks are amazing", globalIndex: 5 },
        ], 0.7, 5);

        // Different sentences but similar tokens
        // "react hooks are great" vs "react hooks are amazing"
        // Jaccard: 3/5 = 0.6 < default 0.72, so should NOT be removed
        const result = dedupeChunks([chunkA, chunkB]);

        expect(result).toHaveLength(2);

        // With lower threshold, should be removed
        const strictResult = dedupeChunks([chunkA, chunkB], {
            tokenSimilarityThreshold: 0.5,
        });
        expect(strictResult).toHaveLength(1);
    });

    it("handles transitive merging (A overlaps B, B overlaps C)", () => {
        const chunkA = createChunk([
            { text: "Sent0", globalIndex: 0 },
            { text: "Sent1", globalIndex: 1 },
            { text: "Sent2", globalIndex: 2 },
        ], 0.9, 1);

        const chunkB = createChunk([
            { text: "Sent2", globalIndex: 2 },
            { text: "Sent3", globalIndex: 3 },
            { text: "Sent4", globalIndex: 4 },
        ], 0.7, 3);

        const chunkC = createChunk([
            { text: "Sent4", globalIndex: 4 },
            { text: "Sent5", globalIndex: 5 },
            { text: "Sent6", globalIndex: 6 },
        ], 0.5, 5);

        // A overlaps B (sentence 2), B overlaps C (sentence 4)
        // Should end up with one merged chunk containing 0-6
        const result = dedupeChunks([chunkA, chunkB, chunkC], {
            overlapThreshold: 0.3, // Lower threshold to trigger merges
        });

        // Due to iterative merging, all should be merged
        expect(result).toHaveLength(1);
        expect(result[0]?.sentences.length).toBe(7);
    });

    it("returns empty for empty input", () => {
        const result = dedupeChunks([]);

        expect(result).toHaveLength(0);
    });

    it("returns single chunk unchanged", () => {
        const chunk = createChunk([
            { text: "Only", globalIndex: 0 },
        ], 0.9, 0);

        const result = dedupeChunks([chunk]);

        expect(result).toHaveLength(1);
        expect(result[0]).toBe(chunk);
    });
});

describe("removeSubsetChunks", () => {
    it("removes chunk that is fully contained in another", () => {
        const largeChunk = createChunk([
            { text: "Sent0", globalIndex: 0 },
            { text: "Sent1", globalIndex: 1 },
            { text: "Sent2", globalIndex: 2 },
            { text: "Sent3", globalIndex: 3 },
        ], 0.9, 1);

        const subsetChunk = createChunk([
            { text: "Sent1", globalIndex: 1 },
            { text: "Sent2", globalIndex: 2 },
        ], 0.8, 1);

        const result = removeSubsetChunks([largeChunk, subsetChunk]);

        expect(result).toHaveLength(1);
        expect(result[0]?.sentences).toHaveLength(4);
    });

    it("keeps chunks that are not subsets", () => {
        const chunkA = createChunk([
            { text: "Sent0", globalIndex: 0 },
            { text: "Sent1", globalIndex: 1 },
        ], 0.9, 0);

        const chunkB = createChunk([
            { text: "Sent2", globalIndex: 2 },
            { text: "Sent3", globalIndex: 3 },
        ], 0.8, 2);

        const result = removeSubsetChunks([chunkA, chunkB]);

        expect(result).toHaveLength(2);
    });

    it("keeps partially overlapping chunks", () => {
        const chunkA = createChunk([
            { text: "Sent0", globalIndex: 0 },
            { text: "Sent1", globalIndex: 1 },
            { text: "Sent2", globalIndex: 2 },
        ], 0.9, 1);

        const chunkB = createChunk([
            { text: "Sent2", globalIndex: 2 },
            { text: "Sent3", globalIndex: 3 },
            { text: "Sent4", globalIndex: 4 },
        ], 0.8, 3);

        // Neither is a subset of the other
        const result = removeSubsetChunks([chunkA, chunkB]);

        expect(result).toHaveLength(2);
    });

    it("handles multiple subsets of one chunk", () => {
        const large = createChunk([
            { text: "Sent0", globalIndex: 0 },
            { text: "Sent1", globalIndex: 1 },
            { text: "Sent2", globalIndex: 2 },
            { text: "Sent3", globalIndex: 3 },
        ], 0.9, 2);

        const subset1 = createChunk([
            { text: "Sent0", globalIndex: 0 },
            { text: "Sent1", globalIndex: 1 },
        ], 0.7, 0);

        const subset2 = createChunk([
            { text: "Sent2", globalIndex: 2 },
            { text: "Sent3", globalIndex: 3 },
        ], 0.6, 3);

        const result = removeSubsetChunks([large, subset1, subset2]);

        expect(result).toHaveLength(1);
        expect(result[0]?.sentences).toHaveLength(4);
    });

    it("returns empty for empty input", () => {
        const result = removeSubsetChunks([]);

        expect(result).toHaveLength(0);
    });
});

describe("fullDedupe", () => {
    it("performs both merge and subset removal", () => {
        const chunkA = createChunk([
            { text: "Sent0", globalIndex: 0 },
            { text: "Sent1", globalIndex: 1 },
            { text: "Sent2", globalIndex: 2 },
        ], 0.9, 1);

        const chunkB = createChunk([
            { text: "Sent2", globalIndex: 2 },
            { text: "Sent3", globalIndex: 3 },
        ], 0.7, 2);

        const chunkC = createChunk([
            { text: "Sent1", globalIndex: 1 }, // Subset of merged A+B
        ], 0.5, 1);

        const result = fullDedupe([chunkA, chunkB, chunkC], {
            overlapThreshold: 0.3,
        });

        // A and B should merge (overlap at Sent2)
        // C should be removed as subset of merged
        expect(result).toHaveLength(1);
    });

    it("sorts result by score descending", () => {
        const chunkA = createChunk([
            { text: "Sent0", globalIndex: 0 },
        ], 0.5, 0);

        const chunkB = createChunk([
            { text: "Sent5", globalIndex: 5 },
        ], 0.9, 5);

        const result = fullDedupe([chunkA, chunkB]);

        expect(result[0]?.score).toBe(0.9);
        expect(result[1]?.score).toBe(0.5);
    });
});
