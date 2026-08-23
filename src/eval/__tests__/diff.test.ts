import { describe, it, expect } from "vitest";
import { diffScoreboards, formatDiff } from "../diff";
import type { QueryScore, Scoreboard } from "../types";

function createQueryScore(overrides: Partial<QueryScore> = {}): QueryScore {
    return {
        queryId: "q1",
        category: "how-to",
        nuggetsFound: [],
        nuggetsMissed: [],
        matches: [],
        nuggetRecall: 0.5,
        conditionalNuggetRecall: null,
        sourcePrecision: 0.5,
        gradedFraction: 1,
        badRate: 0,
        canonicalMrr: 0,
        badSourcesReturned: [],
        efficiency: 0,
        totalChars: 100,
        ...overrides,
    };
}

function createScoreboard(byQuery: QueryScore[], overrides: Partial<Scoreboard> = {}): Scoreboard {
    return {
        runId: "run",
        pipeline: "v1",
        queryCount: byQuery.length,
        nuggetRecall: 0,
        conditionalNuggetRecall: null,
        sourcePrecision: 0,
        badRate: 0,
        canonicalMrr: 0,
        efficiency: 0,
        avgChars: 0,
        skippedQueryIds: [],
        byCategory: [],
        byQuery,
        ...overrides,
    };
}

describe("diffScoreboards", () => {
    describe("badRateDelta", () => {
        it("computes overall badRateDelta as B minus A", () => {
            const a = createScoreboard(
                [createQueryScore({ badRate: 0 })],
                { badRate: 0 }
            );
            const b = createScoreboard(
                [createQueryScore({ badRate: 0.5 })],
                { badRate: 0.5 }
            );

            const diff = diffScoreboards(a, b);

            expect(diff.overall.badRateDelta).toBeCloseTo(0.5, 10);
        });

        it("is null overall when badRate is undefined in either run", () => {
            const a = createScoreboard([createQueryScore({ badRate: null })], { badRate: null });
            const b = createScoreboard([createQueryScore({ badRate: 0.5 })], { badRate: 0.5 });

            const diff = diffScoreboards(a, b);

            expect(diff.overall.badRateDelta).toBeNull();
        });

        it("computes a per-query badRateDelta on QueryDelta", () => {
            const a = createScoreboard([
                createQueryScore({ queryId: "q1", badRate: 0, nuggetRecall: 0.3 }),
            ]);
            const b = createScoreboard([
                createQueryScore({ queryId: "q1", badRate: 1, nuggetRecall: 0.6 }),
            ]);

            const diff = diffScoreboards(a, b);

            expect(diff.wins).toHaveLength(1);
            expect(diff.wins[0]?.badRateDelta).toBeCloseTo(1, 10);
        });

        it("is null on a QueryDelta when the query's badRate is undefined in either run", () => {
            const a = createScoreboard([
                createQueryScore({ queryId: "q1", badRate: null, nuggetRecall: 0.5 }),
            ]);
            const b = createScoreboard([
                createQueryScore({ queryId: "q1", badRate: 0.5, nuggetRecall: 0.6 }),
            ]);

            const diff = diffScoreboards(a, b);

            expect(diff.wins[0]?.badRateDelta).toBeNull();
        });
    });

    describe("badRate regression surfacing", () => {
        it("surfaces a badRate regression via badSourcesIntroduced even when nuggetRecall is unchanged", () => {
            // Same nuggetRecall in both runs -> classified "neutral" by the
            // win/loss verdict. The new bad source must still be visible.
            const a = createScoreboard([
                createQueryScore({
                    queryId: "q1",
                    nuggetRecall: 0.5,
                    badRate: 0,
                    badSourcesReturned: [],
                }),
            ]);
            const b = createScoreboard([
                createQueryScore({
                    queryId: "q1",
                    nuggetRecall: 0.5,
                    badRate: 1,
                    badSourcesReturned: ["https://spam.example"],
                }),
            ]);

            const diff = diffScoreboards(a, b);

            expect(diff.neutralCount).toBe(1);
            expect(diff.wins).toHaveLength(0);
            expect(diff.losses).toHaveLength(0);
            expect(diff.badSourceRegressions).toHaveLength(1);
            expect(diff.badSourceRegressions[0]?.queryId).toBe("q1");
            expect(diff.badSourceRegressions[0]?.badSourcesIntroduced).toEqual([
                "https://spam.example",
            ]);
            expect(diff.badSourceRegressions[0]?.badRateDelta).toBeCloseTo(1, 10);
        });

        it("formatDiff prints the regression in the OVERALL block and a dedicated section", () => {
            const a = createScoreboard(
                [
                    createQueryScore({
                        queryId: "q1",
                        nuggetRecall: 0.5,
                        badRate: 0,
                        badSourcesReturned: [],
                    }),
                ],
                { badRate: 0 }
            );
            const b = createScoreboard(
                [
                    createQueryScore({
                        queryId: "q1",
                        nuggetRecall: 0.5,
                        badRate: 1,
                        badSourcesReturned: ["https://spam.example"],
                    }),
                ],
                { badRate: 1 }
            );

            const diff = diffScoreboards(a, b);
            const output = formatDiff(diff);

            expect(output).toContain("bad rate");
            expect(output).toContain("+1.000");
            expect(output).toContain("regression: more content farms returned");
            expect(output).toContain("NEW BAD SOURCES");
            expect(output).toContain("https://spam.example");
        });

        it("does not report a regression when no bad source was introduced", () => {
            const a = createScoreboard([createQueryScore({ queryId: "q1", badRate: 0 })]);
            const b = createScoreboard([createQueryScore({ queryId: "q1", badRate: 0 })]);

            const diff = diffScoreboards(a, b);

            expect(diff.badSourceRegressions).toHaveLength(0);
        });
    });
});
