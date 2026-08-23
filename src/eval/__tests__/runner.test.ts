import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAll, writeRun, readRun, generateRunId, type PipelineAdapter } from "../runner";
import { CorpusMissError, type Corpus } from "../cache";
import type { Query, RunQueryResult } from "../types";

/**
 * In-memory stand-in for Corpus. `runAll` only ever calls `revision()`; the
 * rest is the adapter's business, and the stub adapters below ignore it.
 */
function fakeCorpus(revision = "corpus-rev-1"): Corpus {
    return { revision: () => revision } as unknown as Corpus;
}

function makeQuery(id: string): Query {
    return { id, text: `query ${id}`, category: "api-docs", difficulty: 1 };
}

function makeQueries(count: number): Query[] {
    return Array.from({ length: count }, (_, i) => makeQuery(`q${i}`));
}

function emptyResult(queryId: string): RunQueryResult {
    return {
        queryId,
        pages: [],
        consideredUrls: [],
        totalChars: 0,
        durationMs: 0,
    };
}

/**
 * Adapter whose queries finish in a deliberately scrambled order: later
 * queries resolve sooner, so any completion-order leak shows up immediately.
 */
function shufflingAdapter(delays: Map<string, number>): PipelineAdapter {
    return {
        name: "stub",
        config: { stub: true },
        async runQuery(query) {
            const delay = delays.get(query.id) ?? 0;
            await new Promise((resolve) => setTimeout(resolve, delay));
            return emptyResult(query.id);
        },
    };
}

describe("runAll", () => {
    describe("ordering determinism", () => {
        it("returns results in input order regardless of completion order", async () => {
            // Arrange: reverse the completion order relative to input order
            const queries = makeQueries(12);
            const delays = new Map(queries.map((q, i) => [q.id, (queries.length - i) * 2]));
            const adapter = shufflingAdapter(delays);

            // Act
            const run = await runAll(adapter, queries, fakeCorpus(), { concurrency: 4 });

            // Assert
            expect(run.results.map((r) => r.queryId)).toEqual(queries.map((q) => q.id));
        });

        it("produces the same order at every concurrency level", async () => {
            const queries = makeQueries(10);
            const delays = new Map(queries.map((q, i) => [q.id, (i % 3) * 3]));
            const adapter = shufflingAdapter(delays);

            const serial = await runAll(adapter, queries, fakeCorpus(), { concurrency: 1 });
            const parallel = await runAll(adapter, queries, fakeCorpus(), { concurrency: 8 });

            expect(parallel.results.map((r) => r.queryId)).toEqual(serial.results.map((r) => r.queryId));
        });

        it("handles an empty queryset", async () => {
            const run = await runAll(shufflingAdapter(new Map()), [], fakeCorpus());

            expect(run.results).toEqual([]);
        });

        it("reports progress once per query", async () => {
            const queries = makeQueries(6);
            const seen: number[] = [];

            await runAll(shufflingAdapter(new Map()), queries, fakeCorpus(), {
                concurrency: 3,
                onProgress: (done, total) => {
                    expect(total).toBe(6);
                    seen.push(done);
                },
            });

            expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
        });
    });

    describe("error isolation", () => {
        it("records a CorpusMissError on the failing query and continues", async () => {
            // Arrange
            const queries = makeQueries(5);
            const adapter: PipelineAdapter = {
                name: "stub",
                config: {},
                async runQuery(query) {
                    if (query.id === "q2") {
                        throw new CorpusMissError("page", "https://example.com/missing");
                    }
                    return emptyResult(query.id);
                },
            };

            // Act
            const run = await runAll(adapter, queries, fakeCorpus(), { concurrency: 4 });

            // Assert
            expect(run.results).toHaveLength(5);
            expect(run.results.map((r) => r.queryId)).toEqual(["q0", "q1", "q2", "q3", "q4"]);

            const failed = run.results[2];
            expect(failed?.error).toContain("Corpus miss (page)");
            expect(failed?.pages).toEqual([]);
            expect(failed?.durationMs).toBeGreaterThanOrEqual(0);

            const others = run.results.filter((r) => r.queryId !== "q2");
            expect(others.every((r) => r.error === undefined)).toBe(true);
        });

        it("records non-corpus errors the same way", async () => {
            const queries = makeQueries(3);
            const adapter: PipelineAdapter = {
                name: "stub",
                config: {},
                async runQuery(query) {
                    if (query.id === "q1") throw new Error("boom");
                    return emptyResult(query.id);
                },
            };

            const run = await runAll(adapter, queries, fakeCorpus());

            expect(run.results[1]?.error).toBe("boom");
            expect(run.results).toHaveLength(3);
        });

        it("records a thrown non-Error value", async () => {
            const adapter: PipelineAdapter = {
                name: "stub",
                config: {},
                async runQuery() {
                    throw "not an error object";
                },
            };

            const run = await runAll(adapter, makeQueries(1), fakeCorpus());

            expect(run.results[0]?.error).toBe("not an error object");
        });
    });

    describe("run metadata", () => {
        it("populates pipeline, config, corpus revision and startedAt", async () => {
            const adapter: PipelineAdapter = {
                name: "v1",
                config: { maxResults: 7 },
                async runQuery(query) {
                    return emptyResult(query.id);
                },
            };

            const run = await runAll(adapter, makeQueries(2), fakeCorpus("abc123def456"));

            expect(run.pipeline).toBe("v1");
            expect(run.config).toEqual({ maxResults: 7 });
            expect(run.corpusRevision).toBe("abc123def456");
            expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(run.id.startsWith("v1-")).toBe(true);
        });

        it("uses a caller-supplied id when given", async () => {
            const run = await runAll(shufflingAdapter(new Map()), makeQueries(1), fakeCorpus(), {
                id: "baseline-2026-01",
            });

            expect(run.id).toBe("baseline-2026-01");
        });
    });
});

describe("generateRunId", () => {
    it("is derived from the pipeline name and a timestamp", () => {
        const id = generateRunId("v1", new Date("2026-08-21T12:34:56.789Z"));

        expect(id).toBe("v1-20260821T123456Z");
    });
});

describe("writeRun / readRun", () => {
    it("round-trips a run through disk", async () => {
        // Arrange
        const dir = mkdtempSync(join(tmpdir(), "peeky-eval-runs-"));
        try {
            const run = await runAll(shufflingAdapter(new Map()), makeQueries(3), fakeCorpus(), {
                id: "roundtrip",
            });

            // Act
            const path = writeRun(run, dir);
            const loaded = readRun("roundtrip", dir);

            // Assert
            expect(path).toBe(join(dir, "roundtrip.json"));
            expect(loaded).toEqual(run);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("throws a helpful error for a missing run", () => {
        const dir = mkdtempSync(join(tmpdir(), "peeky-eval-runs-"));
        try {
            expect(() => readRun("nope", dir)).toThrow(/Run not found/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
