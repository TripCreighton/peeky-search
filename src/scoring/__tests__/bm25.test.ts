import { describe, it, expect } from "vitest";
import {
    computeDocumentStats,
    calculateIdf,
    createBM25Scorer,
    scoreSentences,
} from "../bm25";
import type { Sentence } from "../../types";

function createSentence(
    text: string,
    tokens: string[],
    globalIndex: number
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
    };
}

describe("computeDocumentStats", () => {
    it("computes correct stats for typical corpus", () => {
        const sentences = [
            createSentence("React hooks are great", ["react", "hook", "great"], 0),
            createSentence("Hooks let you use state", ["hook", "let", "use", "state"], 1),
            createSentence("State management is easy", ["state", "manag", "easi"], 2),
        ];

        const stats = computeDocumentStats(sentences);

        expect(stats.totalDocs).toBe(3);
        expect(stats.avgDocLength).toBe((3 + 4 + 3) / 3);
        expect(stats.docFrequency["hook"]).toBe(2); // appears in 2 sentences
        expect(stats.docFrequency["state"]).toBe(2);
        expect(stats.docFrequency["react"]).toBe(1);
        expect(stats.docFrequency["great"]).toBe(1);
    });

    it("handles empty corpus", () => {
        const stats = computeDocumentStats([]);

        expect(stats.totalDocs).toBe(0);
        expect(stats.avgDocLength).toBe(0);
        expect(Object.keys(stats.docFrequency)).toHaveLength(0);
    });

    it("handles single sentence corpus", () => {
        const sentences = [
            createSentence("Only sentence here", ["onli", "sentenc", "here"], 0),
        ];

        const stats = computeDocumentStats(sentences);

        expect(stats.totalDocs).toBe(1);
        expect(stats.avgDocLength).toBe(3);
        expect(stats.docFrequency["sentenc"]).toBe(1);
    });

    it("counts unique terms per document correctly", () => {
        // A sentence with repeated tokens should still count as df=1
        const sentences = [
            createSentence("test test test", ["test", "test", "test"], 0),
            createSentence("another sentence", ["anoth", "sentenc"], 1),
        ];

        const stats = computeDocumentStats(sentences);

        expect(stats.docFrequency["test"]).toBe(1); // Even though "test" appears 3 times, df=1
    });
});

describe("calculateIdf", () => {
    it("calculates correct IDF for term in corpus", () => {
        const stats = {
            totalDocs: 10,
            avgDocLength: 5,
            docFrequency: { react: 3, hook: 7 },
        };

        // IDF = log((N - df + 0.5) / (df + 0.5) + 1)
        // For "react": log((10 - 3 + 0.5) / (3 + 0.5) + 1) = log(7.5/3.5 + 1) = log(3.143) ≈ 1.145
        const reactIdf = calculateIdf("react", stats);
        expect(reactIdf).toBeCloseTo(Math.log((10 - 3 + 0.5) / (3 + 0.5) + 1), 5);

        // For "hook": log((10 - 7 + 0.5) / (7 + 0.5) + 1) = log(3.5/7.5 + 1) = log(1.467) ≈ 0.383
        const hookIdf = calculateIdf("hook", stats);
        expect(hookIdf).toBeCloseTo(Math.log((10 - 7 + 0.5) / (7 + 0.5) + 1), 5);
    });

    it("returns positive IDF for term not in corpus", () => {
        const stats = {
            totalDocs: 10,
            avgDocLength: 5,
            docFrequency: {},
        };

        // Term not in corpus: log((N + 0.5) / 0.5 + 1)
        const unknownIdf = calculateIdf("unknown", stats);
        expect(unknownIdf).toBeGreaterThan(0);
        expect(unknownIdf).toBeCloseTo(Math.log((10 + 0.5) / 0.5 + 1), 5);
    });

    it("IDF decreases as document frequency increases", () => {
        const stats = {
            totalDocs: 100,
            avgDocLength: 10,
            docFrequency: { rare: 2, common: 50, ubiquitous: 99 },
        };

        const rareIdf = calculateIdf("rare", stats);
        const commonIdf = calculateIdf("common", stats);
        const ubiquitousIdf = calculateIdf("ubiquitous", stats);

        expect(rareIdf).toBeGreaterThan(commonIdf);
        expect(commonIdf).toBeGreaterThan(ubiquitousIdf);
        expect(ubiquitousIdf).toBeGreaterThan(0); // Still positive
    });
});

describe("createBM25Scorer", () => {
    it("scores document with matching terms", () => {
        const sentences = [
            createSentence("React hooks are powerful", ["react", "hook", "power"], 0),
            createSentence("Another sentence here", ["anoth", "sentenc", "here"], 1),
        ];

        const scorer = createBM25Scorer(sentences);
        const score = scorer.score(["react", "hook"], ["react", "hook", "power"]);

        expect(score).toBeGreaterThan(0);
    });

    it("returns zero for document with no matching terms", () => {
        const sentences = [
            createSentence("React hooks are powerful", ["react", "hook", "power"], 0),
        ];

        const scorer = createBM25Scorer(sentences);
        const score = scorer.score(["python", "django"], ["react", "hook", "power"]);

        expect(score).toBe(0);
    });

    it("handles empty document", () => {
        const sentences = [
            createSentence("Some content", ["some", "content"], 0),
        ];

        const scorer = createBM25Scorer(sentences);
        const score = scorer.score(["test"], []);

        expect(score).toBe(0);
    });

    it("handles empty query", () => {
        const sentences = [
            createSentence("Some content", ["some", "content"], 0),
        ];

        const scorer = createBM25Scorer(sentences);
        const score = scorer.score([], ["some", "content"]);

        expect(score).toBe(0);
    });

    it("scores higher for more term matches", () => {
        const sentences = [
            createSentence("React hooks useState useEffect", ["react", "hook", "usestat", "useeffect"], 0),
            createSentence("Vue composition API", ["vue", "composit", "api"], 1),
        ];

        const scorer = createBM25Scorer(sentences);

        const oneMatch = scorer.score(["react"], ["react", "hook", "usestat", "useeffect"]);
        const twoMatches = scorer.score(["react", "hook"], ["react", "hook", "usestat", "useeffect"]);

        expect(twoMatches).toBeGreaterThan(oneMatch);
    });

    it("length normalization affects scores correctly", () => {
        // Longer documents should have slightly lower scores for same term frequency
        const sentences = [
            createSentence("Short", ["hook"], 0), // avgDocLength = 3
            createSentence("Medium length", ["other", "term"], 1),
            createSentence("Much longer sentence with more", ["yet", "more", "token", "here", "now"], 2),
        ];

        const scorer = createBM25Scorer(sentences);

        // Score a short doc vs a hypothetically longer doc with same term
        const shortDoc = scorer.score(["hook"], ["hook"]);
        const longDoc = scorer.score(["hook"], ["hook", "extra", "padding", "words", "here"]);

        // Short doc should score higher due to b=0.75 length normalization
        expect(shortDoc).toBeGreaterThan(longDoc);
    });

    it("respects custom k1 and b parameters", () => {
        // Need multiple sentences with different lengths for b parameter to matter
        const sentences = [
            createSentence("Test content", ["test", "content"], 0),
            createSentence("Another sentence with more tokens here", ["anoth", "sentenc", "more", "token", "here"], 1),
            createSentence("Short", ["short"], 2),
        ];

        const defaultScorer = createBM25Scorer(sentences); // k1=1.5, b=0.75
        const customScorer = createBM25Scorer(sentences, { k1: 2.0, b: 0.0 }); // b=0 disables length norm

        // Score a document whose length differs from avgDocLength
        const shortDoc = ["test"];
        const defaultScore = defaultScorer.score(["test"], shortDoc);
        const customScore = customScorer.score(["test"], shortDoc);

        // With b=0 vs b=0.75, scores should differ due to length normalization
        expect(Math.abs(defaultScore - customScore)).toBeGreaterThan(0.001);
    });

    it("handles duplicate query terms", () => {
        const sentences = [
            createSentence("React hooks", ["react", "hook"], 0),
        ];

        const scorer = createBM25Scorer(sentences);

        // Query with duplicate terms: should each occurrence add to the score
        const singleTerm = scorer.score(["react"], ["react", "hook"]);
        const duplicateTerm = scorer.score(["react", "react"], ["react", "hook"]);

        // Duplicate query terms should increase score (each adds its IDF contribution)
        expect(duplicateTerm).toBeGreaterThan(singleTerm);
    });
});

describe("scoreSentences", () => {
    it("scores all sentences and returns map", () => {
        const sentences = [
            createSentence("React hooks introduction", ["react", "hook", "introduct"], 0),
            createSentence("How to use useState", ["use", "usestat"], 1),
            createSentence("The useEffect hook", ["useeffect", "hook"], 2),
        ];

        const scores = scoreSentences(sentences, ["hook"]);

        expect(scores.size).toBe(3);
        expect(scores.has(0)).toBe(true);
        expect(scores.has(1)).toBe(true);
        expect(scores.has(2)).toBe(true);
    });

    it("sentences with query terms score higher", () => {
        const sentences = [
            createSentence("Contains the hook term", ["contain", "hook", "term"], 0),
            createSentence("No matching words here", ["match", "word", "here"], 1),
        ];

        const scores = scoreSentences(sentences, ["hook"]);

        expect(scores.get(0)).toBeGreaterThan(0);
        expect(scores.get(1)).toBe(0);
    });

    it("handles empty query", () => {
        const sentences = [
            createSentence("Some content", ["some", "content"], 0),
        ];

        const scores = scoreSentences(sentences, []);

        expect(scores.get(0)).toBe(0);
    });

    it("handles empty sentences array", () => {
        const scores = scoreSentences([], ["hook"]);

        expect(scores.size).toBe(0);
    });
});

describe("BM25 formula verification", () => {
    it("produces expected score for known inputs", () => {
        // Hand-calculate expected BM25 score:
        // Corpus: 3 sentences, "hook" appears in 2 of them
        // Query: ["hook"]
        // Doc: ["hook"] (length 1)
        //
        // IDF("hook") = log((3 - 2 + 0.5) / (2 + 0.5) + 1) = log(1.5/2.5 + 1) = log(1.6) ≈ 0.47
        //
        // tf = 1, dl = 1, avgdl = (3+4+3)/3 = 3.33
        // termScore = IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl/avgdl)))
        //           = 0.47 * (1 * 2.5) / (1 + 1.5 * (1 - 0.75 + 0.75 * (1/3.33)))
        //           = 0.47 * 2.5 / (1 + 1.5 * (0.25 + 0.225))
        //           = 0.47 * 2.5 / (1 + 1.5 * 0.475)
        //           = 0.47 * 2.5 / (1 + 0.7125)
        //           = 0.47 * 2.5 / 1.7125
        //           ≈ 0.686

        const sentences = [
            createSentence("React hooks are great", ["react", "hook", "great"], 0),
            createSentence("Hooks let you use state", ["hook", "let", "use", "state"], 1),
            createSentence("State management is easy", ["state", "manag", "easi"], 2),
        ];

        const scorer = createBM25Scorer(sentences);
        const score = scorer.score(["hook"], ["hook"]);

        // Calculate expected values
        const N = 3;
        const df = 2;
        const expectedIdf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

        const tf = 1;
        const dl = 1;
        const avgdl = 10 / 3; // (3 + 4 + 3) / 3
        const k1 = 1.5;
        const b = 0.75;

        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (dl / avgdl));
        const expectedScore = expectedIdf * (numerator / denominator);

        expect(score).toBeCloseTo(expectedScore, 5);
    });

    it("term frequency saturation works correctly", () => {
        // Higher tf should increase score but with diminishing returns
        const sentences = [
            createSentence("hook", ["hook"], 0),
            createSentence("hook hook", ["hook", "hook"], 1),
            createSentence("hook hook hook hook hook", ["hook", "hook", "hook", "hook", "hook"], 2),
        ];

        const scorer = createBM25Scorer(sentences);

        const tf1 = scorer.score(["hook"], ["hook"]);
        const tf2 = scorer.score(["hook"], ["hook", "hook"]);
        const tf5 = scorer.score(["hook"], ["hook", "hook", "hook", "hook", "hook"]);

        // Scores should increase with tf
        expect(tf2).toBeGreaterThan(tf1);
        expect(tf5).toBeGreaterThan(tf2);

        // But with diminishing returns (tf5/tf2 < tf2/tf1)
        const ratio1to2 = tf2 / tf1;
        const ratio2to5 = tf5 / tf2;
        expect(ratio2to5).toBeLessThan(ratio1to2);
    });
});
