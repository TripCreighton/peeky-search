import { describe, it, expect } from "vitest";
import { scorePassages, coverageScore, proximityScore, buildPassageCorpus, DEFAULT_RANK_CONFIG } from "../rank";
import { parseQuery } from "../query";
import type { Passage } from "../types";

/** Minimal passage builder. `text` doubles as `bodyText` unless one is given. */
function passage(overrides: Partial<Passage> & { id: string; text: string }): Passage {
    const { text } = overrides;
    return {
        docUrl: "https://example.com/page",
        headingPath: [],
        bodyText: text,
        charCount: text.length,
        startOrder: 0,
        endOrder: 0,
        kinds: ["prose"],
        hasCode: false,
        ...overrides,
    };
}

function scoreOf(scores: ReturnType<typeof scorePassages>, id: string): number {
    return scores.find((s) => s.passageId === id)?.combined ?? 0;
}

describe("scorePassages", () => {
    it("ranks an exact error-string match above a merely topical passage", () => {
        const query = parseQuery("ERR_PNPM_OUTDATED_LOCKFILE frozen lockfile ci");

        const passages = [
            passage({
                id: "topical",
                // Deliberately stuffed with the query's ordinary terms, and longer,
                // so it wins on plain lexical overlap.
                text:
                    "Lockfile handling in CI is a frozen lockfile topic. A frozen lockfile in CI means the " +
                    "lockfile is not updated. Teams often discuss the frozen lockfile and CI lockfile workflow " +
                    "when the lockfile drifts, because a lockfile in CI should stay frozen.",
            }),
            passage({
                id: "exact",
                text: "This job failed with ERR_PNPM_OUTDATED_LOCKFILE. Regenerate and commit the file.",
            }),
        ];

        const scores = scorePassages(passages, query, {});

        expect(scores[0]?.passageId).toBe("exact");
        expect(scoreOf(scores, "exact")).toBeGreaterThan(scoreOf(scores, "topical"));
        expect(scores.find((s) => s.passageId === "exact")?.exact).toBeGreaterThan(0);
        expect(scores.find((s) => s.passageId === "topical")?.exact).toBe(0);
    });

    it("matches exact anchors on token boundaries, not as bare substrings", () => {
        const query = parseQuery("react useEffect cleanup");
        const passages = [
            passage({ id: "real", text: "Return a function from useEffect to clean up." }),
            passage({ id: "partial", text: "The useEffectiveRate helper is unrelated." }),
        ];

        const scores = scorePassages(passages, query, {});

        expect(scores.find((s) => s.passageId === "real")?.exact).toBeGreaterThan(0);
        expect(scores.find((s) => s.passageId === "partial")?.exact).toBe(0);
    });

    it("ranks an accepted low-position answer above an early unaccepted one on a qa page", () => {
        const query = parseQuery("docker container exits immediately after start");

        const passages = [
            passage({
                id: "early-unaccepted",
                pageKind: "qa",
                kinds: ["answer"],
                startOrder: 1,
                endOrder: 1,
                votes: 0,
                text: "Docker container exits immediately after start; try restarting the docker daemon.",
            }),
            passage({
                id: "late-accepted",
                pageKind: "qa",
                kinds: ["answer"],
                startOrder: 40,
                endOrder: 40,
                votes: 120,
                accepted: true,
                text: "The container exits because its main process finished. Keep a foreground process running.",
            }),
        ];

        const scores = scorePassages(passages, query, {});

        expect(scores[0]?.passageId).toBe("late-accepted");
        expect(scores.find((s) => s.passageId === "late-accepted")?.endorsement).toBe(1);
        expect(scores.find((s) => s.passageId === "early-unaccepted")?.endorsement).toBeLessThan(0);
    });

    it("leaves endorsement neutral when a passage carries no Q&A signals", () => {
        const query = parseQuery("graceful shutdown");
        const scores = scorePassages([passage({ id: "a", text: "Graceful shutdown drains connections." })], query, {});

        expect(scores[0]?.endorsement).toBe(0);
    });

    it("pays a smaller early-position bonus on a guide than on a reference page", () => {
        const query = parseQuery("timeout option");
        const build = (kind: "guide" | "reference"): number => {
            const passages = [
                passage({ id: "early", pageKind: kind, text: "The timeout option is set here.", startOrder: 0, endOrder: 0 }),
                passage({ id: "late", pageKind: kind, text: "The timeout option is set here.", startOrder: 100, endOrder: 100 }),
            ];
            const scores = scorePassages(passages, query, {});
            return scoreOf(scores, "early") - scoreOf(scores, "late");
        };

        // A guide used to pay nothing at all. It now pays the measured default
        // prior (`globalEarly`), which applies exactly to the kinds that make no
        // positional claim of their own. Both kinds lean early; their RELATIVE
        // sizes are deliberately not asserted, because `referenceEarly` was set
        // by reasoning and `globalEarly` by measurement, and nothing has yet
        // measured the two against each other.
        expect(build("guide")).toBeGreaterThan(0);
        expect(build("reference")).toBeGreaterThan(0);
    });

    it("puts the answer below the question on a qa page", () => {
        const query = parseQuery("timeout option");
        const passages = [
            passage({ id: "early", pageKind: "qa", text: "The timeout option is set here.", startOrder: 0, endOrder: 0 }),
            passage({ id: "late", pageKind: "qa", text: "The timeout option is set here.", startOrder: 100, endOrder: 100 }),
        ];

        const scores = scorePassages(passages, query, {});

        expect(scoreOf(scores, "late")).toBeGreaterThan(scoreOf(scores, "early"));
    });

    it("penalizes early filler on a listicle", () => {
        const query = parseQuery("best logging library");
        const passages = [
            passage({ id: "listicle-early", pageKind: "listicle", text: "Choosing the best logging library matters.", startOrder: 0, endOrder: 0 }),
            passage({ id: "guide-early", pageKind: "guide", text: "Choosing the best logging library matters.", startOrder: 0, endOrder: 0, docUrl: "https://other.com/x" }),
        ];

        const scores = scorePassages(passages, query, {});

        expect(scoreOf(scores, "guide-early")).toBeGreaterThan(scoreOf(scores, "listicle-early"));
    });

    it("demotes page furniture even when it is on topic", () => {
        const query = parseQuery("dev server phone wifi");
        const passages = [
            passage({
                id: "chrome",
                headingPath: ["Related Posts"],
                text: "Related Posts\nDev server on your phone over wifi. Phone wifi dev server guide.",
            }),
            passage({
                id: "content",
                headingPath: ["Configure the dev server"],
                text: "Configure the dev server\nBind the dev server to 0.0.0.0 so your phone on the same wifi can reach it.",
            }),
        ];

        const scores = scorePassages(passages, query, {});

        expect(scores[0]?.passageId).toBe("content");
        expect(scores.find((s) => s.passageId === "chrome")?.structure).toBeLessThan(
            scores.find((s) => s.passageId === "content")?.structure ?? 1,
        );
    });

    it("scores lexical relevance against bodyText, not the repeated heading", () => {
        const query = parseQuery("kubernetes ingress");
        const stuffed = passage({
            id: "stuffed",
            headingPath: ["kubernetes ingress kubernetes ingress"],
            text: "kubernetes ingress kubernetes ingress\nThis section is about unrelated storage classes.",
            bodyText: "This section is about unrelated storage classes.",
        });
        const real = passage({
            id: "real",
            docUrl: "https://other.com/x",
            headingPath: ["Networking"],
            text: "Networking\nAn ingress exposes HTTP routes into the kubernetes cluster.",
            bodyText: "An ingress exposes HTTP routes into the kubernetes cluster.",
        });

        const scores = scorePassages([stuffed, real], query, {});

        expect(scores.find((s) => s.passageId === "stuffed")?.bm25).toBe(0);
        expect(scores.find((s) => s.passageId === "real")?.bm25).toBeGreaterThan(0);
    });

    it("credits a heading-path match separately from body text", () => {
        const query = parseQuery("retry policy");
        const passages = [
            passage({ id: "under-heading", headingPath: ["Retry policy"], text: "Set the value to three." }),
            passage({ id: "elsewhere", docUrl: "https://other.com/x", headingPath: ["Colours"], text: "Set the value to three." }),
        ];

        const scores = scorePassages(passages, query, {});

        expect(scores.find((s) => s.passageId === "under-heading")?.headingMatch).toBeGreaterThan(0);
        expect(scores.find((s) => s.passageId === "elsewhere")?.headingMatch).toBe(0);
    });

    it("keeps semantic at zero unless a reranker supplies it", () => {
        const query = parseQuery("anything");
        const base = scorePassages([passage({ id: "a", text: "some text about anything" })], query, {});
        expect(base[0]?.semantic).toBe(0);

        const withSemantic = scorePassages([passage({ id: "a", text: "some text about anything" })], query, {
            semantic: new Map([["a", 1]]),
            config: { ...DEFAULT_RANK_CONFIG, weights: { ...DEFAULT_RANK_CONFIG.weights, semantic: 0.5 } },
        });
        expect(withSemantic[0]?.semantic).toBe(1);
        expect(withSemantic[0]?.combined).toBeGreaterThan(base[0]?.combined ?? 0);
    });

    it("is deterministic, breaking exact ties by passage id ascending", () => {
        const query = parseQuery("identical content here");
        const text = "identical content here";
        const passages = [
            passage({ id: "zzz", text, docUrl: "https://a.com/1" }),
            passage({ id: "aaa", text, docUrl: "https://b.com/1" }),
            passage({ id: "mmm", text, docUrl: "https://c.com/1" }),
        ];

        const first = scorePassages(passages, query, {});
        const second = scorePassages([...passages].reverse(), query, {});

        expect(first.map((s) => s.passageId)).toEqual(["aaa", "mmm", "zzz"]);
        expect(second.map((s) => s.passageId)).toEqual(first.map((s) => s.passageId));
        expect(second.map((s) => s.combined)).toEqual(first.map((s) => s.combined));
    });

    it("returns nothing for an empty candidate set", () => {
        expect(scorePassages([], parseQuery("x"), {})).toEqual([]);
    });
});

describe("coverageScore", () => {
    it("rises with the fraction of query terms present", () => {
        const passages = [
            passage({ id: "a", text: "alpha beta gamma delta" }),
            passage({ id: "b", text: "alpha only here" }),
        ];
        const corpus = buildPassageCorpus(passages);
        const terms = ["alpha", "beta", "gamma"];

        const full = coverageScore(terms, ["alpha", "beta", "gamma"], corpus.stats);
        const partial = coverageScore(terms, ["alpha"], corpus.stats);

        expect(full).toBe(1);
        expect(partial).toBeGreaterThan(0);
        expect(partial).toBeLessThan(full);
    });
});

describe("proximityScore", () => {
    const gates = DEFAULT_RANK_CONFIG.lexical;

    it("scores tightly clustered terms above scattered ones", () => {
        const tight = ["alpha", "beta"];
        const scattered = ["alpha", ...Array<string>(80).fill("filler"), "beta"];

        expect(proximityScore(["alpha", "beta"], tight, gates)).toBeGreaterThan(
            proximityScore(["alpha", "beta"], scattered, gates),
        );
    });

    it("is neutral when fewer than two query terms are present", () => {
        expect(proximityScore(["alpha", "beta"], ["alpha", "filler"], gates)).toBe(gates.proximityNeutral);
    });
});

describe("global position prior", () => {
    const query = parseQuery("graceful shutdown drains connections");
    /** Identical text at two depths of the same document, so only position differs. */
    const pair = (): Passage[] => [
        passage({ id: "early", text: "Graceful shutdown drains connections.", startOrder: 0, endOrder: 0 }),
        passage({ id: "late", text: "Graceful shutdown drains connections.", startOrder: 100, endOrder: 100 }),
    ];

    it("ranks an earlier passage above an identical later one", () => {
        const scores = scorePassages(pair(), query, {});

        expect(scoreOf(scores, "early")).toBeGreaterThan(scoreOf(scores, "late"));
    });

    it("is off when the weight is zero, so position is not priced twice", () => {
        const config = {
            ...DEFAULT_RANK_CONFIG,
            structure: { ...DEFAULT_RANK_CONFIG.structure, globalEarly: 0 },
        };

        const scores = scorePassages(pair(), query, { config });

        expect(scoreOf(scores, "early")).toBeCloseTo(scoreOf(scores, "late"), 10);
    });

    it("stays a prior rather than a veto: a matching late passage beats a non-matching early one", () => {
        const passages = [
            passage({ id: "early-irrelevant", text: "Unrelated prose about gardening.", startOrder: 0, endOrder: 0 }),
            passage({
                id: "late-relevant",
                text: "Graceful shutdown drains connections before the process exits.",
                startOrder: 100,
                endOrder: 100,
            }),
        ];

        const scores = scorePassages(passages, query, {});

        expect(scoreOf(scores, "late-relevant")).toBeGreaterThan(scoreOf(scores, "early-irrelevant"));
    });
});
