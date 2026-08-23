#!/usr/bin/env node

/**
 * peeky-eval - CLI for the evaluation harness.
 *
 * Ties together the corpus cache, query set / labels, pipeline adapters, and
 * scorer into six commands. `record` is the only command allowed to touch
 * the network; everything else replays from the frozen corpus so results are
 * reproducible.
 */

import type { CacheMode, CachedPage } from "./cache";
import { Corpus } from "./cache";
import { adapters as sourceAdapters } from "../v2/fetch";
import type { SourceAdapter } from "../v2/fetch";
import { buildPassages } from "../v2/passages";
import type { Query, QueryLabel, Run, Scoreboard } from "./types";
import type { Block } from "../types";
import { loadQuerySet, loadLabels, validate, ValidationError } from "./queryset";
import { scoreRun } from "./score";
import type { PipelineAdapter } from "./runner";
import { runAll, writeRun, readRun } from "./runner";
import { createV1Adapter } from "./adapters/v1";
import { createV2Adapter } from "./adapters/v2";
import { createOracleAdapter } from "./adapters/oracle";
import { diffScoreboards, formatDiff } from "./diff";
import { preprocessHtml } from "../preprocessing/strip";
import { extractBlocks } from "../preprocessing/segment";
import { isHeadingTag, getHeadingLevel } from "../utils/shared";
import { parseHtml } from "../v2/parse";
import { renderNodesAsMarkdown } from "./adapters/oracle";

const DEFAULT_QUERIES_PATH = "eval/queries/queryset.json";
const DEFAULT_LABELS_DIR = "eval/labels";
const DEFAULT_CORPUS_ROOT = "eval/corpus";
const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8888";

/** Delay between successive live SERP fetches, to be polite to local SearXNG. */
/**
 * Pause between SERP fetches.
 *
 * Deliberately generous. SearXNG's upstream engines rate-limit on sustained
 * traffic, and when they trip they suspend for 300-3600s while SearXNG keeps
 * answering 200 with an EMPTY result list. Recording 140 queries at 500ms once
 * burned an entire tranche exactly that way: the first ~42 recorded cleanly,
 * then every engine suspended in turn and the remaining 87 froze as empty
 * SERPs. Waiting out a suspension costs far more than pacing does.
 */
const SERP_DELAY_MS = 3000;

/**
 * Abort the SERP pass after this many consecutive failures.
 *
 * Once the engines are suspended every subsequent query fails too. Grinding
 * through the rest of the tranche only deepens the rate limit and records
 * nothing, so stop and let the operator wait it out.
 */
const SERP_ABANDON_STREAK = 5;
const DEFAULT_PAGE_CONCURRENCY = 3;
const DEFAULT_RUN_CONCURRENCY = 4;

/**
 * Structured source adapters, in resolver order, MINUS the generic HTML one.
 *
 * The HTML adapter claims every http(s) URL and would re-fetch a page the
 * corpus already holds — and the replay-time fetcher parses that cached HTML
 * anyway. Recording it would spend a request to store a duplicate.
 */
const STRUCTURED_ADAPTERS: SourceAdapter[] = sourceAdapters.filter((a) => a.name !== "html");

/**
 * Per-adapter pause between requests, in milliseconds.
 *
 * Stack Exchange is the one that genuinely needs it: the unauthenticated quota
 * is 300 requests/day per IP and a question costs two (question + answers), so
 * a whole tranche is a meaningful fraction of a day's budget. The others are
 * throttled out of ordinary courtesy rather than necessity.
 */
const ADAPTER_DELAY_MS: Record<string, number> = {
    stackexchange: 1200,
    github: 800,
    registry: 300,
    markdown: 150,
};
const DEFAULT_ADAPTER_DELAY_MS = 500;

/**
 * Give up on an adapter after this many consecutive nulls.
 *
 * For an API-backed adapter a null is a soft failure it cannot distinguish from
 * a hard one — a rate limit, a `backoff` envelope, a 429. A long unbroken run of
 * them almost always means the source has started refusing us, and the correct
 * response to that is to stop cleanly rather than spend the rest of the quota
 * confirming it.
 *
 * The markdown adapter is the exception, and `Infinity` rather than a large
 * number says why: for it a null is not a refusal at all, it is the ordinary
 * answer that this URL has no `.md` sibling. Measured hit rate is roughly 40%
 * of DOC hosts and far lower across a whole SERP, so consecutive misses are the
 * expected case — a streak limit here would abandon the pass twelve URLs in
 * (which is exactly what it did the first time this ran). Its politeness
 * mechanism is its own per-host probe cache, which stops asking a host that has
 * missed three times running.
 */
const ADAPTER_FAILURE_STREAK_LIMIT: Record<string, number> = {
    stackexchange: 12,
    github: 12,
    registry: 12,
    markdown: Number.POSITIVE_INFINITY,
};
const DEFAULT_FAILURE_STREAK_LIMIT = 12;

const HELP_TEXT = `
peeky-eval - Evaluation harness CLI for peeky-search

Scores a pipeline configuration against a frozen corpus using nugget labels.
Only \`record\` touches the network; every other command replays from cache.

Every command that reads a corpus accepts --corpus <path> (default
eval/corpus). A comparison is only meaningful WITHIN one corpus: two
corpora hold different documents, so a number from one says nothing
about a number from the other.

COMMANDS:
  corpus [--check] [--queries <path>] [--corpus <path>]
      Print corpus stats (pages, SERPs, structured docs, revision, root).
      --check also reports how many queries have a cached SERP, and how
      many of those SERPs' URLs have a cached page - the readiness gate
      before a run.

  record [--queries <path>] [--tranche 1|2] [--max-results 20]
         [--concurrency 3] [--refresh] [--corpus <path>] [--engines <names>]
         [--adapters] [--adapter <names>] [--adapter-delay <ms>]
      Populate the corpus. THE ONLY COMMAND ALLOWED TO USE THE NETWORK.
      Resumable and idempotent: skips anything already cached unless
      --refresh. Failures (403s, timeouts, bot walls) are recorded, not
      retried forever.

      --engines passes an explicit comma-separated engine selection to
      SearXNG (e.g. "bing,mojeek"). This reaches engines that settings.yml
      marks disabled WITHOUT editing that file, so the recorder can work
      around a rate-limited engine while the product's own defaults stay
      untouched. The selection is stamped onto each cached SERP: a tranche
      recorded off a different engine set is not comparable to one recorded
      off another, since the retrieval source differs and not just the
      queries. Omit it to use whatever settings.yml enables.

      --adapters additionally runs the v2 structured source adapters
      (stackexchange, github, registry, markdown) over every SERP URL one
      claims, and freezes the resulting Doc in <corpus>/docs. The raw HTML
      is always kept as well, so v1 still has something to read. Requests
      are sequential and throttled per adapter, and an adapter that returns
      a long unbroken run of failures is abandoned rather than hammered.
      --adapter limits the pass to a comma-separated subset.

  docs [--corpus <path>] [--queries <path>] [--tranche 1|2] [--run <runId>]
      Report the structured-document coverage of a corpus: how many Docs,
      from which adapters, how many nodes and endorsement-bearing passages
      they carry, and which of the tranche's SERP URLs they cover. With
      --run, also reports how much of that reached a run's output.

  run [--pipeline v1|v2|oracle] [--queries <path>] [--labels <dir>] [--tranche 1|2]
      [--id <runId>] [--concurrency 4] [--json] [--corpus <path>]
      Replay mode only - never touches the network. Runs the adapter,
      writes eval/runs/<id>.json, scores it, and prints the scoreboard.

  score <runId>
      Re-score an existing run file against current labels and print the
      scoreboard. Useful after editing labels without re-running.

  diff <runA> <runB> [--limit 15] [--verbose]
      Score both runs and print what changed - regressions first.

  dump <queryId> [--chars 6000] [--url <url>] [--parser v2|v1] [--corpus <path>]
      The labeling tool. Prints the cleaned, markdown-rendered text of every
      cached page in a query's SERP, clearly delimited per page. --url
      dumps just one page, in full. Reads pages with the v2 parser - the
      same view the oracle scores against; --parser v1 shows v1's older,
      strictly narrower view for comparison.

ENVIRONMENT:
  SEARXNG_URL   SearXNG instance URL (default: http://localhost:8888)
`;

class CliError extends Error {}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIntArg(value: string, flag: string): number {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        throw new CliError(`invalid value for ${flag}: "${value}" is not a number`);
    }
    return parsed;
}

function parseTrancheArg(value: string): 1 | 2 {
    if (value !== "1" && value !== "2") {
        throw new CliError(`invalid --tranche "${value}" (must be 1 or 2)`);
    }
    return value === "1" ? 1 : 2;
}

/** Splits args into recognized `--flag [value]` pairs and leftover positionals. */
interface ParsedArgs {
    flags: Map<string, string | true>;
    positionals: string[];
}

/** Reads a value-flag as a string, or undefined if not passed. */
function str(flags: Map<string, string | true>, name: string): string | undefined {
    const value = flags.get(name);
    if (value === true) {
        throw new CliError(`--${name} requires a value`);
    }
    return value;
}

/** `boolFlags` are flags that never take a value (e.g. --refresh, --json). */
function parseArgs(args: string[], boolFlags: Set<string>): ParsedArgs {
    const flags = new Map<string, string | true>();
    const positionals: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === undefined) continue;

        if (arg.startsWith("--")) {
            const name = arg.slice(2);
            if (boolFlags.has(name)) {
                flags.set(name, true);
                continue;
            }
            const next = args[i + 1];
            if (next === undefined) {
                throw new CliError(`flag --${name} requires a value`);
            }
            flags.set(name, next);
            i++;
        } else {
            positionals.push(arg);
        }
    }

    return { flags, positionals };
}

/**
 * Which corpus root a command should read.
 *
 * Explicit rather than implied by the pipeline or the command: the harness is
 * about to grow a second corpus recorded with structured adapters active, and
 * silently pointing one pipeline at one root and the other at a different root
 * would produce a comparison of two different universes wearing the costume of
 * a comparison of two pipelines.
 */
function corpusRoot(flags: Map<string, string | true>): string {
    return str(flags, "corpus") ?? DEFAULT_CORPUS_ROOT;
}

function loadQueriesOrFail(path: string, tranche?: 1 | 2): Query[] {
    let queries: Query[];
    try {
        queries = loadQuerySet(path);
    } catch (err) {
        throw new CliError(`failed to load query set at ${path}: ${errMsg(err)}`);
    }
    if (tranche !== undefined) {
        queries = queries.filter((q) => q.tranche === tranche);
    }
    return queries;
}

/**
 * Every query in the set, ignoring any tranche filter.
 *
 * Label validation needs this. Labels live one-per-query in a single directory
 * covering every tranche, so validating them against a tranche-filtered query
 * list reports each label from the OTHER tranche as referencing an unknown
 * query and aborts. Which queries a run executes is a filter; which labels are
 * well-formed is a property of the whole set.
 */
function loadAllQueriesOrFail(path: string): Query[] {
    return loadQueriesOrFail(path);
}

function loadLabelsOrFail(dir: string): { labels: Map<string, QueryLabel>; warnings: string[] } {
    try {
        return loadLabels(dir);
    } catch (err) {
        throw new CliError(`failed to load labels from ${dir}: ${errMsg(err)}`);
    }
}

/** Validates and, on failure, prints every problem to stderr and exits non-zero. */
function validateOrFail(queries: Query[], labels: Map<string, QueryLabel>): void {
    try {
        validate(queries, labels);
    } catch (err) {
        if (err instanceof ValidationError) {
            console.error(`validation failed with ${err.problems.length} problem(s):`);
            for (const problem of err.problems) {
                console.error(`  - ${problem}`);
            }
            process.exitCode = 1;
            throw new CliError("aborting: fix the problems above before running against these labels");
        }
        throw err;
    }
}

function printWarnings(warnings: string[]): void {
    if (warnings.length === 0) return;
    console.error("LABEL WARNINGS");
    for (const warning of warnings) {
        console.error(`  - ${warning}`);
    }
    console.error("");
}

function fmt(value: number, digits = 3): string {
    return value.toFixed(digits);
}

function printScoreboard(scoreboard: Scoreboard): void {
    const totalQueries = scoreboard.queryCount + scoreboard.skippedQueryIds.length;

    console.log("SCOREBOARD");
    console.log(`  run:      ${scoreboard.runId}`);
    console.log(`  pipeline: ${scoreboard.pipeline}`);
    console.log("");

    if (scoreboard.skippedQueryIds.length > 0) {
        console.log(
            `  *** scored ${scoreboard.queryCount} of ${totalQueries} queries ` +
                `(${scoreboard.skippedQueryIds.length} unlabeled, skipped) ***`
        );
        console.log("");
    } else {
        console.log(`  scored ${scoreboard.queryCount} of ${totalQueries} queries`);
        console.log("");
    }

    const avgGradedFraction = mean(scoreboard.byQuery.map((q) => q.gradedFraction));

    console.log("OVERALL");
    console.log(`  nugget recall              ${fmt(scoreboard.nuggetRecall)}`);
    console.log(
        `  conditional nugget recall  ${
            scoreboard.conditionalNuggetRecall === null ? "n/a" : fmt(scoreboard.conditionalNuggetRecall)
        }`
    );
    console.log(
        `  source precision           ${fmt(scoreboard.sourcePrecision)}  ` +
            `(graded fraction: ${fmt(avgGradedFraction)})`
    );
    console.log(
        `  bad rate                   ${
            scoreboard.badRate === null ? "n/a" : fmt(scoreboard.badRate)
        }`
    );
    console.log(`  canonical MRR              ${fmt(scoreboard.canonicalMrr)}`);
    console.log(`  efficiency                 ${fmt(scoreboard.efficiency)} nuggets/1k chars`);
    console.log(`  avg chars                  ${Math.round(scoreboard.avgChars)}`);
    console.log("");

    if (scoreboard.byCategory.length > 0) {
        console.log("BY CATEGORY (worst nugget recall first)");
        const sorted = [...scoreboard.byCategory].sort((a, b) => a.nuggetRecall - b.nuggetRecall);
        for (const c of sorted) {
            const cond = c.conditionalNuggetRecall === null ? " n/a " : fmt(c.conditionalNuggetRecall);
            const badRate = c.badRate === null ? "n/a" : fmt(c.badRate);
            console.log(
                `  ${c.category.padEnd(18)} recall ${fmt(c.nuggetRecall)}  cond ${cond}  ` +
                    `srcPrec ${fmt(c.sourcePrecision)}  badRate ${badRate}  mrr ${fmt(c.canonicalMrr)}  ` +
                    `eff ${fmt(c.efficiency)}  (n=${c.queryCount})`
            );
        }
        console.log("");
    }

    if (scoreboard.byQuery.length > 0) {
        console.log("WORST QUERIES (lowest nugget recall)");
        const worst = [...scoreboard.byQuery]
            .sort((a, b) => {
                const d = a.nuggetRecall - b.nuggetRecall;
                if (d !== 0) return d;
                return a.queryId.localeCompare(b.queryId);
            })
            .slice(0, 10);
        for (const q of worst) {
            console.log(`  ${fmt(q.nuggetRecall, 2)}  [${q.category}]  ${q.queryId}`);
        }
        console.log("");
    }
}

// ---------------------------------------------------------------------------
// corpus
// ---------------------------------------------------------------------------

async function cmdCorpus(args: string[]): Promise<void> {
    const { flags } = parseArgs(args, new Set(["check"]));
    const queriesPath = str(flags, "queries") ?? DEFAULT_QUERIES_PATH;
    const check = flags.get("check") === true;

    const root = corpusRoot(flags);
    const corpus = new Corpus(root, "replay");
    const stats = corpus.stats();

    console.log("CORPUS");
    console.log(`  root:     ${root}`);
    console.log(`  pages:    ${stats.pages}`);
    console.log(`  serps:    ${stats.serps}`);
    console.log(`  docs:     ${stats.docs}`);
    console.log(`  revision: ${corpus.revision()}`);

    if (!check) return;

    const queries = loadQueriesOrFail(queriesPath);

    let serpsCached = 0;
    let urlsTotal = 0;
    let urlsCached = 0;
    let urlsWithDoc = 0;
    const serpSizes: number[] = [];
    const engineCounts = new Map<string, number>();
    for (const query of queries) {
        const serp = corpus.readSerp(query.text);
        if (serp === null) continue;
        serpsCached++;
        serpSizes.push(serp.results.length);
        for (const result of serp.results) {
            urlsTotal++;
            engineCounts.set(result.engine, (engineCounts.get(result.engine) ?? 0) + 1);
            if (corpus.hasPage(result.url)) urlsCached++;
            if (corpus.hasDoc(result.url)) urlsWithDoc++;
        }
    }

    console.log("");
    console.log(`READINESS (${queriesPath}, ${queries.length} queries)`);
    console.log(`  SERPs cached:     ${serpsCached} / ${queries.length}`);
    console.log(`  SERP URLs cached: ${urlsCached} / ${urlsTotal}`);
    console.log(`  SERP URLs w/ doc: ${urlsWithDoc} / ${urlsTotal}`);

    // A cached SERP is not the same as a USABLE one. When the upstream engines
    // rate-limit, SearXNG answers 200 with an empty result list, and a corpus
    // full of those reports "cached" for every query while carrying nothing to
    // retrieve from. Report the shape of what was cached, not just the count.
    if (serpSizes.length > 0) {
        const sorted = [...serpSizes].sort((a, b) => a - b);
        const empty = sorted.filter((n) => n === 0).length;
        const max = sorted[sorted.length - 1] ?? 0;
        const thin = sorted.filter((n) => n > 0 && n < max).length;
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;

        console.log("");
        console.log("  SERP SIZE");
        console.log(`    median results:  ${median}   (max seen ${max})`);
        console.log(`    empty SERPs:     ${empty}`);
        console.log(`    under-full:      ${thin}`);

        const engines = [...engineCounts.entries()].sort((a, b) => b[1] - a[1]);
        const mix = engines.map(([name, n]) => `${name} ${n}`).join(", ");
        console.log(`    engine mix:      ${mix || "none"}`);

        if (empty > 0 || thin > 0) {
            console.log("");
            console.log(
                `  WARNING: ${empty} empty and ${thin} under-full SERPs. Queries recorded`
            );
            console.log(
                "  while the engines were rate-limited look cached but carry no results."
            );
            console.log(
                "  Delete those SERP files and re-record before labeling or trusting a run."
            );
        }
    }
}

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

function classifyError(error: string): string {
    const httpMatch = error.match(/^HTTP (\d+)/);
    if (httpMatch) return `HTTP ${httpMatch[1]}`;
    if (/abort|timeout/i.test(error)) return "timeout";
    if (/enotfound|dns/i.test(error)) return "dns";
    if (/econnrefused|econnreset|socket/i.test(error)) return "connection";
    return "other";
}

/** What one structured-adapter recording pass did, for the summary. */
interface AdapterPassResult {
    /** URLs this adapter claimed and that still needed a Doc. */
    attempted: number;
    /** Docs successfully recorded. */
    recorded: number;
    /** Claimed URLs already holding a Doc, skipped without a request. */
    skipped: number;
    /** Attempts that came back with nothing (rate limit, 404, wrong content type). */
    failed: number;
    /** True when the failure streak limit stopped this adapter early. */
    abandoned: boolean;
}

/**
 * Record structured documents for every URL a source adapter claims.
 *
 * Deliberately sequential per adapter. These are third-party APIs with real
 * quotas — the Stack Exchange one is 300 unauthenticated requests per IP per day
 * and a single question costs two of them — so the recorder trades wall-clock
 * time for being a good citizen. If a source starts refusing us, the streak
 * limit stops the pass cleanly rather than burning the rest of the quota
 * discovering the same thing sixty more times.
 *
 * The raw HTML for these URLs is already in the corpus and is left untouched:
 * a Doc is an ADDITION, so v1 keeps reading exactly what it read before.
 */
async function recordAdapterDocs(
    corpus: Corpus,
    urls: string[],
    selected: SourceAdapter[],
    opts: { refresh: boolean; delayOverride?: number },
): Promise<Map<string, AdapterPassResult>> {
    const summary = new Map<string, AdapterPassResult>();

    // Resolver order decides ownership: the first adapter that claims a URL
    // gets it, so a Stack Exchange link is never also probed for a markdown
    // sibling. `selected` preserves that order.
    const claimedBy = new Map<string, string[]>();
    for (const url of urls) {
        for (const adapter of selected) {
            if (!adapter.canHandle(url)) continue;
            const list = claimedBy.get(adapter.name);
            if (list === undefined) claimedBy.set(adapter.name, [url]);
            else list.push(url);
            break;
        }
    }

    for (const adapter of selected) {
        const claimed = claimedBy.get(adapter.name) ?? [];
        const result: AdapterPassResult = {
            attempted: 0,
            recorded: 0,
            skipped: 0,
            failed: 0,
            abandoned: false,
        };
        summary.set(adapter.name, result);
        if (claimed.length === 0) continue;

        const delay = opts.delayOverride ?? ADAPTER_DELAY_MS[adapter.name] ?? DEFAULT_ADAPTER_DELAY_MS;
        const streakLimit = ADAPTER_FAILURE_STREAK_LIMIT[adapter.name] ?? DEFAULT_FAILURE_STREAK_LIMIT;
        let streak = 0;

        console.log("");
        console.log(`ADAPTER ${adapter.name}  ${claimed.length} claimed URLs, delay ${delay}ms`);

        for (let i = 0; i < claimed.length; i++) {
            const url = claimed[i];
            if (url === undefined) continue;

            if (!opts.refresh && corpus.hasDoc(url)) {
                result.skipped++;
                continue;
            }

            result.attempted++;
            const doc = await adapter.fetch(url);

            if (doc === null || doc.nodes.length === 0) {
                result.failed++;
                streak++;
                if (streak >= streakLimit) {
                    result.abandoned = true;
                    process.stdout.write("\n");
                    console.log(
                        `  stopping ${adapter.name}: ${streak} consecutive failures ` +
                            `(rate limit or source refusing) - ${claimed.length - i - 1} URLs left unrecorded`,
                    );
                    break;
                }
            } else {
                corpus.writeDoc(url, adapter.name, doc);
                result.recorded++;
                streak = 0;
            }

            process.stdout.write(
                `\r  ${adapter.name}: ${i + 1}/${claimed.length}  ` +
                    `(recorded ${result.recorded}, failed ${result.failed}, cached ${result.skipped})   `,
            );
            if (delay > 0) await sleep(delay);
        }
        process.stdout.write("\n");
    }

    return summary;
}

async function cmdRecord(args: string[]): Promise<void> {
    const { flags } = parseArgs(args, new Set(["refresh", "adapters"]));
    const queriesPath = str(flags, "queries") ?? DEFAULT_QUERIES_PATH;
    const trancheArg = str(flags, "tranche");
    const tranche = trancheArg !== undefined ? parseTrancheArg(trancheArg) : undefined;
    const maxResultsArg = str(flags, "max-results");
    const maxResults = maxResultsArg !== undefined ? parseIntArg(maxResultsArg, "--max-results") : 20;
    const concurrencyArg = str(flags, "concurrency");
    const concurrency = concurrencyArg !== undefined
        ? parseIntArg(concurrencyArg, "--concurrency")
        : DEFAULT_PAGE_CONCURRENCY;
    const refresh = flags.get("refresh") === true;
    const engines = str(flags, "engines");
    const root = corpusRoot(flags);

    const adapterNamesArg = str(flags, "adapter");
    // Naming any adapter implies the pass; --adapters alone means all of them.
    const runAdapters = flags.get("adapters") === true || adapterNamesArg !== undefined;
    let selectedAdapters: SourceAdapter[] = STRUCTURED_ADAPTERS;
    if (adapterNamesArg !== undefined) {
        const wanted = adapterNamesArg.split(",").map((n) => n.trim()).filter((n) => n.length > 0);
        for (const name of wanted) {
            if (!STRUCTURED_ADAPTERS.some((a) => a.name === name)) {
                throw new CliError(
                    `unknown adapter "${name}" (known: ${STRUCTURED_ADAPTERS.map((a) => a.name).join(", ")})`,
                );
            }
        }
        selectedAdapters = STRUCTURED_ADAPTERS.filter((a) => wanted.includes(a.name));
    }
    const adapterDelayArg = str(flags, "adapter-delay");
    const adapterDelay =
        adapterDelayArg !== undefined ? parseIntArg(adapterDelayArg, "--adapter-delay") : undefined;

    const queries = loadQueriesOrFail(queriesPath, tranche);
    if (queries.length === 0) {
        throw new CliError("no queries to record (check --queries / --tranche)");
    }

    const mode: CacheMode = refresh ? "refresh" : "record";
    const corpus = new Corpus(root, mode);

    console.log(
        `RECORD  ${queries.length} queries, max-results=${maxResults}, ` +
            `concurrency=${concurrency}, mode=${mode}`
    );
    console.log(`corpus:  ${root}`);
    if (engines !== undefined) console.log(`engines: ${engines}`);
    console.log(`searxng: ${SEARXNG_URL}`);
    if (runAdapters) {
        console.log(`adapters: ${selectedAdapters.map((a) => a.name).join(", ")}`);
    }
    console.log("");

    // Phase 1: SERPs, strictly sequential with a small delay between live
    // fetches. A local SearXNG rate-limits or returns empty results if
    // hammered.
    const serpFailures: Array<{ queryId: string; error: string }> = [];
    const urlSet = new Set<string>();
    let serpsFetched = 0;
    let serpsSkipped = 0;
    let serpFailStreak = 0;
    let serpAborted = false;

    for (let i = 0; i < queries.length; i++) {
        const query = queries[i];
        if (query === undefined) continue;

        const wasCached = mode === "record" && corpus.hasSerp(query.text);
        const serp = await corpus.getSerp(
            query.text,
            SEARXNG_URL,
            maxResults,
            undefined,
            engines
        );
        if (serp.error !== undefined) {
            serpFailures.push({ queryId: query.id, error: serp.error });
            serpFailStreak++;
            if (serpFailStreak >= SERP_ABANDON_STREAK) {
                process.stdout.write("\n");
                console.log("");
                console.log(`  ABORTING: ${serpFailStreak} consecutive SERP failures.`);
                console.log("  The search engines are rate-limited, suspended, or serving captchas.");
                console.log("  Inspect \`docker logs peeky-searxng\`, wait for the suspensions to lapse,");
                console.log("  then re-run this command - it resumes from where it stopped.");
                serpAborted = true;
                break;
            }
        } else {
            serpFailStreak = 0;
        }
        for (const result of serp.results) urlSet.add(result.url);

        if (wasCached) {
            serpsSkipped++;
        } else {
            serpsFetched++;
            await sleep(SERP_DELAY_MS);
        }

        process.stdout.write(
            `\r  serps: ${i + 1}/${queries.length}  ` +
                `(fetched ${serpsFetched}, cached ${serpsSkipped}, failed ${serpFailures.length})   `
        );
    }
    process.stdout.write("\n");

    // A tranche recorded against suspended engines is worse than no tranche at
    // all: the empty SERPs look identical to "this query genuinely has no
    // results", and anything labeled against them is fiction. Stop before the
    // page pass so the operator gets back to waiting rather than spending
    // bandwidth on a corpus that has to be re-recorded anyway.
    if (serpAborted) {
        console.log("");
        console.log("SUMMARY (aborted)");
        console.log(`  serps fetched: ${serpsFetched} (skipped ${serpsSkipped} already cached)`);
        console.log(`  serp failures: ${serpFailures.length}`);
        console.log("");
        console.log("  No pages were fetched. Nothing was cached for the failed queries,");
        console.log("  so re-running this command picks them up from scratch.");
        return;
    }

    const urls = [...urlSet];
    console.log("");
    console.log(`PAGES  ${urls.length} unique URLs from SERPs`);

    // Phase 2: pages, bounded concurrency.
    let pagesDone = 0;
    let pagesFetched = 0;
    let pagesSkipped = 0;
    const pageFailures: Array<{ url: string; error: string }> = [];

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const idx = nextIndex++;
            const url = urls[idx];
            if (url === undefined) return;

            const wasCached = mode === "record" && corpus.hasPage(url);
            let page: CachedPage;
            try {
                page = await corpus.getPage(url);
            } catch (err) {
                pageFailures.push({ url, error: errMsg(err) });
                pagesDone++;
                continue;
            }
            if (page.error !== undefined) {
                pageFailures.push({ url, error: page.error });
            }

            if (wasCached) pagesSkipped++;
            else pagesFetched++;

            pagesDone++;
            process.stdout.write(
                `\r  pages: ${pagesDone}/${urls.length}  ` +
                    `(fetched ${pagesFetched}, cached ${pagesSkipped}, failed ${pageFailures.length})   `
            );
        }
    };

    const workerCount = Math.max(1, Math.min(concurrency, urls.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    process.stdout.write("\n");

    // Phase 3: structured documents. Runs after the HTML pass so that every URL
    // already has a page frozen for it - a Doc supplements the HTML, it never
    // stands in for it.
    let adapterSummary: Map<string, AdapterPassResult> | null = null;
    if (runAdapters) {
        adapterSummary = await recordAdapterDocs(corpus, urls, selectedAdapters, {
            refresh,
            ...(adapterDelay !== undefined ? { delayOverride: adapterDelay } : {}),
        });
    }

    console.log("");
    console.log("SUMMARY");
    console.log(`  queries:       ${queries.length}`);
    console.log(`  serps fetched: ${serpsFetched} (skipped ${serpsSkipped} already cached)`);
    console.log(`  serp failures: ${serpFailures.length}`);
    console.log(`  pages fetched: ${pagesFetched} (skipped ${pagesSkipped} already cached)`);
    console.log(`  page failures: ${pageFailures.length}`);

    if (adapterSummary !== null) {
        console.log("");
        console.log("  structured docs:");
        for (const [name, result] of adapterSummary) {
            const abandoned = result.abandoned ? "  *** ABANDONED (failure streak) ***" : "";
            console.log(
                `    ${name.padEnd(16)} recorded ${String(result.recorded).padStart(4)}  ` +
                    `failed ${String(result.failed).padStart(4)}  ` +
                    `already cached ${String(result.skipped).padStart(4)}${abandoned}`,
            );
        }
        console.log(`    ${"docs on disk".padEnd(16)} ${corpus.stats().docs}`);
    }

    if (pageFailures.length > 0) {
        console.log("");
        console.log("  page failure breakdown:");
        const buckets = new Map<string, number>();
        for (const failure of pageFailures) {
            const key = classifyError(failure.error);
            buckets.set(key, (buckets.get(key) ?? 0) + 1);
        }
        const sortedBuckets = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
        for (const [key, count] of sortedBuckets) {
            console.log(`    ${key.padEnd(24)} ${count}`);
        }
    }

    if (serpFailures.length > 0) {
        console.log("");
        console.log("  serp failures:");
        for (const failure of serpFailures) {
            console.log(`    ${failure.queryId}: ${failure.error}`);
        }
    }
}

// ---------------------------------------------------------------------------
// docs
// ---------------------------------------------------------------------------

function hostOf(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return "(unparseable)";
    }
}

/**
 * Report a corpus's structured-document coverage.
 *
 * The point of this command is to keep one specific claim falsifiable. v2's
 * `endorsement` ranking component only does anything when a passage carries a
 * vote count or an accepted flag, and those exist only on documents a Q&A
 * adapter produced. Reporting a metric improvement without also reporting how
 * many passages `endorsement` actually fired on would leave it impossible to
 * tell an adapter win from an unrelated one, so both are printed together.
 */
async function cmdDocs(args: string[]): Promise<void> {
    const { flags } = parseArgs(args, new Set());
    const root = corpusRoot(flags);
    const queriesPath = str(flags, "queries") ?? DEFAULT_QUERIES_PATH;
    const trancheArg = str(flags, "tranche");
    const tranche = trancheArg !== undefined ? parseTrancheArg(trancheArg) : undefined;
    const runId = str(flags, "run");

    const corpus = new Corpus(root, "replay");
    const docs = corpus.allDocs();

    console.log("STRUCTURED DOCS");
    console.log(`  corpus: ${root}`);
    console.log(`  docs:   ${docs.length}`);
    console.log("");

    if (docs.length === 0) {
        console.log("  (none - record with --adapters to populate)");
        return;
    }

    interface AdapterStats {
        docs: number;
        nodes: number;
        chars: number;
        /** Nodes carrying a vote count or accepted flag. */
        endorsedNodes: number;
        passages: number;
        /** Passages `endorsementScore` would see a signal on - votes or accepted present. */
        endorsedPassages: number;
        hosts: Set<string>;
    }

    const byAdapter = new Map<string, AdapterStats>();
    const docByUrl = new Map<string, (typeof docs)[number]>();

    for (const entry of docs) {
        docByUrl.set(entry.url, entry);
        let stats = byAdapter.get(entry.adapter);
        if (stats === undefined) {
            stats = {
                docs: 0,
                nodes: 0,
                chars: 0,
                endorsedNodes: 0,
                passages: 0,
                endorsedPassages: 0,
                hosts: new Set<string>(),
            };
            byAdapter.set(entry.adapter, stats);
        }
        stats.docs++;
        stats.nodes += entry.doc.nodes.length;
        stats.hosts.add(hostOf(entry.url));
        for (const node of entry.doc.nodes) {
            stats.chars += node.text.length;
            if (node.votes !== undefined || node.accepted !== undefined) stats.endorsedNodes++;
        }
        // Built exactly as the pipeline builds them, so the passage counts here
        // are the same units ranking scores - not an approximation of them.
        for (const passage of buildPassages(entry.doc)) {
            stats.passages++;
            if (passage.votes !== undefined || passage.accepted !== undefined) {
                stats.endorsedPassages++;
            }
        }
    }

    console.log("BY ADAPTER");
    for (const [name, stats] of [...byAdapter.entries()].sort((a, b) => b[1].docs - a[1].docs)) {
        console.log(
            `  ${name.padEnd(16)} docs ${String(stats.docs).padStart(4)}  ` +
                `hosts ${String(stats.hosts.size).padStart(3)}  ` +
                `nodes ${String(stats.nodes).padStart(6)}  ` +
                `chars ${String(stats.chars).padStart(8)}`,
        );
        console.log(
            `  ${"".padEnd(16)} passages ${String(stats.passages).padStart(5)}  ` +
                `endorsement-bearing passages ${String(stats.endorsedPassages).padStart(5)}  ` +
                `(nodes ${stats.endorsedNodes})`,
        );
    }

    const queries = loadQueriesOrFail(queriesPath, tranche);
    const trancheLabel = tranche === undefined ? "all tranches" : `tranche ${tranche}`;

    // Coverage over the URLs the tranche can actually reach: a Doc for a URL no
    // query surfaces cannot move any metric.
    const serpUrls = new Set<string>();
    for (const query of queries) {
        const serp = corpus.readSerp(query.text);
        if (serp === null) continue;
        for (const result of serp.results) serpUrls.add(result.url);
    }

    let covered = 0;
    let deadHtmlRescued = 0;
    const rescuedHosts = new Map<string, number>();
    for (const url of serpUrls) {
        const entry = docByUrl.get(url);
        if (entry === undefined) continue;
        covered++;
        // The URLs that matter most: a Doc exists AND the frozen HTML is
        // unusable, so this is content NO html-reading pipeline could reach.
        const page = corpus.readPage(url);
        const htmlDead =
            page === null ||
            page.error !== undefined ||
            page.status < 200 ||
            page.status >= 300 ||
            page.html.trim().length === 0;
        if (htmlDead) {
            deadHtmlRescued++;
            const host = hostOf(url);
            rescuedHosts.set(host, (rescuedHosts.get(host) ?? 0) + 1);
        }
    }

    console.log("");
    console.log(`COVERAGE (${queriesPath}, ${trancheLabel}, ${queries.length} queries)`);
    console.log(`  SERP URLs:              ${serpUrls.size}`);
    console.log(`  with a structured doc:  ${covered}`);
    console.log(`  ...whose HTML is dead:  ${deadHtmlRescued}   <- unreachable without an adapter`);
    if (rescuedHosts.size > 0) {
        for (const [host, count] of [...rescuedHosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
            console.log(`      ${host.padEnd(32)} ${count}`);
        }
    }

    if (runId === undefined) return;

    // What actually reached the output. A Doc that no query returned is a
    // recorded fact with no measurable consequence, and saying so is the
    // difference between reporting an adapter's effect and reporting its
    // existence.
    let run: Run;
    try {
        run = readRun(runId);
    } catch (err) {
        throw new CliError(errMsg(err));
    }

    const queryIds = new Set(queries.map((q) => q.id));
    let returnedPages = 0;
    let returnedFromDocs = 0;
    let excerptsFromDocs = 0;
    let charsFromDocs = 0;
    const returnedDocHosts = new Map<string, number>();

    // `endorsement` fires on a passage carrying votes or an accepted flag, and
    // the passages it can see are exactly those built from the documents the
    // pipeline actually fetched. `consideredUrls` is that fetch list, so this
    // counts the component's real reach rather than what is sitting on disk.
    let consideredUrls = 0;
    let consideredWithDoc = 0;
    let passagesFromDocs = 0;
    let endorsedPassages = 0;
    let acceptedPassages = 0;
    let queriesWithEndorsement = 0;
    let scoredQueries = 0;

    for (const result of run.results) {
        if (!queryIds.has(result.queryId)) continue;
        scoredQueries++;
        for (const page of result.pages) {
            returnedPages++;
            if (!docByUrl.has(page.url)) continue;
            returnedFromDocs++;
            excerptsFromDocs += page.excerpts.length;
            charsFromDocs += page.charCount;
            const host = hostOf(page.url);
            returnedDocHosts.set(host, (returnedDocHosts.get(host) ?? 0) + 1);
        }

        let endorsedHere = 0;
        for (const url of result.consideredUrls) {
            consideredUrls++;
            const entry = docByUrl.get(url);
            if (entry === undefined) continue;
            consideredWithDoc++;
            for (const passage of buildPassages(entry.doc)) {
                passagesFromDocs++;
                if (passage.votes === undefined && passage.accepted === undefined) continue;
                endorsedPassages++;
                endorsedHere++;
                if (passage.accepted === true) acceptedPassages++;
            }
        }
        if (endorsedHere > 0) queriesWithEndorsement++;
    }

    console.log("");
    console.log(`IN RUN ${run.id} (${run.pipeline})`);
    console.log(`  pages returned:            ${returnedPages}`);
    console.log(`  ...backed by a doc:        ${returnedFromDocs}`);
    console.log(`  excerpts from those pages: ${excerptsFromDocs}`);
    console.log(`  chars from those pages:    ${charsFromDocs}`);
    for (const [host, count] of [...returnedDocHosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
        console.log(`      ${host.padEnd(32)} ${count}`);
    }

    console.log("");
    console.log("ENDORSEMENT REACH");
    console.log(`  candidate URLs fetched:      ${consideredUrls}`);
    console.log(`  ...with a structured doc:    ${consideredWithDoc}`);
    console.log(`  passages built from those:   ${passagesFromDocs}`);
    console.log(`  ...votes or accepted flag:   ${endorsedPassages}   <- endorsement fires on these`);
    console.log(`  ...accepted answers:         ${acceptedPassages}`);
    console.log(`  queries with >=1 such passage: ${queriesWithEndorsement} / ${scoredQueries}`);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function cmdRun(args: string[]): Promise<void> {
    const { flags } = parseArgs(args, new Set(["json"]));
    const pipeline = str(flags, "pipeline") ?? "v1";
    const queriesPath = str(flags, "queries") ?? DEFAULT_QUERIES_PATH;
    const labelsDir = str(flags, "labels") ?? DEFAULT_LABELS_DIR;
    const trancheArg = str(flags, "tranche");
    const tranche = trancheArg !== undefined ? parseTrancheArg(trancheArg) : undefined;
    const runId = str(flags, "id");
    const concurrencyArg = str(flags, "concurrency");
    const concurrency = concurrencyArg !== undefined
        ? parseIntArg(concurrencyArg, "--concurrency")
        : DEFAULT_RUN_CONCURRENCY;
    const json = flags.get("json") === true;

    if (pipeline !== "v1" && pipeline !== "v2" && pipeline !== "oracle") {
        throw new CliError(`unknown pipeline "${pipeline}" (must be "v1", "v2" or "oracle")`);
    }

    const queries = loadQueriesOrFail(queriesPath, tranche);
    if (queries.length === 0) {
        throw new CliError("no queries to run (check --queries / --tranche)");
    }

    const { labels, warnings } = loadLabelsOrFail(labelsDir);
    validateOrFail(loadAllQueriesOrFail(queriesPath), labels);
    printWarnings(warnings);

    const root = corpusRoot(flags);
    const corpus = new Corpus(root, "replay");
    let adapter: PipelineAdapter;
    if (pipeline === "oracle") {
        adapter = createOracleAdapter();
    } else if (pipeline === "v2") {
        adapter = createV2Adapter();
    } else {
        adapter = createV1Adapter({ searxngUrl: SEARXNG_URL });
    }

    console.error(
        `running ${queries.length} queries through ${adapter.name} ` +
            `(concurrency ${concurrency}, corpus ${root})...`
    );

    const run = await runAll(adapter, queries, corpus, {
        concurrency,
        ...(runId !== undefined && { id: runId }),
        onProgress: (done, total) => {
            process.stderr.write(`\r  ${done}/${total}   `);
        },
    });
    process.stderr.write("\n");

    const path = writeRun(run);
    console.error(`wrote ${path}`);

    const scoreboard = scoreRun(run, queries, labels);

    if (json) {
        console.log(JSON.stringify(scoreboard, null, 2));
    } else {
        printScoreboard(scoreboard);
    }
}

// ---------------------------------------------------------------------------
// score
// ---------------------------------------------------------------------------

async function cmdScore(args: string[]): Promise<void> {
    const { positionals } = parseArgs(args, new Set());
    const runId = positionals[0];
    if (runId === undefined) {
        throw new CliError("usage: peeky-eval score <runId>");
    }

    let run: Run;
    try {
        run = readRun(runId);
    } catch (err) {
        throw new CliError(errMsg(err));
    }

    const queries = loadQueriesOrFail(DEFAULT_QUERIES_PATH);
    const { labels, warnings } = loadLabelsOrFail(DEFAULT_LABELS_DIR);
    validateOrFail(queries, labels);
    printWarnings(warnings);

    const scoreboard = scoreRun(run, queries, labels);
    printScoreboard(scoreboard);
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

async function cmdDiff(args: string[]): Promise<void> {
    const { flags, positionals } = parseArgs(args, new Set(["verbose"]));
    const runAId = positionals[0];
    const runBId = positionals[1];
    if (runAId === undefined || runBId === undefined) {
        throw new CliError("usage: peeky-eval diff <runA> <runB> [--limit 15] [--verbose]");
    }
    const limitArg = str(flags, "limit");
    const limit = limitArg !== undefined ? parseIntArg(limitArg, "--limit") : 15;
    const verbose = flags.get("verbose") === true;

    let runA: Run;
    let runB: Run;
    try {
        runA = readRun(runAId);
    } catch (err) {
        throw new CliError(errMsg(err));
    }
    try {
        runB = readRun(runBId);
    } catch (err) {
        throw new CliError(errMsg(err));
    }

    const queries = loadQueriesOrFail(DEFAULT_QUERIES_PATH);
    const { labels, warnings } = loadLabelsOrFail(DEFAULT_LABELS_DIR);
    validateOrFail(queries, labels);
    printWarnings(warnings);

    const scoreboardA = scoreRun(runA, queries, labels);
    const scoreboardB = scoreRun(runB, queries, labels);
    const diff = diffScoreboards(scoreboardA, scoreboardB);

    console.log(formatDiff(diff, { limit, verbose }));
}

// ---------------------------------------------------------------------------
// dump
// ---------------------------------------------------------------------------

/**
 * Renders v1's extracted blocks as markdown: headings, fenced code, list
 * items. Reachable only via `dump --parser v1`; the default path renders v2
 * nodes with `renderNodesAsMarkdown`, which is the same renderer the oracle
 * uses, so a nugget authored from a dump is matched against identical text.
 */
function renderBlocksAsMarkdown(blocks: Block[]): string {
    const lines: string[] = [];

    for (const block of blocks) {
        if (block.type === "pre") {
            lines.push("```");
            lines.push(block.text);
            lines.push("```");
        } else if (isHeadingTag(block.type)) {
            const level = getHeadingLevel(block.type) ?? 1;
            lines.push(`${"#".repeat(level)} ${block.text}`);
        } else if (block.type === "li") {
            lines.push(`- ${block.text}`);
        } else {
            lines.push(block.text);
        }
        lines.push("");
    }

    return lines.join("\n").trim();
}

async function cmdDump(args: string[]): Promise<void> {
    const { flags, positionals } = parseArgs(args, new Set());
    const queryId = positionals[0];
    if (queryId === undefined) {
        throw new CliError(
            "usage: peeky-eval dump <queryId> [--chars 6000] [--url <url>] [--parser v2|v1]"
        );
    }
    const charsArg = str(flags, "chars");
    const chars = charsArg !== undefined ? parseIntArg(charsArg, "--chars") : 6000;
    const onlyUrl = str(flags, "url");
    // v2 is the default: it is what the oracle scores against and what the
    // shipping pipeline reads. v1 stays reachable so the two views can be
    // compared on a page where they disagree.
    const parser = str(flags, "parser") ?? "v2";
    if (parser !== "v1" && parser !== "v2") {
        throw new CliError(`invalid --parser "${parser}" (must be v1 or v2)`);
    }

    const queries = loadQueriesOrFail(DEFAULT_QUERIES_PATH);
    const query = queries.find((q) => q.id === queryId);
    if (query === undefined) {
        throw new CliError(`unknown query id "${queryId}"`);
    }

    const corpus = new Corpus(corpusRoot(flags), "replay");
    const serp = corpus.readSerp(query.text);
    if (serp === null) {
        throw new CliError(
            `no cached SERP for query "${queryId}" ("${query.text}") - run \`peeky-eval record\` first`
        );
    }

    console.log(`QUERY ${query.id}`);
    console.log(`  text:     ${query.text}`);
    console.log(`  category: ${query.category}`);
    console.log(`  parser:   ${parser}`);
    console.log("");

    let urls = serp.results.map((r) => r.url);
    if (onlyUrl !== undefined) {
        const matched = urls.filter((u) => u === onlyUrl);
        urls = matched.length > 0 ? matched : [onlyUrl];
    }

    let n = 0;
    for (const url of urls) {
        n++;
        console.log(`=== [${n}] ${url} ===`);

        // A recorded structured Doc is what the v2 parser view actually reads
        // for this URL, so a labeler must see it rather than the HTML it
        // supersedes - otherwise nuggets get authored against text no pipeline
        // will ever return. v1's view is unaffected: it has no way to use a Doc.
        const structured = parser === "v2" ? corpus.readDoc(url) : null;
        if (structured !== null && structured.doc.nodes.length > 0) {
            console.log(`  source: ${structured.adapter} adapter (structured doc, recorded ${structured.fetchedAt})`);
            console.log(`  title: ${structured.doc.title !== "" ? structured.doc.title : url}`);
            console.log("");
            const markdown = renderNodesAsMarkdown(structured.doc.nodes);
            const full = onlyUrl !== undefined;
            console.log(full ? markdown : markdown.slice(0, chars));
            if (!full && markdown.length > chars) {
                console.log("");
                console.log(
                    `  ... [truncated, ${markdown.length - chars} more chars; ` +
                        `use --url "${url}" to dump this page in full]`
                );
            }
            console.log("");
            continue;
        }

        const page = corpus.readPage(url);
        if (page === null) {
            console.log("  (not cached - run `peeky-eval record`)");
            console.log("");
            continue;
        }
        if (page.error !== undefined) {
            console.log(`  FETCH ERROR: ${page.error}`);
            console.log("");
            continue;
        }

        let markdown: string;
        if (parser === "v1") {
            const { $, mainContent } = preprocessHtml(page.html);
            const title = $("title").first().text().trim() || url;
            console.log(`  title: ${title}`);
            console.log("");

            if (mainContent === null) {
                console.log("  (no main content detected)");
                console.log("");
                continue;
            }
            markdown = renderBlocksAsMarkdown(extractBlocks($, mainContent));
        } else {
            let doc;
            try {
                doc = parseHtml(page.html, url, {
                    ...(page.finalUrl !== undefined ? { finalUrl: page.finalUrl } : {}),
                });
            } catch (err) {
                console.log(`  PARSE ERROR: ${errMsg(err)}`);
                console.log("");
                continue;
            }
            console.log(`  title: ${doc.title !== "" ? doc.title : url}`);
            console.log("");

            if (doc.nodes.length === 0) {
                console.log("  (no content extracted)");
                console.log("");
                continue;
            }
            markdown = renderNodesAsMarkdown(doc.nodes);
        }

        const full = onlyUrl !== undefined;
        const shown = full ? markdown : markdown.slice(0, chars);

        console.log(shown);
        if (!full && markdown.length > chars) {
            console.log("");
            console.log(
                `  ... [truncated, ${markdown.length - chars} more chars; ` +
                    `use --url "${url}" to dump this page in full]`
            );
        }
        console.log("");
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const args = process.argv.slice(2).filter((a) => a !== "--");
    const command = args[0];
    const rest = args.slice(1);

    try {
        switch (command) {
            case "corpus":
                await cmdCorpus(rest);
                break;
            case "record":
                await cmdRecord(rest);
                break;
            case "docs":
                await cmdDocs(rest);
                break;
            case "run":
                await cmdRun(rest);
                break;
            case "score":
                await cmdScore(rest);
                break;
            case "diff":
                await cmdDiff(rest);
                break;
            case "dump":
                await cmdDump(rest);
                break;
            case "--help":
            case "-h":
            case "help":
            case undefined:
                console.log(HELP_TEXT);
                break;
            default:
                console.error(`Unknown command: ${command}`);
                console.error("Run 'peeky-eval --help' for usage.");
                process.exitCode = 1;
        }
    } catch (err) {
        if (err instanceof CliError) {
            if (err.message.length > 0) console.error(`error: ${err.message}`);
            process.exitCode = 1;
            return;
        }
        throw err;
    }
}

main().catch((err) => {
    console.error(`Unexpected error: ${errMsg(err)}`);
    process.exitCode = 1;
});
