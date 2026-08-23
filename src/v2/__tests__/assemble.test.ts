import { describe, it, expect } from "vitest";
import {
    assemble,
    finalScore,
    tokenWeights,
    noveltyFraction,
    marginalUtility,
    DEFAULT_ASSEMBLE_BUDGET,
    type RankedPassage,
} from "../assemble";
import type { Authority, Passage, PassageScore } from "../types";

function score(passageId: string, combined: number): PassageScore {
    return { passageId, bm25: combined, exact: 0, headingMatch: 0, structure: 0.5, endorsement: 0, semantic: 0, combined };
}

function authority(value: number, canonical = false): Authority {
    return { score: value, canonical, reasons: ["test"] };
}

interface EntryOptions {
    id: string;
    docUrl?: string;
    combined?: number;
    text?: string;
    chars?: number;
    authority?: number;
}

function entry(options: EntryOptions): RankedPassage {
    const chars = options.chars ?? 500;
    // Filler is derived from the id so that distinct entries have distinct token
    // sets. Sharing filler would make every pair a novelty duplicate and quietly
    // turn the other assertions into tests of the deduplicator.
    const text = options.text ?? `${options.id}filler `.repeat(Math.max(1, Math.floor(chars / 12)));
    const passage: Passage = {
        id: options.id,
        docUrl: options.docUrl ?? "https://a.example/1",
        headingPath: [],
        text,
        bodyText: text,
        charCount: chars,
        startOrder: 0,
        endOrder: 0,
        kinds: ["prose"],
        hasCode: false,
    };
    return {
        passage,
        score: score(options.id, options.combined ?? 0.5),
        authority: authority(options.authority ?? 0.5),
    };
}

describe("assemble", () => {
    it("never exceeds the character budget", () => {
        const entries = Array.from({ length: 20 }, (_, i) =>
            entry({ id: `p${i}`, docUrl: `https://d${i}.example/1`, chars: 800, combined: 0.9 - i * 0.01 }),
        );

        const selected = assemble(entries, { totalChars: 2000, maxDocs: 20 });
        const total = selected.reduce((sum, p) => sum + p.charCount, 0);

        expect(total).toBeLessThanOrEqual(2000);
        expect(selected.length).toBeGreaterThan(0);
    });

    it("caps passages per document so one page cannot eat the budget", () => {
        const entries = [
            ...Array.from({ length: 8 }, (_, i) =>
                entry({ id: `hog${i}`, docUrl: "https://hog.example/1", chars: 300, combined: 0.9 - i * 0.001 }),
            ),
            entry({ id: "rival", docUrl: "https://rival.example/1", chars: 300, combined: 0.4 }),
        ];

        const selected = assemble(entries, { totalChars: 6000, maxPassagesPerDoc: 2, maxCharsPerDoc: 6000 });
        const fromHog = selected.filter((p) => p.docUrl === "https://hog.example/1");

        expect(fromHog).toHaveLength(2);
        expect(selected.some((p) => p.docUrl === "https://rival.example/1")).toBe(true);
    });

    it("caps characters per document independently of the passage count", () => {
        const entries = [
            entry({ id: "big1", docUrl: "https://hog.example/1", chars: 1500, combined: 0.9 }),
            entry({ id: "big2", docUrl: "https://hog.example/1", chars: 1500, combined: 0.89 }),
            entry({ id: "big3", docUrl: "https://hog.example/1", chars: 1500, combined: 0.88 }),
            entry({ id: "rival", docUrl: "https://rival.example/1", chars: 500, combined: 0.5 }),
        ];

        const selected = assemble(entries, { totalChars: 6000, maxPassagesPerDoc: 3, maxCharsPerDoc: 2000 });
        const hogChars = selected
            .filter((p) => p.docUrl === "https://hog.example/1")
            .reduce((sum, p) => sum + p.charCount, 0);

        expect(hogChars).toBeLessThanOrEqual(2000);
    });

    it("limits how many distinct documents are represented", () => {
        const entries = Array.from({ length: 10 }, (_, i) =>
            entry({ id: `p${i}`, docUrl: `https://d${i}.example/1`, chars: 200, combined: 0.9 - i * 0.01 }),
        );

        const selected = assemble(entries, { totalChars: 6000, maxDocs: 3 });
        const docs = new Set(selected.map((p) => p.docUrl));

        expect(docs.size).toBe(3);
    });

    it("skips a passage whose content duplicates one already selected", () => {
        const shared = "the quick brown fox jumps over the lazy dog and then keeps running through the field";
        const entries = [
            entry({ id: "first", docUrl: "https://a.example/1", text: shared, chars: shared.length, combined: 0.9 }),
            entry({ id: "dup", docUrl: "https://b.example/1", text: shared, chars: shared.length, combined: 0.8 }),
            entry({
                id: "novel",
                docUrl: "https://c.example/1",
                text: "entirely different material concerning kubernetes ingress controllers and certificates",
                chars: 85,
                combined: 0.7,
            }),
        ];

        const selected = assemble(entries, { totalChars: 6000 });

        expect(selected.map((p) => p.id)).toEqual(["first", "novel"]);
    });

    it("skips mirrored content that differs only in whitespace and case", () => {
        const text = "Bind the dev server to 0.0.0.0 so another device on the network can reach it directly.";
        const entries = [
            entry({ id: "first", docUrl: "https://a.example/1", text, chars: text.length, combined: 0.9 }),
            entry({
                id: "mirror",
                docUrl: "https://b.example/1",
                text: `  BIND the DEV   server to 0.0.0.0 so another device on the\nnetwork can reach it directly. `,
                chars: text.length,
                combined: 0.85,
            }),
        ];

        const selected = assemble(entries, { totalChars: 6000 });

        expect(selected).toHaveLength(1);
        expect(selected[0]?.id).toBe("first");
    });

    it("stops at the relevance floor rather than padding to fill the budget", () => {
        const entries = [
            entry({ id: "strong", docUrl: "https://a.example/1", chars: 300, combined: 1 }),
            entry({ id: "weak", docUrl: "https://b.example/1", chars: 300, combined: 0.05 }),
        ];

        const selected = assemble(entries, { totalChars: 6000, relevanceFloor: 0.35 });

        expect(selected.map((p) => p.id)).toEqual(["strong"]);
    });

    it("orders across documents by authority-weighted relevance", () => {
        const entries = [
            entry({ id: "farm", docUrl: "https://farm.example/1", chars: 300, combined: 0.6, authority: 0.2 }),
            entry({ id: "official", docUrl: "https://docs.example/1", chars: 300, combined: 0.5, authority: 0.95 }),
        ];

        const selected = assemble(entries, { totalChars: 6000 });

        expect(selected[0]?.id).toBe("official");
        // Still returned, not suppressed: a low-authority page can be correct.
        expect(selected.map((p) => p.id)).toContain("farm");
    });

    it("damps but does not drop a passage from an extremely low-authority source", () => {
        const low = entry({ id: "low", chars: 300, combined: 0.5, authority: 0.05 });
        const neutral = entry({ id: "neutral", chars: 300, combined: 0.5, authority: 0.5 });

        expect(finalScore(low, DEFAULT_ASSEMBLE_BUDGET)).toBeGreaterThan(0);
        expect(finalScore(low, DEFAULT_ASSEMBLE_BUDGET)).toBeLessThan(finalScore(neutral, DEFAULT_ASSEMBLE_BUDGET));
    });

    it("drops passages below the minimum useful length", () => {
        const entries = [
            entry({ id: "tiny", docUrl: "https://a.example/1", text: "short", chars: 5, combined: 1 }),
            entry({ id: "real", docUrl: "https://b.example/1", chars: 300, combined: 0.9 }),
        ];

        const selected = assemble(entries, { totalChars: 6000, minPassageChars: 60 });

        expect(selected.map((p) => p.id)).toEqual(["real"]);
    });

    it("is deterministic and independent of input order, breaking ties by passage id", () => {
        const entries = [
            entry({ id: "ccc", docUrl: "https://a.example/1", chars: 300, combined: 0.5 }),
            entry({ id: "aaa", docUrl: "https://b.example/1", chars: 300, combined: 0.5 }),
            entry({ id: "bbb", docUrl: "https://c.example/1", chars: 300, combined: 0.5 }),
        ];

        const forward = assemble(entries, { totalChars: 6000 }).map((p) => p.id);
        const reversed = assemble([...entries].reverse(), { totalChars: 6000 }).map((p) => p.id);

        expect(forward).toEqual(["aaa", "bbb", "ccc"]);
        expect(reversed).toEqual(forward);
    });

    it("returns nothing when given nothing", () => {
        expect(assemble([], { totalChars: 6000 })).toEqual([]);
    });
});

// =============================================================================
// Coverage-aware selection
// =============================================================================

describe("tokenWeights", () => {
    it("weights a token appearing everywhere below one appearing rarely", () => {
        const sets = [
            new Set(["topic", "alpha"]),
            new Set(["topic", "beta"]),
            new Set(["topic", "gamma"]),
            new Set(["topic", "delta"]),
        ];

        const weights = tokenWeights(sets);

        expect(weights.get("alpha")).toBeGreaterThan(weights.get("topic") ?? 0);
    });

    it("assigns no weight to a token that never appears", () => {
        const weights = tokenWeights([new Set(["a"])]);

        expect(weights.has("absent")).toBe(false);
    });
});

describe("noveltyFraction", () => {
    const weights = new Map([
        ["shared", 1],
        ["fresh", 1],
    ]);

    it("is 1 for a passage whose every token is new", () => {
        expect(noveltyFraction(new Set(["fresh"]), new Set(["shared"]), weights)).toBe(1);
    });

    it("is 0 for a passage that repeats only what is already covered", () => {
        expect(noveltyFraction(new Set(["shared"]), new Set(["shared"]), weights)).toBe(0);
    });

    it("counts what a token is worth rather than how many tokens there are", () => {
        const skewed = new Map([
            ["common", 0.1],
            ["rare", 10],
        ]);

        const repeatsTheRareOne = noveltyFraction(new Set(["common", "rare"]), new Set(["rare"]), skewed);
        const repeatsTheCommonOne = noveltyFraction(new Set(["common", "rare"]), new Set(["common"]), skewed);

        expect(repeatsTheCommonOne).toBeGreaterThan(repeatsTheRareOne);
    });

    it("treats an empty passage as fully novel rather than dividing by zero", () => {
        expect(noveltyFraction(new Set(), new Set(["shared"]), weights)).toBe(1);
    });
});

describe("assemble: coverage-aware selection", () => {
    /** A passage whose token set is exactly the supplied words, padded to length. */
    function words(id: string, docUrl: string, vocabulary: string[], combined: number): RankedPassage {
        const text = vocabulary.join(" ").concat(" ").repeat(20);
        return {
            passage: {
                id,
                docUrl,
                headingPath: [],
                text,
                bodyText: text,
                charCount: 400,
                startOrder: 0,
                endOrder: 0,
                kinds: ["prose"],
                hasCode: false,
            },
            score: score(id, combined),
            authority: authority(0.5),
        };
    }

    it("prefers a passage that adds something over a better-matching restatement", () => {
        const entries = [
            words("best", "https://a.example/1", ["alpha", "bravo", "charlie", "delta"], 0.9),
            // Says the same things as `best` in a different order — a genuine
            // restatement rather than a byte-identical mirror — and scores
            // higher than the passage that has something new to say.
            words("echo", "https://b.example/1", ["delta", "charlie", "bravo", "alpha"], 0.8),
            // Says something none of the others say, and scores lower.
            words("novel", "https://c.example/1", ["echo", "foxtrot", "golf", "hotel"], 0.7),
        ];

        // The novelty threshold would already reject an exact restatement, so
        // the interesting comparison is with it relaxed: pure relevance order
        // takes `echo` second, coverage order takes `novel`.
        const options = { totalChars: 1200, maxDocs: 5, noveltyThreshold: 1.1 };
        const byRelevance = assemble(entries, { ...options, coverageWeight: 0 }).map((p) => p.id);
        const byCoverage = assemble(entries, { ...options, coverageWeight: 0.9 }).map((p) => p.id);

        expect(byRelevance).toEqual(["best", "echo", "novel"]);
        expect(byCoverage).toEqual(["best", "novel", "echo"]);
    });

    it("still refuses to select a passage below the relevance floor, however novel", () => {
        const entries = [
            words("strong", "https://a.example/1", ["alpha", "bravo"], 1),
            words("weak", "https://b.example/1", ["yankee", "zulu"], 0.05),
        ];

        const selected = assemble(entries, {
            totalChars: 6000,
            maxDocs: 5,
            coverageWeight: 1,
            relevanceFloor: 0.35,
        }).map((p) => p.id);

        // `weak` is maximally novel and would win every coverage comparison; the
        // floor runs off the undiscounted score precisely so that it cannot.
        expect(selected).toEqual(["strong"]);
    });

    it("is deterministic under input reordering", () => {
        const entries = [
            words("aaa", "https://a.example/1", ["alpha", "bravo"], 0.9),
            words("bbb", "https://b.example/1", ["charlie", "delta"], 0.9),
            words("ccc", "https://c.example/1", ["echo", "foxtrot"], 0.9),
        ];

        const forward = assemble(entries, { totalChars: 6000, maxDocs: 5 }).map((p) => p.id);
        const reversed = assemble([...entries].reverse(), { totalChars: 6000, maxDocs: 5 }).map((p) => p.id);

        expect(reversed).toEqual(forward);
    });

    it("honours every budget cap while reordering for coverage", () => {
        const entries = Array.from({ length: 12 }, (_, i) =>
            words(`p${i}`, `https://d${i % 3}.example/1`, [`w${i}`, `x${i}`, "topic"], 0.9 - i * 0.01),
        );

        const selected = assemble(entries, {
            totalChars: 1600,
            maxDocs: 2,
            maxPassagesPerDoc: 2,
            coverageWeight: 0.8,
        });

        const total = selected.reduce((sum, p) => sum + p.charCount, 0);
        const docs = new Set(selected.map((p) => p.docUrl));
        expect(total).toBeLessThanOrEqual(1600);
        expect(docs.size).toBeLessThanOrEqual(2);
        for (const doc of docs) {
            expect(selected.filter((p) => p.docUrl === doc).length).toBeLessThanOrEqual(2);
        }
    });
});

describe("marginalUtility", () => {
    it("ignores length when cost is not priced", () => {
        const settings = { ...DEFAULT_ASSEMBLE_BUDGET, costExponent: 0, coverageWeight: 0 };

        const short = marginalUtility(0.5, 1, 200, settings);
        const long = marginalUtility(0.5, 1, 2000, settings);

        expect(short).toBeCloseTo(long, 10);
    });

    it("prefers the cheaper of two equally-scoring passages once cost is priced", () => {
        const settings = {
            ...DEFAULT_ASSEMBLE_BUDGET,
            costExponent: 1,
            costReference: 1000,
            coverageWeight: 0,
        };

        const short = marginalUtility(0.5, 1, 500, settings);
        const long = marginalUtility(0.5, 1, 2000, settings);

        expect(short).toBeGreaterThan(long);
        // At exponent 1 the utility is exactly score per `costReference` chars.
        expect(short).toBeCloseTo(1.0, 10);
        expect(long).toBeCloseTo(0.25, 10);
    });

    it("still lets a stronger passage outbid a shorter weaker one", () => {
        const settings = { ...DEFAULT_ASSEMBLE_BUDGET, costExponent: 0.7, coverageWeight: 0 };

        const strongLong = marginalUtility(0.9, 1, 1200, settings);
        const weakShort = marginalUtility(0.2, 1, 600, settings);

        expect(strongLong).toBeGreaterThan(weakShort);
    });

    it("stays finite for a degenerate zero-length passage", () => {
        const settings = { ...DEFAULT_ASSEMBLE_BUDGET, costExponent: 1 };

        expect(Number.isFinite(marginalUtility(0.5, 1, 0, settings))).toBe(true);
    });

    it("discounts a passage that repeats what is already selected", () => {
        const settings = { ...DEFAULT_ASSEMBLE_BUDGET, costExponent: 0, coverageWeight: 1 };

        const novel = marginalUtility(0.5, 1, 800, settings);
        const redundant = marginalUtility(0.5, 0, 800, settings);

        expect(redundant).toBeLessThan(novel);
        expect(redundant).toBe(0);
    });
});

describe("assemble under a priced budget", () => {
    it("fits more passages into the same budget than an unpriced ordering", () => {
        // One long passage scoring marginally better than three short ones that
        // between them cost exactly the same. Unpriced ordering takes the long
        // one and has nothing left; priced ordering takes all three.
        const entries = [
            entry({ id: "long", docUrl: "https://a.example/1", chars: 1800, combined: 0.6 }),
            entry({ id: "s1", docUrl: "https://b.example/1", chars: 600, combined: 0.55 }),
            entry({ id: "s2", docUrl: "https://c.example/1", chars: 600, combined: 0.55 }),
            entry({ id: "s3", docUrl: "https://d.example/1", chars: 600, combined: 0.55 }),
        ];
        const budget = { totalChars: 1800, maxDocs: 8, relevanceFloor: 0.1, coverageWeight: 0 };

        const unpriced = assemble(entries, { ...budget, costExponent: 0 });
        const priced = assemble(entries, { ...budget, costExponent: 1 });

        expect(unpriced.map((p) => p.id)).toEqual(["long"]);
        expect([...priced.map((p) => p.id)].sort()).toEqual(["s1", "s2", "s3"]);
        expect(priced.reduce((sum, p) => sum + p.charCount, 0)).toBeLessThanOrEqual(1800);
    });

    it("keeps the floor on the undiscounted score, so cheapness cannot rescue an irrelevant passage", () => {
        const entries = [
            entry({ id: "strong", docUrl: "https://a.example/1", chars: 1500, combined: 0.9 }),
            entry({ id: "tiny-irrelevant", docUrl: "https://b.example/1", chars: 100, combined: 0.05 }),
        ];

        const selected = assemble(entries, {
            totalChars: 11000,
            maxDocs: 8,
            costExponent: 1,
            relevanceFloor: 0.35,
        });

        expect(selected.map((p) => p.id)).toEqual(["strong"]);
    });
});
