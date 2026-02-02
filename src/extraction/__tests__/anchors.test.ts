import { describe, it, expect } from "vitest";
import { selectAnchors, selectAnchorsWithPositionDiversity } from "../anchors";
import type { ScoredSentence } from "../../types";

function createScoredSentence(
    text: string,
    tokens: string[],
    globalIndex: number,
    combinedScore: number
): ScoredSentence {
    return {
        text,
        tokens,
        blockIndex: 0,
        sentenceIndex: 0,
        globalIndex,
        headingPath: [],
        position: globalIndex / 10,
        blockType: "p",
        bm25Score: combinedScore,
        heuristicScore: combinedScore,
        combinedScore,
    };
}

describe("selectAnchors", () => {
    it("selects top-scoring sentences", () => {
        const sentences: ScoredSentence[] = [
            createScoredSentence("High score", ["high", "score"], 0, 0.9),
            createScoredSentence("Medium score", ["medium", "score"], 1, 0.5),
            createScoredSentence("Low score", ["low", "score"], 2, 0.2),
        ];

        const anchors = selectAnchors(sentences, { maxAnchors: 2 });

        expect(anchors).toHaveLength(2);
        expect(anchors[0]?.combinedScore).toBe(0.9);
        expect(anchors[1]?.combinedScore).toBe(0.5);
    });

    it("filters out sentences below minScore", () => {
        const sentences: ScoredSentence[] = [
            createScoredSentence("High", ["high"], 0, 0.8),
            createScoredSentence("Low", ["low"], 1, 0.05), // Below default 0.1
        ];

        const anchors = selectAnchors(sentences, { minScore: 0.1 });

        expect(anchors).toHaveLength(1);
        expect(anchors[0]?.text).toBe("High");
    });

    it("respects custom minScore", () => {
        const sentences: ScoredSentence[] = [
            createScoredSentence("High", ["high"], 0, 0.8),
            createScoredSentence("Medium", ["medium"], 1, 0.4),
            createScoredSentence("Low", ["low"], 2, 0.2),
        ];

        const anchors = selectAnchors(sentences, { minScore: 0.25 });

        expect(anchors).toHaveLength(2);
        expect(anchors.some(a => a.text === "Low")).toBe(false);
    });

    it("enforces diversity threshold (Jaccard similarity)", () => {
        const sentences: ScoredSentence[] = [
            createScoredSentence("React hooks are great", ["react", "hook", "great"], 0, 0.9),
            createScoredSentence("React hooks are amazing", ["react", "hook", "amaz"], 1, 0.8), // Similar
            createScoredSentence("Vue components work", ["vue", "compon", "work"], 2, 0.7), // Different
        ];

        // With threshold 0.4, sentences with Jaccard > 0.4 are rejected
        // "react hook great" vs "react hook amaz" = 2/4 = 0.5 > 0.4
        const anchors = selectAnchors(sentences, {
            maxAnchors: 3,
            diversityThreshold: 0.4,
        });

        expect(anchors.some(a => a.text === "React hooks are great")).toBe(true);
        expect(anchors.some(a => a.text === "React hooks are amazing")).toBe(false); // Too similar
        expect(anchors.some(a => a.text === "Vue components work")).toBe(true);
    });

    it("returns just 1 anchor when all sentences are similar", () => {
        const sentences: ScoredSentence[] = [
            createScoredSentence("React hooks", ["react", "hook"], 0, 0.9),
            createScoredSentence("React hooks usage", ["react", "hook", "usag"], 1, 0.8),
            createScoredSentence("Using react hooks", ["use", "react", "hook"], 2, 0.7),
        ];

        const anchors = selectAnchors(sentences, {
            maxAnchors: 3,
            diversityThreshold: 0.4,
        });

        // All are similar to first, so only first should be selected
        expect(anchors).toHaveLength(1);
        expect(anchors[0]?.text).toBe("React hooks");
    });

    it("respects maxAnchors limit", () => {
        const sentences: ScoredSentence[] = [
            createScoredSentence("One", ["one"], 0, 0.9),
            createScoredSentence("Two", ["two"], 1, 0.8),
            createScoredSentence("Three", ["three"], 2, 0.7),
            createScoredSentence("Four", ["four"], 3, 0.6),
        ];

        const anchors = selectAnchors(sentences, { maxAnchors: 2 });

        expect(anchors).toHaveLength(2);
    });

    it("handles empty input", () => {
        const anchors = selectAnchors([]);

        expect(anchors).toHaveLength(0);
    });

    it("handles all sentences below minScore", () => {
        const sentences: ScoredSentence[] = [
            createScoredSentence("Low1", ["low1"], 0, 0.01),
            createScoredSentence("Low2", ["low2"], 1, 0.02),
        ];

        const anchors = selectAnchors(sentences, { minScore: 0.25 });

        expect(anchors).toHaveLength(0);
    });
});

describe("selectAnchorsWithPositionDiversity", () => {
    it("enforces minimum position gap", () => {
        const sentences: ScoredSentence[] = [
            createScoredSentence("Sent0", ["sent0"], 0, 0.9),
            createScoredSentence("Sent1", ["sent1"], 1, 0.85), // Gap of 1 < default 3
            createScoredSentence("Sent2", ["sent2"], 2, 0.8),  // Gap of 2 < default 3
            createScoredSentence("Sent5", ["sent5"], 5, 0.7),  // Gap of 5 >= 3
        ];

        const anchors = selectAnchorsWithPositionDiversity(sentences, {
            maxAnchors: 3,
            minPositionGap: 3,
            diversityThreshold: 1.0, // Disable token similarity check
        });

        expect(anchors.some(a => a.globalIndex === 0)).toBe(true);
        expect(anchors.some(a => a.globalIndex === 1)).toBe(false); // Too close to 0
        expect(anchors.some(a => a.globalIndex === 2)).toBe(false); // Too close to 0
        expect(anchors.some(a => a.globalIndex === 5)).toBe(true);  // Far enough
    });

    it("rejects sentences within position gap even with different content", () => {
        const sentences: ScoredSentence[] = [
            createScoredSentence("React hooks", ["react", "hook"], 0, 0.9),
            createScoredSentence("Vue components", ["vue", "compon"], 2, 0.8), // Gap < 5, different content
            createScoredSentence("Angular services", ["angular", "servic"], 10, 0.7), // Gap >= 5
        ];

        const anchors = selectAnchorsWithPositionDiversity(sentences, {
            minPositionGap: 5,
            diversityThreshold: 1.0,
        });

        expect(anchors.some(a => a.text === "React hooks")).toBe(true);
        expect(anchors.some(a => a.text === "Vue components")).toBe(false);
        expect(anchors.some(a => a.text === "Angular services")).toBe(true);
    });

    it("combines position gap with token diversity", () => {
        const sentences: ScoredSentence[] = [
            createScoredSentence("React hooks", ["react", "hook"], 0, 0.9),
            createScoredSentence("React hooks usage", ["react", "hook", "usag"], 10, 0.8), // Far but similar
        ];

        const anchors = selectAnchorsWithPositionDiversity(sentences, {
            minPositionGap: 5,
            diversityThreshold: 0.4, // Will reject similar tokens
        });

        // Position gap is OK, but token similarity is too high
        expect(anchors).toHaveLength(1);
    });

    it("uses default gap of 3", () => {
        const sentences: ScoredSentence[] = [
            createScoredSentence("A", ["a"], 0, 0.9),
            createScoredSentence("B", ["b"], 3, 0.8), // Gap of exactly 3 should be OK
        ];

        const anchors = selectAnchorsWithPositionDiversity(sentences, {
            diversityThreshold: 1.0, // Disable token check
        });

        expect(anchors).toHaveLength(2);
    });
});
