import { describe, it, expect } from "vitest";
import {
    calculatePositionScore,
    calculateHeadingProximityScore,
    calculateDensityScore,
    calculateStructureScore,
    calculateProximityScore,
    calculateHeadingPathScore,
    calculateCoverageScore,
    calculateOutlierScore,
    calculateMetaSectionScore,
    calculateHeuristicScores,
    computeDensityStats,
} from "../heuristics";
import type { Sentence, DensityStats } from "../../types";

function createSentence(
    text: string,
    tokens: string[],
    options: Partial<Sentence> = {}
): Sentence {
    return {
        text,
        tokens,
        blockIndex: 0,
        sentenceIndex: 0,
        globalIndex: 0,
        headingPath: [],
        position: 0.5,
        blockType: "p",
        ...options,
    };
}

describe("calculatePositionScore", () => {
    it("returns 1.0 for position 0", () => {
        const sentence = createSentence("First", ["first"], { position: 0 });
        expect(calculatePositionScore(sentence)).toBeCloseTo(1.0, 5);
    });

    it("returns 0.7 for position 0.3", () => {
        const sentence = createSentence("Early", ["earli"], { position: 0.3 });
        expect(calculatePositionScore(sentence)).toBeCloseTo(0.7, 5);
    });

    it("returns 0.5 for position 0.7", () => {
        const sentence = createSentence("Late", ["late"], { position: 0.7 });
        expect(calculatePositionScore(sentence)).toBeCloseTo(0.5, 5);
    });

    it("returns 0.3 for position 1.0", () => {
        const sentence = createSentence("Last", ["last"], { position: 1.0 });
        expect(calculatePositionScore(sentence)).toBeCloseTo(0.3, 5);
    });

    it("is continuous at position 0.3 boundary", () => {
        const before = createSentence("Before", ["befor"], { position: 0.29 });
        const at = createSentence("At", ["at"], { position: 0.3 });
        const after = createSentence("After", ["after"], { position: 0.31 });

        const beforeScore = calculatePositionScore(before);
        const atScore = calculatePositionScore(at);
        const afterScore = calculatePositionScore(after);

        // Should be continuous (no jumps)
        expect(Math.abs(beforeScore - atScore)).toBeLessThan(0.05);
        expect(Math.abs(atScore - afterScore)).toBeLessThan(0.05);
    });

    it("is continuous at position 0.7 boundary", () => {
        const before = createSentence("Before", ["befor"], { position: 0.69 });
        const at = createSentence("At", ["at"], { position: 0.7 });
        const after = createSentence("After", ["after"], { position: 0.71 });

        const beforeScore = calculatePositionScore(before);
        const atScore = calculatePositionScore(at);
        const afterScore = calculatePositionScore(after);

        expect(Math.abs(beforeScore - atScore)).toBeLessThan(0.05);
        expect(Math.abs(atScore - afterScore)).toBeLessThan(0.05);
    });

    it("is monotonically decreasing", () => {
        const positions = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
        const scores = positions.map(pos => {
            const s = createSentence("Test", ["test"], { position: pos });
            return calculatePositionScore(s);
        });

        for (let i = 1; i < scores.length; i++) {
            expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]!);
        }
    });
});

describe("calculateHeadingProximityScore", () => {
    it("returns 0.3 when no preceding heading exists", () => {
        const sentence = createSentence("Content", ["content"], { globalIndex: 0 });
        const allSentences = [sentence];

        const score = calculateHeadingProximityScore(sentence, ["query"], allSentences);
        expect(score).toBe(0.3);
    });

    it("scores higher when nearest heading matches query", () => {
        const heading = createSentence("React Hooks", ["react", "hook"], {
            globalIndex: 0,
            blockType: "h2",
        });
        const content = createSentence("Some content here", ["content", "here"], {
            globalIndex: 1,
        });
        const allSentences = [heading, content];

        const matchingScore = calculateHeadingProximityScore(content, ["react"], allSentences);
        const nonMatchingScore = calculateHeadingProximityScore(content, ["python"], allSentences);

        expect(matchingScore).toBeGreaterThan(nonMatchingScore);
    });

    it("distance affects score (closer is better)", () => {
        const heading = createSentence("Heading", ["head"], {
            globalIndex: 0,
            blockType: "h2",
        });
        const close = createSentence("Close", ["close"], { globalIndex: 1 });
        const far = createSentence("Far", ["far"], { globalIndex: 10 });
        const allSentences = [heading, close, far];

        const closeScore = calculateHeadingProximityScore(close, ["head"], allSentences);
        const farScore = calculateHeadingProximityScore(far, ["head"], allSentences);

        expect(closeScore).toBeGreaterThan(farScore);
    });
});

describe("calculateDensityScore", () => {
    it("returns 0 for empty tokens", () => {
        const sentence = createSentence("", [], {});
        expect(calculateDensityScore(sentence, ["query"])).toBe(0);
    });

    it("returns 0 for empty query", () => {
        const sentence = createSentence("Content", ["content"]);
        expect(calculateDensityScore(sentence, [])).toBe(0);
    });

    it("scores higher for higher query term density", () => {
        const highDensity = createSentence("React hooks", ["react", "hook"]);
        const lowDensity = createSentence("Some other content about things", [
            "other", "content", "about", "thing",
        ]);

        const highScore = calculateDensityScore(highDensity, ["react", "hook"]);
        const lowScore = calculateDensityScore(lowDensity, ["react"]);

        expect(highScore).toBeGreaterThan(lowScore);
    });

    it("prefers coverage over repetition", () => {
        // Same density but different coverage
        const twoTerms = createSentence("React hook test", ["react", "hook", "test"]);
        const repeated = createSentence("React react test", ["react", "react", "test"]);

        const twoTermScore = calculateDensityScore(twoTerms, ["react", "hook"]);
        const repeatedScore = calculateDensityScore(repeated, ["react", "hook"]);

        // Coverage is weighted 0.6 vs density 0.4
        expect(twoTermScore).toBeGreaterThan(repeatedScore);
    });
});

describe("calculateStructureScore", () => {
    it("paragraphs get base score of 0.8", () => {
        const sentence = createSentence("Paragraph", ["paragraph"], { blockType: "p" });
        const allSentences = [sentence];

        const score = calculateStructureScore(sentence, [], allSentences);
        expect(score).toBeCloseTo(0.8, 1);
    });

    it("list items get base score of 0.7", () => {
        const sentence = createSentence("List item", ["list", "item"], { blockType: "li" });
        const allSentences = [sentence];

        const score = calculateStructureScore(sentence, [], allSentences);
        expect(score).toBeCloseTo(0.7, 1);
    });

    it("code blocks get base score of 0.65", () => {
        const sentence = createSentence("code()", ["code"], { blockType: "pre" });
        const allSentences = [sentence];

        const score = calculateStructureScore(sentence, [], allSentences);
        expect(score).toBeCloseTo(0.65, 1);
    });

    it("headings get base score of 0.4", () => {
        const sentence = createSentence("Heading", ["head"], { blockType: "h2" });
        const allSentences = [sentence];

        const score = calculateStructureScore(sentence, [], allSentences);
        expect(score).toBeCloseTo(0.4, 1);
    });

    it("gets bonus for being adjacent to code block", () => {
        const explanation = createSentence("This explains the code", ["explain", "code"], {
            globalIndex: 0,
            blockType: "p",
        });
        const code = createSentence("const x = 1", ["const"], {
            globalIndex: 1,
            blockType: "pre",
        });
        const allSentences = [explanation, code];

        const score = calculateStructureScore(explanation, [], allSentences);
        expect(score).toBeGreaterThan(0.8); // Base 0.8 + 0.1 bonus
    });
});

describe("calculateProximityScore", () => {
    it("returns 0 for empty tokens", () => {
        const sentence = createSentence("", []);
        expect(calculateProximityScore(sentence, ["query"])).toBe(0);
    });

    it("returns 0 for empty query", () => {
        const sentence = createSentence("Content", ["content"]);
        expect(calculateProximityScore(sentence, [])).toBe(0);
    });

    it("returns 0 when no query terms match", () => {
        const sentence = createSentence("Content", ["content"]);
        expect(calculateProximityScore(sentence, ["other"])).toBe(0);
    });

    it("returns coverage-based score for single term match", () => {
        const sentence = createSentence("Contains react", ["contain", "react"]);
        const score = calculateProximityScore(sentence, ["react", "hook"]);

        // Single term matched out of 2 query terms = 0.5 coverage * 0.5
        expect(score).toBeCloseTo(0.25, 1);
    });

    it("scores higher when query terms are adjacent", () => {
        const adjacent = createSentence("react hook", ["react", "hook"]);
        const spread = createSentence("react is a hook library", ["react", "is", "a", "hook", "librari"]);

        const adjacentScore = calculateProximityScore(adjacent, ["react", "hook"]);
        const spreadScore = calculateProximityScore(spread, ["react", "hook"]);

        expect(adjacentScore).toBeGreaterThan(spreadScore);
    });

    it("finds minimal spanning window correctly", () => {
        // Query terms at positions: a=0, b=3, c=1
        // The minimal window spanning all should be [0,3] = span of 4
        const sentence = createSentence("a c x b", ["a", "c", "x", "b"]);
        const score = calculateProximityScore(sentence, ["a", "b", "c"]);

        // All 3 terms found, so coverage = 1.0
        // Span = 4, sentence length = 4, spanTightness = 1 - 4/4 = 0
        // Expected: 1.0 * 0.4 + 0 * 0.35 + (3/4) * 0.25 = 0.4 + 0.1875 ≈ 0.59
        expect(score).toBeGreaterThan(0.5);
    });
});

describe("calculateHeadingPathScore", () => {
    const mockGetIdf = (term: string): number => {
        const idfs: Record<string, number> = {
            react: 2.0,
            hook: 1.5,
            common: 0.5,
        };
        return idfs[term] ?? 1.0;
    };

    it("returns 0.3 for empty heading path", () => {
        const sentence = createSentence("Content", ["content"], { headingPath: [] });
        expect(calculateHeadingPathScore(sentence, ["query"], mockGetIdf)).toBe(0.3);
    });

    it("returns 0.3 for empty query", () => {
        const sentence = createSentence("Content", ["content"], {
            headingPath: ["React Hooks"],
        });
        expect(calculateHeadingPathScore(sentence, [], mockGetIdf)).toBe(0.3);
    });

    it("scores higher when heading path matches query", () => {
        const matching = createSentence("Content", ["content"], {
            headingPath: ["React Hooks Guide"],
        });
        const nonMatching = createSentence("Content", ["content"], {
            headingPath: ["Python Tutorial"],
        });

        const matchingScore = calculateHeadingPathScore(matching, ["react"], mockGetIdf);
        const nonMatchingScore = calculateHeadingPathScore(nonMatching, ["react"], mockGetIdf);

        expect(matchingScore).toBeGreaterThan(nonMatchingScore);
    });

    it("tokenizes heading path correctly", () => {
        // "API Reference" should match query "api"
        const sentence = createSentence("Content", ["content"], {
            headingPath: ["API Reference"],
        });

        const score = calculateHeadingPathScore(sentence, ["api"], mockGetIdf);
        expect(score).toBeGreaterThan(0.3); // Above neutral
    });
});

describe("calculateCoverageScore", () => {
    const mockGetIdf = (term: string): number => {
        const idfs: Record<string, number> = {
            rare: 3.0,
            common: 0.5,
            medium: 1.5,
        };
        return idfs[term] ?? 1.0;
    };

    it("returns 0 for empty tokens", () => {
        const sentence = createSentence("", []);
        expect(calculateCoverageScore(sentence, ["query"], mockGetIdf)).toBe(0);
    });

    it("returns 0 for empty query", () => {
        const sentence = createSentence("Content", ["content"]);
        expect(calculateCoverageScore(sentence, [], mockGetIdf)).toBe(0);
    });

    it("IDF weighting makes rare term matches more valuable", () => {
        const rareMatch = createSentence("Contains rare term", ["contain", "rare", "term"]);
        const commonMatch = createSentence("Contains common term", ["contain", "common", "term"]);

        const rareScore = calculateCoverageScore(rareMatch, ["rare", "other"], mockGetIdf);
        const commonScore = calculateCoverageScore(commonMatch, ["common", "other"], mockGetIdf);

        expect(rareScore).toBeGreaterThan(commonScore);
    });

    it("full coverage scores higher than partial", () => {
        const full = createSentence("React hook content", ["react", "hook", "content"]);
        const partial = createSentence("React only", ["react", "onli"]);

        const fullScore = calculateCoverageScore(full, ["react", "hook"], mockGetIdf);
        const partialScore = calculateCoverageScore(partial, ["react", "hook"], mockGetIdf);

        expect(fullScore).toBeGreaterThan(partialScore);
    });
});

describe("computeDensityStats", () => {
    it("handles empty sentences", () => {
        const stats = computeDensityStats([], ["query"]);
        expect(stats.median).toBe(0);
        expect(stats.mad).toBe(0.001); // Floor value
    });

    it("handles empty query", () => {
        const sentences = [createSentence("Content", ["content"])];
        const stats = computeDensityStats(sentences, []);
        expect(stats.median).toBe(0);
    });

    it("calculates median correctly for odd count", () => {
        // Densities: 0, 0.5, 1.0 → median = 0.5
        const sentences = [
            createSentence("no match", ["no", "match"]),
            createSentence("one query token", ["one", "query", "token"]), // 1/3 ≈ 0.33
            createSentence("query", ["query"]), // 1/1 = 1.0
        ];

        const stats = computeDensityStats(sentences, ["query"]);
        // Sorted densities: [0, 0.33, 1.0] → median = 0.33
        expect(stats.median).toBeCloseTo(1 / 3, 2);
    });

    it("calculates median correctly for even count", () => {
        const sentences = [
            createSentence("a", ["a"]), // density 0
            createSentence("query", ["query"]), // density 1.0
            createSentence("x query", ["x", "query"]), // density 0.5
            createSentence("b", ["b"]), // density 0
        ];

        const stats = computeDensityStats(sentences, ["query"]);
        // Sorted: [0, 0, 0.5, 1.0] → median = (0 + 0.5) / 2 = 0.25
        expect(stats.median).toBeCloseTo(0.25, 2);
    });

    it("MAD is floored at 0.001", () => {
        // All same density → MAD would be 0
        const sentences = [
            createSentence("query", ["query"]),
            createSentence("query", ["query"]),
        ];

        const stats = computeDensityStats(sentences, ["query"]);
        expect(stats.mad).toBe(0.001);
    });
});

describe("calculateOutlierScore", () => {
    it("returns 0.3 for empty tokens", () => {
        const sentence = createSentence("", []);
        const stats: DensityStats = { median: 0.1, mad: 0.05 };
        expect(calculateOutlierScore(sentence, ["query"], stats)).toBe(0.3);
    });

    it("returns 0.3 for at-or-below-median sentences", () => {
        const sentence = createSentence("no match", ["no", "match"]);
        const stats: DensityStats = { median: 0.5, mad: 0.1 };
        expect(calculateOutlierScore(sentence, ["query"], stats)).toBe(0.3);
    });

    it("scores higher for positive outliers", () => {
        const highDensity = createSentence("query query", ["query", "query"]); // density = 1.0
        const mediumDensity = createSentence("query other", ["query", "other"]); // density = 0.5
        const stats: DensityStats = { median: 0.3, mad: 0.1 };

        const highScore = calculateOutlierScore(highDensity, ["query"], stats);
        const mediumScore = calculateOutlierScore(mediumDensity, ["query"], stats);

        expect(highScore).toBeGreaterThan(mediumScore);
        expect(highScore).toBeGreaterThan(0.3);
    });

    it("uses sigmoid for smooth transition", () => {
        const sentence = createSentence("query", ["query"]); // density = 1.0
        const stats: DensityStats = { median: 0.1, mad: 0.1 };

        // z-score = (1.0 - 0.1) / 0.1 = 9
        // sigmoid(9 - 2) = sigmoid(7) ≈ 0.999
        // score = 0.3 + 0.7 * 0.999 ≈ 0.999
        const score = calculateOutlierScore(sentence, ["query"], stats);

        expect(score).toBeGreaterThan(0.9);
        expect(score).toBeLessThanOrEqual(1.0);
    });
});

describe("calculateMetaSectionScore", () => {
    it("returns 1.0 for substantive content", () => {
        const sentence = createSentence("This explains how hooks work", ["explain", "hook", "work"], {
            headingPath: ["React Hooks Guide"],
        });
        expect(calculateMetaSectionScore(sentence)).toBe(1.0);
    });

    it("returns 0.2 for content under Introduction heading", () => {
        const sentence = createSentence("Some content", ["content"], {
            headingPath: ["Introduction"],
        });
        expect(calculateMetaSectionScore(sentence)).toBe(0.2);
    });

    it("returns 0.2 for content under Summary heading", () => {
        const sentence = createSentence("Some content", ["content"], {
            headingPath: ["Summary"],
        });
        expect(calculateMetaSectionScore(sentence)).toBe(0.2);
    });

    it("returns 0.2 for content under Conclusion heading", () => {
        const sentence = createSentence("Some content", ["content"], {
            headingPath: ["Conclusion"],
        });
        expect(calculateMetaSectionScore(sentence)).toBe(0.2);
    });

    it("does not penalize About React Hooks (false positive check)", () => {
        const sentence = createSentence("Some content", ["content"], {
            headingPath: ["About React Hooks"],
        });
        // "About React Hooks" should NOT match "^about$" pattern
        expect(calculateMetaSectionScore(sentence)).toBe(1.0);
    });

    it("returns 0.3 for text containing meta phrases", () => {
        const sentence = createSentence("In this article we will cover hooks", [
            "articl", "cover", "hook",
        ], {
            headingPath: ["React Hooks"],
        });
        expect(calculateMetaSectionScore(sentence)).toBe(0.3);
    });

    it("detects nested meta headings", () => {
        const sentence = createSentence("Content", ["content"], {
            headingPath: ["React Guide", "Getting Started", "Prerequisites"],
        });
        // "Prerequisites" matches a meta pattern
        expect(calculateMetaSectionScore(sentence)).toBe(0.2);
    });
});

describe("calculateHeuristicScores", () => {
    const mockGetIdf = (): number => 1.0;
    const defaultDensityStats: DensityStats = { median: 0.1, mad: 0.05 };

    it("combines all 9 heuristic scores", () => {
        const sentence = createSentence("React hooks content", ["react", "hook", "content"], {
            position: 0.2,
            headingPath: ["React Guide"],
        });
        const allSentences = [sentence];

        const scores = calculateHeuristicScores(
            sentence,
            ["react", "hook"],
            allSentences,
            mockGetIdf,
            defaultDensityStats
        );

        // Check all 9 scores are present
        expect(scores).toHaveProperty("positionScore");
        expect(scores).toHaveProperty("headingProximityScore");
        expect(scores).toHaveProperty("densityScore");
        expect(scores).toHaveProperty("structureScore");
        expect(scores).toHaveProperty("proximityScore");
        expect(scores).toHaveProperty("headingPathScore");
        expect(scores).toHaveProperty("coverageScore");
        expect(scores).toHaveProperty("outlierScore");
        expect(scores).toHaveProperty("metaSectionScore");
        expect(scores).toHaveProperty("combined");
    });

    it("combined score is weighted sum of all scores", () => {
        const sentence = createSentence("Test", ["test"], { position: 0.5 });
        const allSentences = [sentence];

        const scores = calculateHeuristicScores(
            sentence,
            ["test"],
            allSentences,
            mockGetIdf,
            defaultDensityStats
        );

        // Verify combined is sum of weighted scores
        const expectedCombined =
            0.05 * scores.positionScore +
            0.11 * scores.headingProximityScore +
            0.09 * scores.densityScore +
            0.11 * scores.structureScore +
            0.14 * scores.proximityScore +
            0.17 * scores.headingPathScore +
            0.16 * scores.coverageScore +
            0.09 * scores.outlierScore +
            0.08 * scores.metaSectionScore;

        expect(scores.combined).toBeCloseTo(expectedCombined, 5);
    });

    it("default weights sum to 1.0", () => {
        // This verifies the weights in the implementation
        const weights = {
            position: 0.05,
            headingProximity: 0.11,
            density: 0.09,
            structure: 0.11,
            proximity: 0.14,
            headingPath: 0.17,
            coverage: 0.16,
            outlier: 0.09,
            metaSection: 0.08,
        };

        const sum = Object.values(weights).reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(1.0, 5);
    });

    it("respects custom weights", () => {
        const sentence = createSentence("Test", ["test"], { position: 0 }); // position score = 1.0
        const allSentences = [sentence];

        const defaultScores = calculateHeuristicScores(
            sentence,
            ["test"],
            allSentences,
            mockGetIdf,
            defaultDensityStats
        );

        const customScores = calculateHeuristicScores(
            sentence,
            ["test"],
            allSentences,
            mockGetIdf,
            defaultDensityStats,
            { position: 0.5, coverage: 0.5 } // Custom weights
        );

        expect(defaultScores.combined).not.toBeCloseTo(customScores.combined, 2);
    });
});
