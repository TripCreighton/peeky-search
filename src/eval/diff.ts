/**
 * Run-to-run comparison.
 *
 * The most important tool in the harness. An aggregate score tells you a change
 * was net-positive; it does not tell you that it silently destroyed every
 * version-specific query while winning big on api-docs. Regressions hide inside
 * averages, so this reports per-query movement and nugget-level gains and
 * losses, losses first and worst first.
 */

import type {
    CategoryScore,
    QueryCategory,
    QueryScore,
    Scoreboard,
} from "./types";

/** Movement below this is float noise, not a real change. */
const NEUTRAL_EPSILON = 1e-6;

export type Verdict = "win" | "loss" | "neutral";

export interface QueryDelta {
    queryId: string;
    category: QueryCategory;
    verdict: Verdict;
    nuggetRecallBefore: number;
    nuggetRecallAfter: number;
    nuggetRecallDelta: number;
    /** Nugget ids found in B but not A. */
    nuggetsGained: string[];
    /** Nugget ids found in A but not B. These are what a regression looks like. */
    nuggetsLost: string[];
    sourcePrecisionDelta: number;
    /** Null when badRate is undefined (no graded pages) in either run. */
    badRateDelta: number | null;
    canonicalMrrDelta: number;
    efficiencyDelta: number;
    charsDelta: number;
    /** Bad-graded sources newly returned by B. */
    badSourcesIntroduced: string[];
    /** Bad-graded sources A returned that B no longer does. */
    badSourcesRemoved: string[];
}

export interface CategoryDelta {
    category: QueryCategory;
    queryCount: number;
    nuggetRecallBefore: number;
    nuggetRecallAfter: number;
    nuggetRecallDelta: number;
    sourcePrecisionDelta: number;
    canonicalMrrDelta: number;
    efficiencyDelta: number;
}

export interface ScoreboardDiff {
    runA: string;
    runB: string;
    pipelineA: string;
    pipelineB: string;
    /** Overall macro-averaged movement. */
    overall: {
        nuggetRecallDelta: number;
        conditionalNuggetRecallDelta: number | null;
        sourcePrecisionDelta: number;
        /** Null when badRate is undefined (no graded pages) in either run. A
         * positive value is the single worst outcome: we started returning
         * more content farms. */
        badRateDelta: number | null;
        canonicalMrrDelta: number;
        efficiencyDelta: number;
        avgCharsDelta: number;
    };
    wins: QueryDelta[];
    losses: QueryDelta[];
    neutralCount: number;
    byCategory: CategoryDelta[];
    /**
     * Every query that introduced a new bad-graded source in B, worst
     * (largest badRateDelta) first - regardless of verdict, which is driven
     * by nuggetRecallDelta alone and can classify a query as "neutral" even
     * while it started returning a content farm. Keeps that outcome visible
     * even when it doesn't move nugget recall.
     */
    badSourceRegressions: QueryDelta[];
    /** Queries scored in A but absent from B, and vice versa. */
    onlyInA: string[];
    onlyInB: string[];
}

function verdictFor(delta: number): Verdict {
    if (delta > NEUTRAL_EPSILON) return "win";
    if (delta < -NEUTRAL_EPSILON) return "loss";
    return "neutral";
}

/** Subtract two possibly-undefined metrics, treating null as "not measured". */
function nullableDelta(a: number | null, b: number | null): number | null {
    if (a === null || b === null) return null;
    return b - a;
}

function setDifference(from: string[], remove: string[]): string[] {
    const excluded = new Set(remove);
    return from.filter((item) => !excluded.has(item));
}

function indexByQuery(scores: QueryScore[]): Map<string, QueryScore> {
    const map = new Map<string, QueryScore>();
    for (const score of scores) {
        map.set(score.queryId, score);
    }
    return map;
}

function indexByCategory(scores: CategoryScore[]): Map<QueryCategory, CategoryScore> {
    const map = new Map<QueryCategory, CategoryScore>();
    for (const score of scores) {
        map.set(score.category, score);
    }
    return map;
}

/**
 * Compare two scoreboards. `a` is the baseline, `b` is the candidate.
 */
export function diffScoreboards(a: Scoreboard, b: Scoreboard): ScoreboardDiff {
    const aByQuery = indexByQuery(a.byQuery);
    const bByQuery = indexByQuery(b.byQuery);

    const wins: QueryDelta[] = [];
    const losses: QueryDelta[] = [];
    const badSourceRegressions: QueryDelta[] = [];
    let neutralCount = 0;

    for (const [queryId, before] of aByQuery) {
        const after = bByQuery.get(queryId);
        if (after === undefined) continue;

        const nuggetRecallDelta = after.nuggetRecall - before.nuggetRecall;
        const verdict = verdictFor(nuggetRecallDelta);

        const delta: QueryDelta = {
            queryId,
            category: before.category,
            verdict,
            nuggetRecallBefore: before.nuggetRecall,
            nuggetRecallAfter: after.nuggetRecall,
            nuggetRecallDelta,
            nuggetsGained: setDifference(after.nuggetsFound, before.nuggetsFound),
            nuggetsLost: setDifference(before.nuggetsFound, after.nuggetsFound),
            sourcePrecisionDelta: after.sourcePrecision - before.sourcePrecision,
            badRateDelta: nullableDelta(before.badRate, after.badRate),
            canonicalMrrDelta: after.canonicalMrr - before.canonicalMrr,
            efficiencyDelta: after.efficiency - before.efficiency,
            charsDelta: after.totalChars - before.totalChars,
            badSourcesIntroduced: setDifference(
                after.badSourcesReturned,
                before.badSourcesReturned
            ),
            badSourcesRemoved: setDifference(
                before.badSourcesReturned,
                after.badSourcesReturned
            ),
        };

        if (verdict === "win") wins.push(delta);
        else if (verdict === "loss") losses.push(delta);
        else neutralCount++;

        if (delta.badSourcesIntroduced.length > 0) badSourceRegressions.push(delta);
    }

    // Worst regressions first; ties broken by queryId for determinism.
    losses.sort((x, y) => {
        const d = x.nuggetRecallDelta - y.nuggetRecallDelta;
        if (d !== 0) return d;
        return x.queryId.localeCompare(y.queryId);
    });
    wins.sort((x, y) => {
        const d = y.nuggetRecallDelta - x.nuggetRecallDelta;
        if (d !== 0) return d;
        return x.queryId.localeCompare(y.queryId);
    });
    badSourceRegressions.sort((x, y) => {
        const d = (y.badRateDelta ?? 0) - (x.badRateDelta ?? 0);
        if (d !== 0) return d;
        return x.queryId.localeCompare(y.queryId);
    });

    const aByCategory = indexByCategory(a.byCategory);
    const bByCategory = indexByCategory(b.byCategory);
    const byCategory: CategoryDelta[] = [];

    for (const [category, before] of aByCategory) {
        const after = bByCategory.get(category);
        if (after === undefined) continue;
        byCategory.push({
            category,
            queryCount: after.queryCount,
            nuggetRecallBefore: before.nuggetRecall,
            nuggetRecallAfter: after.nuggetRecall,
            nuggetRecallDelta: after.nuggetRecall - before.nuggetRecall,
            sourcePrecisionDelta: after.sourcePrecision - before.sourcePrecision,
            canonicalMrrDelta: after.canonicalMrr - before.canonicalMrr,
            efficiencyDelta: after.efficiency - before.efficiency,
        });
    }

    return {
        runA: a.runId,
        runB: b.runId,
        pipelineA: a.pipeline,
        pipelineB: b.pipeline,
        overall: {
            nuggetRecallDelta: b.nuggetRecall - a.nuggetRecall,
            conditionalNuggetRecallDelta: nullableDelta(
                a.conditionalNuggetRecall,
                b.conditionalNuggetRecall
            ),
            sourcePrecisionDelta: b.sourcePrecision - a.sourcePrecision,
            badRateDelta: nullableDelta(a.badRate, b.badRate),
            canonicalMrrDelta: b.canonicalMrr - a.canonicalMrr,
            efficiencyDelta: b.efficiency - a.efficiency,
            avgCharsDelta: b.avgChars - a.avgChars,
        },
        wins,
        losses,
        neutralCount,
        byCategory,
        badSourceRegressions,
        onlyInA: [...aByQuery.keys()].filter((id) => !bByQuery.has(id)).sort(),
        onlyInB: [...bByQuery.keys()].filter((id) => !aByQuery.has(id)).sort(),
    };
}

function signed(value: number, digits = 3): string {
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(digits)}`;
}

function signedInt(value: number): string {
    return value > 0 ? `+${value}` : `${value}`;
}

export interface FormatDiffOptions {
    /** Max per-query entries to print in each of the losses/wins lists. */
    limit?: number;
    /** Print every query, including neutral ones. */
    verbose?: boolean;
}

/**
 * Render a diff for the terminal. Losses are printed before wins on purpose:
 * the thing you need to see is what you broke.
 */
export function formatDiff(diff: ScoreboardDiff, options: FormatDiffOptions = {}): string {
    const { limit = 15, verbose = false } = options;
    const lines: string[] = [];

    lines.push(`${diff.pipelineA} (${diff.runA})  ->  ${diff.pipelineB} (${diff.runB})`);
    lines.push("");

    lines.push("OVERALL");
    const o = diff.overall;
    lines.push(`  nugget recall       ${signed(o.nuggetRecallDelta)}`);
    lines.push(
        `  conditional recall  ${
            o.conditionalNuggetRecallDelta === null
                ? "n/a (not measurable in one or both runs)"
                : signed(o.conditionalNuggetRecallDelta)
        }`
    );
    lines.push(`  source precision    ${signed(o.sourcePrecisionDelta)}`);
    lines.push(
        `  bad rate            ${
            o.badRateDelta === null ? "n/a (not measurable in one or both runs)" : signed(o.badRateDelta)
        }${o.badRateDelta !== null && o.badRateDelta > NEUTRAL_EPSILON ? "  <-- regression: more content farms returned" : ""}`
    );
    lines.push(`  canonical MRR       ${signed(o.canonicalMrrDelta)}`);
    lines.push(`  efficiency          ${signed(o.efficiencyDelta)} nuggets/1k chars`);
    lines.push(`  avg chars           ${signedInt(Math.round(o.avgCharsDelta))}`);
    lines.push("");

    lines.push(
        `  ${diff.wins.length} improved, ${diff.losses.length} regressed, ${diff.neutralCount} unchanged`
    );
    lines.push("");

    if (diff.badSourceRegressions.length > 0) {
        lines.push(
            `NEW BAD SOURCES (${diff.badSourceRegressions.length} - shown regardless of nugget recall movement)`
        );
        for (const d of diff.badSourceRegressions) {
            lines.push(`  ${d.queryId}  [${d.category}]`);
            lines.push(`      NEW BAD SOURCE: ${d.badSourcesIntroduced.join(", ")}`);
            if (d.badRateDelta !== null) {
                lines.push(`      bad rate: ${signed(d.badRateDelta, 2)}`);
            }
        }
        lines.push("");
    }

    if (diff.byCategory.length > 0) {
        lines.push("BY CATEGORY");
        const sorted = [...diff.byCategory].sort(
            (x, y) => x.nuggetRecallDelta - y.nuggetRecallDelta
        );
        for (const c of sorted) {
            lines.push(
                `  ${c.category.padEnd(18)} ${c.nuggetRecallBefore.toFixed(3)} -> ` +
                `${c.nuggetRecallAfter.toFixed(3)}  ${signed(c.nuggetRecallDelta)}` +
                `  (n=${c.queryCount})`
            );
        }
        lines.push("");
    }

    const renderQuery = (d: QueryDelta): void => {
        lines.push(
            `  ${d.queryId}  ${d.nuggetRecallBefore.toFixed(2)} -> ` +
            `${d.nuggetRecallAfter.toFixed(2)}  ${signed(d.nuggetRecallDelta, 2)}` +
            `  [${d.category}]`
        );
        if (d.nuggetsLost.length > 0) {
            lines.push(`      lost:   ${d.nuggetsLost.join(", ")}`);
        }
        if (d.nuggetsGained.length > 0) {
            lines.push(`      gained: ${d.nuggetsGained.join(", ")}`);
        }
        if (d.badSourcesIntroduced.length > 0) {
            lines.push(
                `      NEW BAD SOURCE: ${d.badSourcesIntroduced.join(", ")}` +
                    (d.badRateDelta !== null && d.badRateDelta > NEUTRAL_EPSILON
                        ? `  (bad rate ${signed(d.badRateDelta, 2)})`
                        : "")
            );
        }
        if (d.charsDelta !== 0) {
            lines.push(`      chars:  ${signedInt(d.charsDelta)}`);
        }
    };

    if (diff.losses.length > 0) {
        lines.push(`REGRESSIONS (worst first)`);
        const shown = verbose ? diff.losses : diff.losses.slice(0, limit);
        for (const d of shown) renderQuery(d);
        if (shown.length < diff.losses.length) {
            lines.push(`  ... ${diff.losses.length - shown.length} more`);
        }
        lines.push("");
    }

    if (diff.wins.length > 0) {
        lines.push(`IMPROVEMENTS (best first)`);
        const shown = verbose ? diff.wins : diff.wins.slice(0, limit);
        for (const d of shown) renderQuery(d);
        if (shown.length < diff.wins.length) {
            lines.push(`  ... ${diff.wins.length - shown.length} more`);
        }
        lines.push("");
    }

    if (diff.onlyInA.length > 0) {
        lines.push(`Only scored in ${diff.runA}: ${diff.onlyInA.join(", ")}`);
    }
    if (diff.onlyInB.length > 0) {
        lines.push(`Only scored in ${diff.runB}: ${diff.onlyInB.join(", ")}`);
    }

    return lines.join("\n");
}
