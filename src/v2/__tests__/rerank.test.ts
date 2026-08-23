/**
 * Reranker tests.
 *
 * Every one of these drives the stage through a STUB `PairScorer`. Nothing here
 * loads `@huggingface/transformers`, downloads a model, or touches the network
 * — which is the point of the seam being a function type rather than a class:
 * the model is an implementation of the contract, not the contract.
 */

import { describe, it, expect } from "vitest";
import {
    DEFAULT_RERANK_CONFIG,
    blendRankConfig,
    normalizeRerankScores,
    permuteOnto,
    rerankPassages,
    resolveRerankConfig,
    type PairScorer,
} from "../rerank";
import { DEFAULT_RANK_CONFIG } from "../rank";
import { searchV2, resolveConfig, type DocFetcher } from "../pipeline";
import type { Doc, DocNode, Passage, PassageScore } from "../types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function passage(id: string, text: string, overrides: Partial<Passage> = {}): Passage {
    return {
        id,
        docUrl: "https://a.example/1",
        headingPath: ["Section"],
        text,
        bodyText: text,
        charCount: text.length,
        startOrder: 0,
        endOrder: 0,
        kinds: ["prose"],
        hasCode: false,
        ...overrides,
    };
}

function score(passageId: string, combined: number): PassageScore {
    return {
        passageId,
        bm25: combined,
        exact: 0,
        headingMatch: 0,
        structure: 0,
        endorsement: 0,
        semantic: 0,
        combined,
    };
}

/** Scores by position in the passage list, so a test can dictate the reranked order exactly. */
function stubScorer(byText: Record<string, number>, fallback = 0): PairScorer {
    return async (_query, texts) => texts.map((text) => byText[text] ?? fallback);
}

// ---------------------------------------------------------------------------
// blendRankConfig
// ---------------------------------------------------------------------------

describe("blendRankConfig", () => {
    it("is the identity at weight 0", () => {
        const blended = blendRankConfig(DEFAULT_RANK_CONFIG, 0);

        expect(blended.weights).toEqual(DEFAULT_RANK_CONFIG.weights);
    });

    it("discards every lexical component at weight 1", () => {
        const blended = blendRankConfig(DEFAULT_RANK_CONFIG, 1);

        expect(blended.weights.semantic).toBe(1);
        expect(blended.weights.bm25).toBe(0);
        expect(blended.weights.exact).toBe(0);
        expect(blended.weights.endorsement).toBe(0);
    });

    it("keeps the lexical components in their original proportions", () => {
        const blended = blendRankConfig(DEFAULT_RANK_CONFIG, 0.5);
        const before = DEFAULT_RANK_CONFIG.weights.exact / DEFAULT_RANK_CONFIG.weights.bm25;

        expect(blended.weights.exact / blended.weights.bm25).toBeCloseTo(before, 10);
        expect(blended.weights.semantic).toBe(0.5);
    });

    it("clamps a weight outside 0-1", () => {
        expect(blendRankConfig(DEFAULT_RANK_CONFIG, -3).weights).toEqual(DEFAULT_RANK_CONFIG.weights);
        expect(blendRankConfig(DEFAULT_RANK_CONFIG, 42).weights.semantic).toBe(1);
    });

    it("leaves every non-weight setting untouched", () => {
        const blended = blendRankConfig(DEFAULT_RANK_CONFIG, 0.4);

        expect(blended.bm25).toEqual(DEFAULT_RANK_CONFIG.bm25);
        expect(blended.structure).toEqual(DEFAULT_RANK_CONFIG.structure);
        expect(blended.exact).toEqual(DEFAULT_RANK_CONFIG.exact);
    });
});

// ---------------------------------------------------------------------------
// normalizeRerankScores
// ---------------------------------------------------------------------------

describe("normalizeRerankScores", () => {
    it("min-max maps the extremes onto 0 and 1 and preserves order", () => {
        const out = normalizeRerankScores([-4, 2, 8], "minmax");

        expect(out[0]).toBeCloseTo(0, 10);
        expect(out[2]).toBeCloseTo(1, 10);
        expect(out[1]).toBeGreaterThan(out[0] ?? 0);
        expect(out[1]).toBeLessThan(out[2] ?? 1);
    });

    it("gives every candidate full credit when the model cannot separate them", () => {
        expect(normalizeRerankScores([3, 3, 3], "minmax")).toEqual([1, 1, 1]);
        expect(normalizeRerankScores([5], "minmax")).toEqual([1]);
    });

    it("sigmoid keeps absolute calibration inside 0-1", () => {
        const out = normalizeRerankScores([-10, 0, 10], "sigmoid");

        expect(out[0]).toBeLessThan(0.01);
        expect(out[1]).toBeCloseTo(0.5, 10);
        expect(out[2]).toBeGreaterThan(0.99);
    });

    it("handles an empty set", () => {
        expect(normalizeRerankScores([], "minmax")).toEqual([]);
        expect(normalizeRerankScores([], "sigmoid")).toEqual([]);
        expect(normalizeRerankScores([], "permute")).toEqual([]);
    });
});

describe("permuteOnto", () => {
    it("hands the largest value to the highest-scoring slot", () => {
        expect(permuteOnto([1, 9, 5], [0.1, 0.2, 0.3])).toEqual([0.1, 0.3, 0.2]);
    });

    it("is the identity when the scorer cannot separate anything", () => {
        const values = [0.9, 0.5, 0.2, 0.05];

        expect(permuteOnto([0, 0, 0, 0], values)).toEqual(values);
    });

    it("preserves the multiset of values exactly", () => {
        const values = [0.31, 0.07, 0.94, 0.55];
        const out = permuteOnto([2, -7, 3, 0], values);

        expect([...out].sort()).toEqual([...values].sort());
    });
});

// ---------------------------------------------------------------------------
// resolveRerankConfig
// ---------------------------------------------------------------------------

describe("resolveRerankConfig", () => {
    it("is null when nothing is configured", () => {
        expect(resolveRerankConfig(undefined)).toBeNull();
    });

    it("is null when knobs are set but no scorer is supplied", () => {
        expect(resolveRerankConfig({ topK: 20, weight: 0.5 })).toBeNull();
    });

    it("drops the non-serializable fields so a run file stays plain JSON", () => {
        const resolved = resolveRerankConfig({ scorer: stubScorer({}), onTiming: () => {}, topK: 20 });

        expect(resolved).not.toBeNull();
        expect(JSON.parse(JSON.stringify(resolved))).toEqual(resolved);
        expect(resolved).toEqual({ ...DEFAULT_RERANK_CONFIG, topK: 20 });
    });
});

// ---------------------------------------------------------------------------
// rerankPassages
// ---------------------------------------------------------------------------

describe("rerankPassages", () => {
    const passages = [passage("a", "alpha"), passage("b", "bravo"), passage("c", "charlie")];
    const firstStage = [score("c", 0.9), score("a", 0.5), score("b", 0.1)];

    it("scores only the first stage's top K, in first-stage order", async () => {
        const seen: string[][] = [];
        const scorer: PairScorer = async (_q, texts) => {
            seen.push(texts);
            return texts.map(() => 1);
        };

        const result = await rerankPassages("q", passages, firstStage, scorer, {
            ...DEFAULT_RERANK_CONFIG,
            topK: 2,
        });

        expect(seen).toEqual([["charlie", "alpha"]]);
        expect([...result.semantic.keys()].sort()).toEqual(["a", "c"]);
        expect(result.timing.pairs).toBe(2);
    });

    it("leaves passages outside the top K absent rather than neutral", async () => {
        const result = await rerankPassages("q", passages, firstStage, stubScorer({}), {
            ...DEFAULT_RERANK_CONFIG,
            topK: 1,
        });

        expect(result.semantic.has("b")).toBe(false);
        expect(result.semantic.has("a")).toBe(false);
    });

    it("normalizes the model's raw output onto 0-1", async () => {
        const result = await rerankPassages(
            "q",
            passages,
            firstStage,
            stubScorer({ charlie: -8, alpha: 0, bravo: 11 }),
            DEFAULT_RERANK_CONFIG,
        );

        expect(result.semantic.get("c")).toBeCloseTo(0, 10);
        expect(result.semantic.get("b")).toBeCloseTo(1, 10);
        expect(result.semantic.get("a")).toBeGreaterThan(0);
        expect(result.semantic.get("a")).toBeLessThan(1);
    });

    it("does nothing, and costs nothing, on an empty candidate set", async () => {
        let called = false;
        const result = await rerankPassages(
            "q",
            [],
            [],
            async (_q, texts) => {
                called = true;
                return texts.map(() => 0);
            },
            DEFAULT_RERANK_CONFIG,
        );

        expect(called).toBe(false);
        expect(result.semantic.size).toBe(0);
        expect(result.timing.pairs).toBe(0);
    });

    it("permute mode redistributes the first stage's own scores", async () => {
        const result = await rerankPassages(
            "q",
            passages,
            firstStage,
            stubScorer({ charlie: -1, alpha: 3, bravo: 0 }),
            { ...DEFAULT_RERANK_CONFIG, normalization: "permute", topK: 3, weight: 1 },
        );

        // First-stage values were c=0.9, a=0.5, b=0.1; the reranker ranks
        // a > b > c, so those same three values move onto a, b, c in that order.
        expect(result.semantic.get("a")).toBeCloseTo(0.9, 10);
        expect(result.semantic.get("b")).toBeCloseTo(0.5, 10);
        expect(result.semantic.get("c")).toBeCloseTo(0.1, 10);
    });

    it("permute mode with a constant scorer is the identity", async () => {
        const result = await rerankPassages("q", passages, firstStage, stubScorer({}, 0), {
            ...DEFAULT_RERANK_CONFIG,
            normalization: "permute",
            topK: 3,
            weight: 1,
        });

        expect(result.semantic.get("c")).toBeCloseTo(0.9, 10);
        expect(result.semantic.get("a")).toBeCloseTo(0.5, 10);
        expect(result.semantic.get("b")).toBeCloseTo(0.1, 10);
    });

    it("tolerates a scorer that returns fewer scores than it was given texts", async () => {
        const result = await rerankPassages("q", passages, firstStage, async () => [5], {
            ...DEFAULT_RERANK_CONFIG,
            topK: 3,
        });

        expect(result.semantic.size).toBe(3);
        for (const value of result.semantic.values()) {
            expect(Number.isFinite(value)).toBe(true);
        }
    });
});

// ---------------------------------------------------------------------------
// The pipeline seam
// ---------------------------------------------------------------------------

function node(text: string, order: number, overrides: Partial<DocNode> = {}): DocNode {
    return { kind: "prose", text, order, headingPath: [], ...overrides };
}

function testDoc(url: string): Doc {
    return {
        url,
        title: "Test document",
        kind: "guide",
        source: "html",
        nodes: [
            node("Configure the timeout", 0, { kind: "heading", level: 2 }),
            node(
                "Set the timeout option to control how long a request may run before it is aborted by the client library.",
                1,
                { headingPath: ["Configure the timeout"] },
            ),
            node(
                "The default timeout is thirty seconds and applies to the whole request rather than to each individual retry.",
                2,
                { headingPath: ["Configure the timeout"] },
            ),
            node("Unrelated background", 3, { kind: "heading", level: 2 }),
            node(
                "This section wanders through the history of the project and never states any configurable value at all.",
                4,
                { headingPath: ["Unrelated background"] },
            ),
        ],
    };
}

function fetcherFor(docs: Doc[]): DocFetcher {
    const byUrl = new Map(docs.map((d) => [d.url, d]));
    return async (url: string) => byUrl.get(url) ?? null;
}

describe("searchV2 reranking", () => {
    const urls = ["https://docs.example.com/guide/timeouts", "https://blog.example.net/posts/timeouts"];
    const docs = [testDoc(urls[0] ?? ""), testDoc(urls[1] ?? "")];

    it("is off by default", () => {
        expect(resolveConfig().rerank).toBeNull();
        expect(DEFAULT_RANK_CONFIG.weights.semantic).toBe(0);
    });

    it("stays off when knobs are set but no scorer is supplied", async () => {
        const withKnobs = await searchV2("timeout option default", urls, fetcherFor(docs), {
            rerank: { topK: 5, weight: 1 },
        });
        const plain = await searchV2("timeout option default", urls, fetcherFor(docs));

        expect(withKnobs.pages.map((p) => p.url)).toEqual(plain.pages.map((p) => p.url));
    });

    it("reproduces the baseline exactly at blend weight 0", async () => {
        const baseline = await searchV2("timeout option default", urls, fetcherFor(docs));
        const reranked = await searchV2("timeout option default", urls, fetcherFor(docs), {
            rerank: { scorer: stubScorer({}, 1), weight: 0 },
        });

        expect(reranked.pages.map((p) => p.excerpts.map((e) => e.text))).toEqual(
            baseline.pages.map((p) => p.excerpts.map((e) => e.text)),
        );
    });

    it("lets the reranker reorder what is returned", async () => {
        const baselineFirst = (
            await searchV2("timeout option default", urls, fetcherFor(docs))
        ).pages[0]?.excerpts[0]?.text;

        // Reward whichever passage the lexical ranker liked least.
        const reranked = await searchV2("timeout option default", urls, fetcherFor(docs), {
            rerank: {
                scorer: async (_q, texts) => texts.map((text) => (text.includes("wanders") ? 10 : -10)),
                weight: 1,
                topK: 50,
            },
        });

        expect(baselineFirst).toBeDefined();
        expect(reranked.pages[0]?.excerpts[0]?.text).toContain("wanders");
    });

    it("reports what it cost, per query", async () => {
        const timings: Array<{ pairs: number; ms: number }> = [];
        await searchV2("timeout option default", urls, fetcherFor(docs), {
            rerank: { scorer: stubScorer({}, 1), onTiming: (t) => timings.push(t) },
        });

        expect(timings).toHaveLength(1);
        expect(timings[0]?.pairs).toBeGreaterThan(0);
        expect(timings[0]?.ms).toBeGreaterThanOrEqual(0);
    });

    it("records only the serializable knobs in the resolved config", async () => {
        const resolved = resolveConfig({ rerank: { scorer: stubScorer({}), weight: 0.35 } });

        expect(resolved.rerank?.weight).toBe(0.35);
        expect(JSON.parse(JSON.stringify(resolved.rerank))).toEqual(resolved.rerank);
    });

    it("survives a candidate set smaller than topK", async () => {
        const result = await searchV2("timeout option default", [urls[0] ?? ""], fetcherFor(docs), {
            rerank: { scorer: stubScorer({}, 1), topK: 500 },
        });

        expect(result.pages.length).toBeGreaterThan(0);
    });
});
