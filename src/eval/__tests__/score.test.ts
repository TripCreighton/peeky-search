import { describe, it, expect } from "vitest";
import { scoreRun } from "../score";
import type {
    Nugget,
    Query,
    QueryLabel,
    Run,
    RunExcerpt,
    RunPage,
    RunQueryResult,
    SourceLabel,
} from "../types";

function createExcerpt(text: string, overrides: Partial<RunExcerpt> = {}): RunExcerpt {
    return { text, headingPath: [], score: 1, ...overrides };
}

function createPage(url: string, excerpts: RunExcerpt[], overrides: Partial<RunPage> = {}): RunPage {
    return {
        url,
        title: url,
        rank: 1,
        excerpts,
        charCount: excerpts.reduce((sum, e) => sum + e.text.length, 0),
        ...overrides,
    };
}

function createNugget(overrides: Partial<Nugget> = {}): Nugget {
    return { id: "n1", text: "a fact", anchors: [["alpha"]], ...overrides };
}

function createQuery(overrides: Partial<Query> = {}): Query {
    return {
        id: "q1",
        text: "some query",
        category: "how-to",
        difficulty: 1,
        ...overrides,
    };
}

function createLabel(overrides: Partial<QueryLabel> = {}): QueryLabel {
    return {
        queryId: "q1",
        nuggets: [],
        sources: [],
        labeledAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

function createSource(overrides: Partial<SourceLabel> = {}): SourceLabel {
    return { match: "example.com", grade: "good", ...overrides };
}

function createResult(overrides: Partial<RunQueryResult> = {}): RunQueryResult {
    return {
        queryId: "q1",
        pages: [],
        consideredUrls: [],
        totalChars: 0,
        durationMs: 0,
        ...overrides,
    };
}

function createRun(results: RunQueryResult[], overrides: Partial<Run> = {}): Run {
    return {
        id: "run1",
        pipeline: "v2",
        config: {},
        corpusRevision: "abc123",
        startedAt: "2026-01-01T00:00:00.000Z",
        results,
        ...overrides,
    };
}

describe("scoreRun", () => {
    describe("nuggetRecall", () => {
        it("computes a weighted recall over matched vs. total nugget weight", () => {
            const nuggets = [
                createNugget({ id: "n1", anchors: [["alpha"]], weight: 1 }),
                createNugget({ id: "n2", anchors: [["beta"]], weight: 3 }),
                createNugget({ id: "n3", anchors: [["gamma"]], weight: 2 }),
            ];
            const page = createPage("https://a.example", [
                createExcerpt("This excerpt mentions alpha and beta together."),
            ]);
            const label = createLabel({ nuggets });
            const run = createRun([createResult({ pages: [page], totalChars: 100 })]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            // matched weight = 1 (n1) + 3 (n2) = 4; total weight = 1 + 3 + 2 = 6
            expect(scoreboard.byQuery[0]?.nuggetRecall).toBeCloseTo(4 / 6, 10);
            expect(scoreboard.nuggetRecall).toBeCloseTo(4 / 6, 10);
            expect(scoreboard.byQuery[0]?.nuggetsFound.sort()).toEqual(["n1", "n2"]);
            expect(scoreboard.byQuery[0]?.nuggetsMissed).toEqual(["n3"]);
        });

        it("defaults a missing weight to 1", () => {
            const nuggets = [
                createNugget({ id: "n1", anchors: [["alpha"]] }), // weight defaults to 1, matches
                createNugget({ id: "n2", anchors: [["gamma"]], weight: 4 }), // does not match
            ];
            const page = createPage("https://a.example", [createExcerpt("alpha appears here.")]);
            const label = createLabel({ nuggets });
            const run = createRun([createResult({ pages: [page], totalChars: 100 })]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            // total weight = 1 + 4 = 5; matched weight = 1
            expect(scoreboard.byQuery[0]?.nuggetRecall).toBeCloseTo(1 / 5, 10);
        });
    });

    describe("conditionalNuggetRecall", () => {
        it("is null, not 0, when no nugget's source page was returned", () => {
            const nuggets = [
                createNugget({
                    id: "n1",
                    anchors: [["alpha"]],
                    sources: ["https://source.example/page"],
                }),
            ];
            const page = createPage("https://other.example", [createExcerpt("alpha is mentioned here.")]);
            const label = createLabel({ nuggets });
            const run = createRun([createResult({ pages: [page], totalChars: 100 })]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            expect(scoreboard.byQuery[0]?.conditionalNuggetRecall).toBeNull();
            expect(scoreboard.conditionalNuggetRecall).toBeNull();
        });

        it("excludes nuggets with no declared sources from the conditional metric", () => {
            const nuggets = [
                createNugget({
                    id: "n1",
                    anchors: [["alpha"]],
                    sources: ["https://a.example/page"],
                    weight: 1,
                }), // matched, its source was returned -> counts
                createNugget({ id: "n2", anchors: [["gamma"]], weight: 5 }), // no sources -> always excluded
            ];
            const page = createPage("https://a.example/page", [createExcerpt("alpha is here.")]);
            const label = createLabel({ nuggets });
            const run = createRun([createResult({ pages: [page], totalChars: 100 })]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            // Only n1 is source-eligible; it matched, so the conditional recall is 1,
            // not 1/6 (which is what including n2's weight would give).
            expect(scoreboard.byQuery[0]?.conditionalNuggetRecall).toBe(1);
        });

        it("computes a fractional value when only some source-eligible nuggets matched", () => {
            const nuggets = [
                createNugget({
                    id: "n1",
                    anchors: [["alpha"]],
                    sources: ["https://a.example/page"],
                    weight: 1,
                }), // matched
                createNugget({
                    id: "n2",
                    anchors: [["gamma"]],
                    sources: ["https://a.example/page"],
                    weight: 1,
                }), // source returned, but does not match
            ];
            const page = createPage("https://a.example/page", [createExcerpt("alpha is here.")]);
            const label = createLabel({ nuggets });
            const run = createRun([createResult({ pages: [page], totalChars: 100 })]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            expect(scoreboard.byQuery[0]?.conditionalNuggetRecall).toBeCloseTo(0.5, 10);
        });
    });

    describe("macro-average of conditionalNuggetRecall", () => {
        it("skips null per-query values instead of treating them as 0", () => {
            // Query A: its nugget's declared source page is never returned,
            // so conditionalNuggetRecall is null and must be skipped.
            const nuggetsA = [
                createNugget({
                    id: "a1",
                    anchors: [["alpha"]],
                    sources: ["https://nowhere.example/page"],
                }),
            ];
            const pageA = createPage("https://a.example", [createExcerpt("alpha appears here.")]);
            const queryA = createQuery({ id: "qa" });
            const labelA = createLabel({ queryId: "qa", nuggets: nuggetsA });
            const resultA = createResult({ queryId: "qa", pages: [pageA], totalChars: 100 });

            // Query B: its nugget's source page is returned and it matches,
            // so conditionalNuggetRecall is 1.
            const nuggetsB = [
                createNugget({
                    id: "b1",
                    anchors: [["beta"]],
                    sources: ["https://b.example/page"],
                }),
            ];
            const pageB = createPage("https://b.example/page", [createExcerpt("beta appears here.")]);
            const queryB = createQuery({ id: "qb" });
            const labelB = createLabel({ queryId: "qb", nuggets: nuggetsB });
            const resultB = createResult({ queryId: "qb", pages: [pageB], totalChars: 100 });

            const run = createRun([resultA, resultB]);
            const labels = new Map([
                ["qa", labelA],
                ["qb", labelB],
            ]);

            const scoreboard = scoreRun(run, [queryA, queryB], labels);

            // Correct: skip the null and average over query B alone -> 1.
            // Wrong (treating null as 0): (0 + 1) / 2 = 0.5.
            expect(scoreboard.conditionalNuggetRecall).toBe(1);
            expect(scoreboard.conditionalNuggetRecall).not.toBe(0.5);
        });
    });

    describe("sourcePrecision", () => {
        it("excludes ungraded pages from both the numerator and the denominator", () => {
            const gradedPage = createPage("https://good.example", []);
            const ungradedPage = createPage("https://unknown.example", []);
            const label = createLabel({
                sources: [createSource({ match: "good.example", grade: "good" })],
            });
            const run = createRun([
                createResult({ pages: [gradedPage, ungradedPage], totalChars: 100 }),
            ]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            // Naive precision counting the ungraded page in the denominator gives 1/2 = 0.5.
            // Correct precision, with the ungraded page excluded entirely, is 1/1 = 1.
            expect(scoreboard.byQuery[0]?.sourcePrecision).toBe(1);
        });

        it("is 0 when no returned page is graded at all", () => {
            const page = createPage("https://unknown.example", []);
            const label = createLabel({ sources: [] });
            const run = createRun([createResult({ pages: [page], totalChars: 100 })]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            expect(scoreboard.byQuery[0]?.sourcePrecision).toBe(0);
        });
    });

    describe("badRate", () => {
        it("computes bad-graded fraction over graded pages, hand-computed", () => {
            const badPage = createPage("https://spam.example", []);
            const acceptablePage = createPage("https://mid.example", []);
            const goodPage = createPage("https://good.example", []);
            const canonicalPage = createPage("https://canon.example", []);
            const label = createLabel({
                sources: [
                    createSource({ match: "spam.example", grade: "bad" }),
                    createSource({ match: "mid.example", grade: "acceptable" }),
                    createSource({ match: "good.example", grade: "good" }),
                    createSource({ match: "canon.example", grade: "canonical" }),
                ],
            });
            const run = createRun([
                createResult({
                    pages: [badPage, acceptablePage, goodPage, canonicalPage],
                    totalChars: 100,
                }),
            ]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            // 1 bad out of 4 graded pages -> 0.25. sourcePrecision, by contrast,
            // penalizes the acceptable page too: (1 good + 1 canonical) / 4 = 0.5.
            expect(scoreboard.byQuery[0]?.badRate).toBeCloseTo(0.25, 10);
            expect(scoreboard.byQuery[0]?.sourcePrecision).toBeCloseTo(0.5, 10);
        });

        it("excludes ungraded pages from both the numerator and the denominator", () => {
            const badPage = createPage("https://spam.example", []);
            const ungradedPage = createPage("https://unknown.example", []);
            const label = createLabel({
                sources: [createSource({ match: "spam.example", grade: "bad" })],
            });
            const run = createRun([
                createResult({ pages: [badPage, ungradedPage], totalChars: 100 }),
            ]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            // Naive rate counting the ungraded page in the denominator gives 1/2 = 0.5.
            // Correct rate, with the ungraded page excluded entirely, is 1/1 = 1.
            expect(scoreboard.byQuery[0]?.badRate).toBe(1);
        });

        it("is 0 when nothing graded is returned bad", () => {
            const goodPage = createPage("https://good.example", []);
            const label = createLabel({
                sources: [createSource({ match: "good.example", grade: "good" })],
            });
            const run = createRun([createResult({ pages: [goodPage], totalChars: 100 })]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            expect(scoreboard.byQuery[0]?.badRate).toBe(0);
        });

        it("is 1.0 when everything graded is bad", () => {
            const badPage1 = createPage("https://spam1.example", []);
            const badPage2 = createPage("https://spam2.example", []);
            const label = createLabel({
                sources: [
                    createSource({ match: "spam1.example", grade: "bad" }),
                    createSource({ match: "spam2.example", grade: "bad" }),
                ],
            });
            const run = createRun([
                createResult({ pages: [badPage1, badPage2], totalChars: 100 }),
            ]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            expect(scoreboard.byQuery[0]?.badRate).toBe(1);
        });

        it("is null, not 0, when the query returns no graded pages", () => {
            const ungradedPage = createPage("https://unknown.example", []);
            const label = createLabel({ sources: [] });
            const run = createRun([createResult({ pages: [ungradedPage], totalChars: 100 })]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            expect(scoreboard.byQuery[0]?.badRate).toBeNull();
        });
    });

    describe("macro-average of badRate", () => {
        it("skips a query with zero graded pages rather than counting it as 0", () => {
            // Query A: nothing graded -> badRate is null and must be skipped.
            const ungradedPage = createPage("https://unknown.example", []);
            const queryA = createQuery({ id: "qa" });
            const labelA = createLabel({ queryId: "qa", sources: [] });
            const resultA = createResult({ queryId: "qa", pages: [ungradedPage], totalChars: 100 });

            // Query B: one bad page, fully graded -> badRate is 1.
            const badPage = createPage("https://spam.example", []);
            const queryB = createQuery({ id: "qb" });
            const labelB = createLabel({
                queryId: "qb",
                sources: [createSource({ match: "spam.example", grade: "bad" })],
            });
            const resultB = createResult({ queryId: "qb", pages: [badPage], totalChars: 100 });

            const run = createRun([resultA, resultB]);
            const labels = new Map([
                ["qa", labelA],
                ["qb", labelB],
            ]);

            const scoreboard = scoreRun(run, [queryA, queryB], labels);

            // Correct: skip query A's null and average over query B alone -> 1.
            // Wrong (treating null as 0): (0 + 1) / 2 = 0.5.
            expect(scoreboard.badRate).toBe(1);
            expect(scoreboard.badRate).not.toBe(0.5);

            const category = scoreboard.byCategory.find((c) => c.category === queryA.category);
            expect(category?.badRate).toBe(1);
            expect(category?.badRate).not.toBe(0.5);
        });

        it("is null at the scoreboard level when no query has any graded page", () => {
            const ungradedPage = createPage("https://unknown.example", []);
            const label = createLabel({ sources: [] });
            const run = createRun([createResult({ pages: [ungradedPage], totalChars: 100 })]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            expect(scoreboard.badRate).toBeNull();
        });
    });

    describe("canonicalMrr", () => {
        it("is 1 when the canonical source is returned at rank 1", () => {
            const page = createPage("https://canonical.example", [], { rank: 1 });
            const label = createLabel({
                sources: [createSource({ match: "canonical.example", grade: "canonical" })],
            });
            const run = createRun([createResult({ pages: [page], totalChars: 100 })]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            expect(scoreboard.byQuery[0]?.canonicalMrr).toBe(1);
        });

        it("is 1/3 when the canonical source is returned at rank 3", () => {
            const pages = [
                createPage("https://other1.example", [], { rank: 1 }),
                createPage("https://other2.example", [], { rank: 2 }),
                createPage("https://canonical.example", [], { rank: 3 }),
            ];
            const label = createLabel({
                sources: [createSource({ match: "canonical.example", grade: "canonical" })],
            });
            const run = createRun([createResult({ pages, totalChars: 100 })]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            expect(scoreboard.byQuery[0]?.canonicalMrr).toBeCloseTo(1 / 3, 10);
        });

        it("is 0 when no returned page is graded canonical", () => {
            const pages = [createPage("https://good.example", [], { rank: 1 })];
            const label = createLabel({
                sources: [createSource({ match: "good.example", grade: "good" })],
            });
            const run = createRun([createResult({ pages, totalChars: 100 })]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            expect(scoreboard.byQuery[0]?.canonicalMrr).toBe(0);
        });
    });

    describe("badSourcesReturned", () => {
        it("lists the urls of returned pages graded bad", () => {
            const badPage = createPage("https://spam.example", []);
            const goodPage = createPage("https://good.example", []);
            const label = createLabel({
                sources: [
                    createSource({ match: "spam.example", grade: "bad" }),
                    createSource({ match: "good.example", grade: "good" }),
                ],
            });
            const run = createRun([createResult({ pages: [badPage, goodPage], totalChars: 100 })]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            expect(scoreboard.byQuery[0]?.badSourcesReturned).toEqual(["https://spam.example"]);
        });
    });

    describe("efficiency", () => {
        it("is weighted nuggets matched per 1000 characters returned", () => {
            const nuggets = [createNugget({ id: "n1", anchors: [["alpha"]], weight: 2 })];
            const page = createPage("https://a.example", [createExcerpt("alpha appears here.")]);
            const label = createLabel({ nuggets });
            const run = createRun([createResult({ pages: [page], totalChars: 4000 })]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            // matched weight = 2; totalChars / 1000 = 4 -> efficiency = 2 / 4 = 0.5
            expect(scoreboard.byQuery[0]?.efficiency).toBeCloseTo(0.5, 10);
        });

        it("is 0 when totalChars is 0", () => {
            const nuggets = [createNugget({ id: "n1", anchors: [["alpha"]], weight: 2 })];
            const page = createPage("https://a.example", [createExcerpt("alpha appears here.")]);
            const label = createLabel({ nuggets });
            const run = createRun([createResult({ pages: [page], totalChars: 0 })]);

            const scoreboard = scoreRun(run, [createQuery()], new Map([["q1", label]]));

            expect(scoreboard.byQuery[0]?.efficiency).toBe(0);
        });
    });

    describe("skipping unlabeled queries", () => {
        it("skips a run result with no matching label, does not throw, and records it in skippedQueryIds", () => {
            const result = createResult({ queryId: "unlabeled", pages: [], totalChars: 0 });
            const run = createRun([result]);

            const scoreboard = scoreRun(run, [], new Map());

            expect(scoreboard.byQuery).toHaveLength(0);
            expect(scoreboard.queryCount).toBe(0);
            expect(scoreboard.skippedQueryIds).toEqual(["unlabeled"]);
        });

        it("scores the labeled queries and skips only the unlabeled ones", () => {
            const label = createLabel({ nuggets: [] });
            const labeledResult = createResult({ queryId: "q1", pages: [], totalChars: 100 });
            const unlabeledResult = createResult({ queryId: "q2", pages: [], totalChars: 100 });
            const run = createRun([labeledResult, unlabeledResult]);

            const scoreboard = scoreRun(run, [createQuery({ id: "q1" })], new Map([["q1", label]]));

            expect(scoreboard.byQuery).toHaveLength(1);
            expect(scoreboard.byQuery[0]?.queryId).toBe("q1");
            expect(scoreboard.queryCount).toBe(1);
            expect(scoreboard.skippedQueryIds).toEqual(["q2"]);
        });

        it("skippedQueryIds contains exactly the unlabeled query ids, sorted ascending", () => {
            const label = createLabel({ queryId: "b-labeled", nuggets: [] });
            const run = createRun([
                createResult({ queryId: "z-unlabeled", pages: [], totalChars: 10 }),
                createResult({ queryId: "b-labeled", pages: [], totalChars: 10 }),
                createResult({ queryId: "a-unlabeled", pages: [], totalChars: 10 }),
                createResult({ queryId: "m-unlabeled", pages: [], totalChars: 10 }),
            ]);
            const queries = [createQuery({ id: "b-labeled" })];
            const labels = new Map([["b-labeled", label]]);

            const scoreboard = scoreRun(run, queries, labels);

            // Exactly the three unlabeled ids - the labeled one must not appear -
            // and sorted ascending regardless of their order in run.results.
            expect(scoreboard.skippedQueryIds).toEqual(["a-unlabeled", "m-unlabeled", "z-unlabeled"]);
        });

        it("skippedQueryIds is empty when every run result has a label", () => {
            const label = createLabel({ nuggets: [] });
            const run = createRun([createResult({ queryId: "q1", pages: [], totalChars: 10 })]);

            const scoreboard = scoreRun(run, [createQuery({ id: "q1" })], new Map([["q1", label]]));

            expect(scoreboard.skippedQueryIds).toEqual([]);
        });
    });

    describe("byQuery and byCategory ordering", () => {
        it("sorts byQuery by queryId ascending", () => {
            const labelZ = createLabel({ queryId: "z-query", nuggets: [] });
            const labelA = createLabel({ queryId: "a-query", nuggets: [] });
            const run = createRun([
                createResult({ queryId: "z-query", totalChars: 10 }),
                createResult({ queryId: "a-query", totalChars: 10 }),
            ]);
            const queries = [createQuery({ id: "z-query" }), createQuery({ id: "a-query" })];
            const labels = new Map([
                ["z-query", labelZ],
                ["a-query", labelA],
            ]);

            const scoreboard = scoreRun(run, queries, labels);

            expect(scoreboard.byQuery.map((q) => q.queryId)).toEqual(["a-query", "z-query"]);
        });

        it("sorts byCategory by types.ts declaration order and omits empty categories", () => {
            const queries = [
                createQuery({ id: "q1", category: "general" }),
                createQuery({ id: "q2", category: "api-docs" }),
            ];
            const labels = new Map([
                ["q1", createLabel({ queryId: "q1", nuggets: [] })],
                ["q2", createLabel({ queryId: "q2", nuggets: [] })],
            ]);
            const run = createRun([
                createResult({ queryId: "q1", totalChars: 10 }),
                createResult({ queryId: "q2", totalChars: 10 }),
            ]);

            const scoreboard = scoreRun(run, queries, labels);

            // Declaration order in types.ts is api-docs, ..., general - so
            // api-docs sorts first even though q1 (general) appears first in input.
            expect(scoreboard.byCategory.map((c) => c.category)).toEqual(["api-docs", "general"]);
            // debugging, conceptual, etc. had zero scored queries and are omitted.
            expect(scoreboard.byCategory).toHaveLength(2);
        });
    });
});
