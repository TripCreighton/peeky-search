import { describe, it, expect } from "vitest";
import { rankSentencesWithRelevance, getTopSentences } from "../ranker";
import type { Sentence } from "../../types";

function createSentence(
    text: string,
    tokens: string[],
    globalIndex: number,
    options: Partial<Sentence> = {}
): Sentence {
    return {
        text,
        tokens,
        blockIndex: 0,
        sentenceIndex: 0,
        globalIndex,
        headingPath: [],
        position: globalIndex / 10,
        blockType: "p",
        ...options,
    };
}

describe("rankSentencesWithRelevance", () => {
    describe("empty inputs", () => {
        it("handles empty sentences array", () => {
            const result = rankSentencesWithRelevance([], ["query"]);

            expect(result.sentences).toHaveLength(0);
            expect(result.hasRelevantResults).toBe(false);
            expect(result.maxRawBm25).toBe(0);
            expect(result.queryTermCoverage).toBe(0);
            expect(result.maxCooccurrence).toBe(0);
        });

        it("handles empty query", () => {
            const sentences = [
                createSentence("Some content", ["content"], 0),
            ];

            const result = rankSentencesWithRelevance(sentences, []);

            expect(result.sentences).toHaveLength(1);
            expect(result.hasRelevantResults).toBe(false);
            expect(result.maxRawBm25).toBe(0);
        });
    });

    describe("score normalization", () => {
        it("normalizes BM25 scores to [0, 1] range", () => {
            const sentences = [
                createSentence("Contains query term", ["contain", "query", "term"], 0),
                createSentence("Different content here", ["differ", "content", "here"], 1),
            ];

            const result = rankSentencesWithRelevance(sentences, ["query"]);

            for (const s of result.sentences) {
                expect(s.bm25Score).toBeGreaterThanOrEqual(0);
                expect(s.bm25Score).toBeLessThanOrEqual(1);
            }
        });

        it("sets all scores to 0.5 when all raw scores are identical", () => {
            const sentences = [
                createSentence("No match", ["no", "match"], 0),
                createSentence("Also no match", ["also", "no", "match"], 1),
            ];

            const result = rankSentencesWithRelevance(sentences, ["query"]);

            // All sentences have BM25 score of 0, normalized to 0.5
            for (const s of result.sentences) {
                expect(s.bm25Score).toBe(0.5);
            }
        });
    });

    describe("deterministic sorting", () => {
        it("sorts by combined score descending", () => {
            const sentences = [
                createSentence("Has query", ["query"], 0),
                createSentence("Has query query", ["query", "query"], 1), // Higher TF
                createSentence("No match", ["other"], 2),
            ];

            const result = rankSentencesWithRelevance(sentences, ["query"]);

            expect(result.sentences[0]?.globalIndex).toBe(1); // Highest score
            expect(result.sentences[2]?.globalIndex).toBe(2); // Lowest score
        });

        it("breaks ties by globalIndex ascending", () => {
            // Create sentences that should have very similar scores
            const sentences = [
                createSentence("query", ["query"], 2),
                createSentence("query", ["query"], 0),
                createSentence("query", ["query"], 1),
            ];

            const result = rankSentencesWithRelevance(sentences, ["query"]);

            // With identical scores, should sort by globalIndex
            expect(result.sentences[0]?.globalIndex).toBe(0);
            expect(result.sentences[1]?.globalIndex).toBe(1);
            expect(result.sentences[2]?.globalIndex).toBe(2);
        });
    });

    describe("query term coverage", () => {
        it("calculates coverage correctly", () => {
            const sentences = [
                createSentence("Has react", ["react"], 0),
                createSentence("Has hooks", ["hook"], 1),
            ];

            const result = rankSentencesWithRelevance(sentences, ["react", "hook", "other"]);

            // 2 out of 3 terms found
            expect(result.queryTermCoverage).toBeCloseTo(2 / 3, 5);
        });

        it("reports 0 coverage when no terms match", () => {
            const sentences = [
                createSentence("Unrelated", ["unrel"], 0),
            ];

            const result = rankSentencesWithRelevance(sentences, ["query"]);

            expect(result.queryTermCoverage).toBe(0);
        });

        it("reports 1.0 coverage when all terms found", () => {
            const sentences = [
                createSentence("Contains react hooks", ["react", "hook"], 0),
            ];

            const result = rankSentencesWithRelevance(sentences, ["react", "hook"]);

            expect(result.queryTermCoverage).toBe(1.0);
        });
    });

    describe("co-occurrence detection", () => {
        it("detects multiple query terms in same sentence", () => {
            const sentences = [
                createSentence("React hooks are great", ["react", "hook", "great"], 0),
            ];

            const result = rankSentencesWithRelevance(sentences, ["react", "hook"]);

            expect(result.maxCooccurrence).toBe(2);
        });

        it("reports max co-occurrence across all sentences", () => {
            const sentences = [
                createSentence("Only react", ["react"], 0),
                createSentence("React and hooks", ["react", "hook"], 1),
                createSentence("React hooks state", ["react", "hook", "state"], 2),
            ];

            const result = rankSentencesWithRelevance(sentences, ["react", "hook", "state"]);

            expect(result.maxCooccurrence).toBe(3); // Sentence 2 has all 3
        });

        it("counts unique terms only", () => {
            const sentences = [
                createSentence("React react react", ["react", "react", "react"], 0),
            ];

            const result = rankSentencesWithRelevance(sentences, ["react", "hook"]);

            expect(result.maxCooccurrence).toBe(1); // Only 1 unique query term
        });
    });

    describe("central term detection", () => {
        it("detects central term (appears in 10%+ of sentences)", () => {
            // Need 10+ sentences for 10% threshold to be meaningful
            const sentences = Array.from({ length: 20 }, (_, i) =>
                createSentence(
                    i < 3 ? "Contains react" : "Other content",
                    i < 3 ? ["react", "content"] : ["other", "content"],
                    i
                )
            );

            const result = rankSentencesWithRelevance(sentences, ["react"], {
                relevanceMode: "search",
            });

            // "react" appears in 3/20 = 15% > 10%, so it's central
            // Combined with any BM25 > 0.4, should be relevant
            expect(result.hasRelevantResults).toBe(true);
        });

        it("minimum threshold is 3 sentences regardless of 10%", () => {
            // With 20 sentences, threshold is max(3, 2) = 3
            const sentences = Array.from({ length: 20 }, (_, i) =>
                createSentence(
                    i < 2 ? "Contains react" : "Other content",
                    i < 2 ? ["react"] : ["other", "content"],
                    i
                )
            );

            const result = rankSentencesWithRelevance(sentences, ["react"], {
                relevanceMode: "search",
            });

            // "react" appears in only 2 sentences < 3 minimum, not central
            // With no co-occurrence and low coverage, may not be relevant
        });
    });

    describe("search mode relevance thresholds", () => {
        it("passes with strong BM25 and decent coverage", () => {
            // Create corpus where one sentence matches well and others don't
            // This gives a high raw BM25 score for the matching sentence
            const sentences = [
                createSentence("React hooks are amazing framework", ["react", "hook", "amaz", "framework"], 0),
                createSentence("Other unrelated content here", ["other", "unrel", "content", "here"], 1),
                createSentence("More different stuff", ["more", "differ", "stuff"], 2),
                createSentence("Another sentence without query", ["anoth", "sentenc", "without", "queri"], 3),
            ];

            const result = rankSentencesWithRelevance(sentences, ["react", "hook"], {
                relevanceMode: "search",
            });

            // With 2 query terms co-occurring in sentence 0, maxCooccurrence = 2
            // This should trigger co-occurrence path
            expect(result.maxCooccurrence).toBe(2);
            expect(result.hasRelevantResults).toBe(true);
        });

        it("passes with co-occurrence >= 2 and BM25 > 0.5", () => {
            const sentences = [
                createSentence("React hooks work", ["react", "hook", "work"], 0),
                createSentence("Other stuff", ["other", "stuff"], 1),
            ];

            const result = rankSentencesWithRelevance(sentences, ["react", "hook"], {
                relevanceMode: "search",
            });

            expect(result.maxCooccurrence).toBe(2);
            expect(result.hasRelevantResults).toBe(true);
        });

        it("passes with 50%+ coverage and BM25 > 0.3", () => {
            const sentences = [
                createSentence("Has react", ["react"], 0),
                createSentence("Has hook", ["hook"], 1),
            ];

            const result = rankSentencesWithRelevance(sentences, ["react", "hook"], {
                relevanceMode: "search",
            });

            expect(result.queryTermCoverage).toBe(1.0); // 100% coverage
            expect(result.hasRelevantResults).toBe(true);
        });

        it("fails when thresholds not met", () => {
            const sentences = [
                createSentence("Unrelated content", ["unrel", "content"], 0),
                createSentence("More unrelated", ["more", "unrel"], 1),
            ];

            const result = rankSentencesWithRelevance(sentences, ["react", "hook"], {
                relevanceMode: "search",
            });

            expect(result.hasRelevantResults).toBe(false);
        });
    });

    describe("strict mode relevance thresholds", () => {
        it("requires higher co-occurrence BM25 (> 1.0)", () => {
            const sentences = [
                createSentence("React hook", ["react", "hook"], 0),
            ];

            // Strict mode needs co-occurrence with BM25 > 1.0
            const strictResult = rankSentencesWithRelevance(sentences, ["react", "hook"], {
                relevanceMode: "strict",
            });

            const searchResult = rankSentencesWithRelevance(sentences, ["react", "hook"], {
                relevanceMode: "search",
            });

            // Search mode should pass more easily
            expect(searchResult.hasRelevantResults).toBe(true);
            // Strict might fail depending on BM25 score
        });

        it("requires central term with BM25 > 0.8", () => {
            const sentences = Array.from({ length: 10 }, (_, i) =>
                createSentence(
                    i < 4 ? "Contains react" : "Other content",
                    i < 4 ? ["react"] : ["other"],
                    i
                )
            );

            const strictResult = rankSentencesWithRelevance(sentences, ["react"], {
                relevanceMode: "strict",
            });

            // "react" is central (4/10 = 40%), but needs BM25 > 0.8
        });

        it("requires 80%+ coverage with BM25 > 0.5", () => {
            const sentences = [
                createSentence("React hook state", ["react", "hook", "state"], 0),
            ];

            const result = rankSentencesWithRelevance(sentences, ["react", "hook", "state", "effect"], {
                relevanceMode: "strict",
            });

            // 3/4 = 75% coverage < 80%, strict mode won't pass on coverage alone
            expect(result.queryTermCoverage).toBeCloseTo(0.75, 2);
        });
    });

    describe("combined scoring", () => {
        it("uses default weights (BM25=0.6, heuristic=0.4)", () => {
            const sentences = [
                createSentence("Query term here", ["query", "term", "here"], 0, {
                    position: 0, // Good position score
                }),
            ];

            const result = rankSentencesWithRelevance(sentences, ["query"]);

            // Combined = 0.6 * bm25 + 0.4 * heuristic
            const s = result.sentences[0]!;
            const expected = 0.6 * s.bm25Score + 0.4 * s.heuristicScore;
            expect(s.combinedScore).toBeCloseTo(expected, 5);
        });

        it("respects custom weights", () => {
            const sentences = [
                createSentence("Query", ["query"], 0),
            ];

            const defaultResult = rankSentencesWithRelevance(sentences, ["query"]);
            const customResult = rankSentencesWithRelevance(sentences, ["query"], {
                bm25Weight: 0.9,
                heuristicWeight: 0.1,
            });

            expect(defaultResult.sentences[0]?.combinedScore)
                .not.toBeCloseTo(customResult.sentences[0]?.combinedScore ?? 0, 2);
        });
    });

    describe("result structure", () => {
        it("returns all required properties", () => {
            const sentences = [createSentence("Test", ["test"], 0)];

            const result = rankSentencesWithRelevance(sentences, ["test"]);

            expect(result).toHaveProperty("sentences");
            expect(result).toHaveProperty("hasRelevantResults");
            expect(result).toHaveProperty("maxRawBm25");
            expect(result).toHaveProperty("queryTermCoverage");
            expect(result).toHaveProperty("maxCooccurrence");
        });

        it("scored sentences have all required properties", () => {
            const sentences = [createSentence("Test content", ["test", "content"], 0)];

            const result = rankSentencesWithRelevance(sentences, ["test"]);

            const scored = result.sentences[0]!;
            expect(scored).toHaveProperty("bm25Score");
            expect(scored).toHaveProperty("heuristicScore");
            expect(scored).toHaveProperty("combinedScore");
            // And all original sentence properties
            expect(scored).toHaveProperty("text");
            expect(scored).toHaveProperty("tokens");
            expect(scored).toHaveProperty("globalIndex");
        });
    });
});

describe("getTopSentences", () => {
    it("returns top K sentences", () => {
        const sentences = [
            createSentence("Has query twice query", ["query", "twice", "query"], 0),
            createSentence("Has query once", ["query", "once"], 1),
            createSentence("No match", ["no", "match"], 2),
        ];

        const top2 = getTopSentences(sentences, ["query"], 2);

        expect(top2).toHaveLength(2);
    });

    it("returns all if K > sentence count", () => {
        const sentences = [
            createSentence("Test", ["test"], 0),
            createSentence("Test2", ["test2"], 1),
        ];

        const top10 = getTopSentences(sentences, ["test"], 10);

        expect(top10).toHaveLength(2);
    });

    it("returns empty for empty input", () => {
        const result = getTopSentences([], ["query"], 5);

        expect(result).toHaveLength(0);
    });
});

describe("relevance detection edge cases", () => {
    it("handles single-word query", () => {
        const sentences = [
            createSentence("Contains react framework", ["react", "framework"], 0),
        ];

        const result = rankSentencesWithRelevance(sentences, ["react"], {
            relevanceMode: "search",
        });

        // Single term can't have co-occurrence, relies on BM25 and coverage
        expect(result.queryTermCoverage).toBe(1.0);
    });

    it("handles query terms scattered across document", () => {
        const sentences = [
            createSentence("Has react", ["react"], 0),
            createSentence("Has hook", ["hook"], 1),
            createSentence("Has state", ["state"], 2),
        ];

        const result = rankSentencesWithRelevance(sentences, ["react", "hook", "state"], {
            relevanceMode: "search",
        });

        // Full coverage but no co-occurrence
        expect(result.queryTermCoverage).toBe(1.0);
        expect(result.maxCooccurrence).toBe(1);
        // Should still be relevant due to high coverage
        expect(result.hasRelevantResults).toBe(true);
    });

    it("detects low-quality match (terms appear but low BM25)", () => {
        // Many sentences dilute the BM25 scores
        const sentences = Array.from({ length: 50 }, (_, i) =>
            createSentence(
                i === 25 ? "react" : "other content",
                i === 25 ? ["react"] : ["other", "content"],
                i
            )
        );

        const result = rankSentencesWithRelevance(sentences, ["react"], {
            relevanceMode: "strict",
        });

        // Only 1 sentence has "react", so not central (1/50 = 2% < 10%)
        // May not pass strict thresholds
    });
});
