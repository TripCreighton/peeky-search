/**
 * Evaluation run driver.
 *
 * Replays a queryset through a pipeline adapter against a frozen corpus and
 * produces a `Run`. Nothing here touches the network: every fetch a pipeline
 * makes is served by the `Corpus` handed to the adapter, so a run is a pure
 * function of (adapter config, corpus, queryset).
 *
 * Determinism is the whole point. Queries execute concurrently but results are
 * written back at their input index, so the `Run.results` array is always in
 * queryset order regardless of which query finished first.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Corpus } from "./cache";
import type { Query, Run, RunQueryResult } from "./types";

/**
 * A pipeline under test. `v1` wraps the existing MCP orchestrator; `v2` will
 * implement the same interface so the two can be compared without the runner
 * knowing which is which.
 */
export interface PipelineAdapter {
    /** Short identifier recorded as `Run.pipeline`, e.g. "v1". */
    readonly name: string;
    /** Serialized config recorded as `Run.config`, so a run is reproducible. */
    readonly config: unknown;
    runQuery(query: Query, corpus: Corpus): Promise<RunQueryResult>;
}

export interface RunAllOptions {
    /** Queries executed in parallel. Default 4. */
    concurrency?: number;
    /** Called after each query completes, in completion order. */
    onProgress?: (done: number, total: number, queryId: string) => void;
    /** Explicit run id. Defaults to a timestamped id derived from the pipeline name. */
    id?: string;
}

const DEFAULT_CONCURRENCY = 4;

/** Default location for serialized runs, relative to the repo root. */
export const DEFAULT_RUNS_DIR = "eval/runs";

/**
 * Derive a run id from the pipeline name and the current time.
 *
 * Deliberately clock-based rather than random: rerunning the same queryset
 * produces a new, sortable id without introducing a second source of
 * nondeterminism into the harness. Pass `opts.id` when a stable id is needed.
 */
export function generateRunId(pipeline: string, now: Date = new Date()): string {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    return `${pipeline}-${stamp}`;
}

/**
 * Run one query, converting any thrown error into a recorded failure.
 *
 * A corpus miss (or any other error) fails a single query, never the run: a
 * partially-recorded corpus should still produce a scoreboard for the queries
 * it does cover.
 */
async function runOne(
    adapter: PipelineAdapter,
    query: Query,
    corpus: Corpus
): Promise<RunQueryResult> {
    const start = performance.now();
    try {
        return await adapter.runQuery(query, corpus);
    } catch (error) {
        return {
            queryId: query.id,
            pages: [],
            consideredUrls: [],
            totalChars: 0,
            durationMs: performance.now() - start,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Execute every query through the adapter and assemble a `Run`.
 */
export async function runAll(
    adapter: PipelineAdapter,
    queries: Query[],
    corpus: Corpus,
    opts: RunAllOptions = {}
): Promise<Run> {
    const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
    const startedAt = new Date().toISOString();
    const total = queries.length;

    // Results are written back by index, so completion order never leaks into
    // the output.
    const results: RunQueryResult[] = new Array<RunQueryResult>(total);

    let nextIndex = 0;
    let completed = 0;

    const worker = async (): Promise<void> => {
        for (;;) {
            const index = nextIndex;
            nextIndex += 1;
            const query = queries[index];
            if (query === undefined) return;

            results[index] = await runOne(adapter, query, corpus);

            completed += 1;
            opts.onProgress?.(completed, total, query.id);
        }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(concurrency, total); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);

    return {
        id: opts.id ?? generateRunId(adapter.name),
        pipeline: adapter.name,
        config: adapter.config,
        corpusRevision: corpus.revision(),
        startedAt,
        results,
    };
}

/**
 * Serialize a run to `<dir>/<id>.json`. Returns the path written.
 */
export function writeRun(run: Run, dir: string = DEFAULT_RUNS_DIR): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${run.id}.json`);
    writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`, "utf-8");
    return path;
}

/**
 * Read a previously serialized run. Throws if it does not exist.
 */
export function readRun(id: string, dir: string = DEFAULT_RUNS_DIR): Run {
    const path = join(dir, `${id}.json`);
    if (!existsSync(path)) {
        throw new Error(`Run not found: ${path}`);
    }
    return JSON.parse(readFileSync(path, "utf-8")) as Run;
}
