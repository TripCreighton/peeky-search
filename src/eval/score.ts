/**
 * Metrics scorer.
 *
 * Turns a `Run` (raw pipeline output) plus the query set and labels into a
 * `Scoreboard`. All aggregation is macro-averaged over queries — every
 * query counts equally, regardless of how many pages or nuggets it has —
 * so a handful of nugget-heavy queries can't dominate the headline numbers.
 */

import type {
    CategoryScore,
    Query,
    QueryCategory,
    QueryLabel,
    QueryScore,
    Run,
    RunQueryResult,
    Scoreboard,
} from "./types";
import { matchNuggets } from "./nuggets";
import { canonicalizeUrl } from "./cache";
import { gradeFor } from "./queryset";

/** Declaration order in types.ts; used to sort byCategory deterministically. */
const QUERY_CATEGORY_ORDER: readonly QueryCategory[] = [
    "api-docs",
    "debugging",
    "conceptual",
    "how-to",
    "version-specific",
    "comparison",
    "general",
];

function nuggetWeight(weight: number | undefined): number {
    return weight === undefined ? 1 : weight;
}

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Macro-averages, skipping nulls entirely rather than treating them as 0. */
function meanSkipNulls(values: (number | null)[]): number | null {
    const defined: number[] = [];
    for (const v of values) {
        if (v !== null) defined.push(v);
    }
    if (defined.length === 0) return null;
    return mean(defined);
}

function scoreQuery(result: RunQueryResult, query: Query, label: QueryLabel): QueryScore {
    const matches = matchNuggets(label.nuggets, result.pages);
    const matchByNuggetId = new Map(matches.map((m) => [m.nuggetId, m]));
    const returnedUrls = new Set(result.pages.map((p) => canonicalizeUrl(p.url)));

    let totalWeight = 0;
    let matchedWeight = 0;
    const nuggetsFound: string[] = [];
    const nuggetsMissed: string[] = [];

    // Restricted to nuggets whose declared source page was actually returned.
    let conditionalTotalWeight = 0;
    let conditionalMatchedWeight = 0;
    let hasConditionalNuggets = false;

    for (const nugget of label.nuggets) {
        const weight = nuggetWeight(nugget.weight);
        totalWeight += weight;

        const match = matchByNuggetId.get(nugget.id);
        const matched = match?.matched ?? false;
        if (matched) {
            matchedWeight += weight;
            nuggetsFound.push(nugget.id);
        } else {
            nuggetsMissed.push(nugget.id);
        }

        if (nugget.sources !== undefined && nugget.sources.length > 0) {
            const sourceWasReturned = nugget.sources.some((s) => returnedUrls.has(canonicalizeUrl(s)));
            if (sourceWasReturned) {
                hasConditionalNuggets = true;
                conditionalTotalWeight += weight;
                if (matched) conditionalMatchedWeight += weight;
            }
        }
    }

    const nuggetRecall = totalWeight > 0 ? matchedWeight / totalWeight : 0;
    // null (not 0) when no labeled nugget's source page was returned: the
    // metric is undefined for this query, not "extraction failed".
    const conditionalNuggetRecall = hasConditionalNuggets
        ? conditionalMatchedWeight / conditionalTotalWeight
        : null;

    // Ungraded pages are excluded from both the numerator and denominator.
    let gradedCount = 0;
    let goodOrCanonicalCount = 0;
    const badSourcesReturned: string[] = [];
    for (const page of result.pages) {
        const grade = gradeFor(page.url, label.sources);
        if (grade === null) continue;
        gradedCount++;
        if (grade === "canonical" || grade === "good") goodOrCanonicalCount++;
        if (grade === "bad") badSourcesReturned.push(page.url);
    }
    const sourcePrecision = gradedCount > 0 ? goodOrCanonicalCount / gradedCount : 0;
    // Unlike sourcePrecision, badRate is null (not 0) when no returned page is
    // graded: the metric is undefined for this query, not "no bad sources".
    const badRate = gradedCount > 0 ? badSourcesReturned.length / gradedCount : null;
    const gradedFraction = result.pages.length > 0 ? gradedCount / result.pages.length : 0;

    // Rank by the `rank` field, tie-broken by url, then take the first
    // canonical-graded page's 1/rank.
    const sortedPages = [...result.pages].sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        return a.url.localeCompare(b.url);
    });
    let canonicalMrr = 0;
    for (const page of sortedPages) {
        if (gradeFor(page.url, label.sources) === "canonical") {
            canonicalMrr = 1 / page.rank;
            break;
        }
    }

    const efficiency = result.totalChars > 0 ? matchedWeight / (result.totalChars / 1000) : 0;

    const queryScore: QueryScore = {
        queryId: query.id,
        category: query.category,
        nuggetsFound,
        nuggetsMissed,
        matches,
        nuggetRecall,
        conditionalNuggetRecall,
        sourcePrecision,
        badRate,
        canonicalMrr,
        badSourcesReturned,
        efficiency,
        totalChars: result.totalChars,
        gradedFraction,
    };

    return queryScore;
}

/**
 * Scores a run against the query set and labels. Queries with no label are
 * skipped entirely (and counted); everything else is macro-averaged over
 * the queries that were actually scored.
 */
export function scoreRun(run: Run, queries: Query[], labels: Map<string, QueryLabel>): Scoreboard {
    const queryById = new Map(queries.map((q) => [q.id, q]));

    const byQuery: QueryScore[] = [];
    const skippedQueryIds: string[] = [];

    for (const result of run.results) {
        const label = labels.get(result.queryId);
        const query = queryById.get(result.queryId);
        if (label === undefined || query === undefined) {
            skippedQueryIds.push(result.queryId);
            continue;
        }
        byQuery.push(scoreQuery(result, query, label));
    }

    skippedQueryIds.sort((a, b) => a.localeCompare(b));

    byQuery.sort((a, b) => a.queryId.localeCompare(b.queryId));

    const byCategory: CategoryScore[] = [];
    for (const category of QUERY_CATEGORY_ORDER) {
        const inCategory = byQuery.filter((q) => q.category === category);
        if (inCategory.length === 0) continue;
        byCategory.push({
            category,
            queryCount: inCategory.length,
            nuggetRecall: mean(inCategory.map((q) => q.nuggetRecall)),
            conditionalNuggetRecall: meanSkipNulls(inCategory.map((q) => q.conditionalNuggetRecall)),
            sourcePrecision: mean(inCategory.map((q) => q.sourcePrecision)),
            badRate: meanSkipNulls(inCategory.map((q) => q.badRate)),
            canonicalMrr: mean(inCategory.map((q) => q.canonicalMrr)),
            efficiency: mean(inCategory.map((q) => q.efficiency)),
        });
    }

    return {
        runId: run.id,
        pipeline: run.pipeline,
        queryCount: byQuery.length,
        nuggetRecall: mean(byQuery.map((q) => q.nuggetRecall)),
        conditionalNuggetRecall: meanSkipNulls(byQuery.map((q) => q.conditionalNuggetRecall)),
        sourcePrecision: mean(byQuery.map((q) => q.sourcePrecision)),
        badRate: meanSkipNulls(byQuery.map((q) => q.badRate)),
        canonicalMrr: mean(byQuery.map((q) => q.canonicalMrr)),
        efficiency: mean(byQuery.map((q) => q.efficiency)),
        avgChars: mean(byQuery.map((q) => q.totalChars)),
        skippedQueryIds,
        byCategory,
        byQuery,
    };
}
