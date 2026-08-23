# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

peeky-search is an MCP web-search server for coding agents. It queries a local SearXNG instance, fetches the result pages, and returns **verbatim excerpts** from them rather than an LLM summary — you are not summarizing a summary, you are reading the source.

**Read this first: there are two pipelines in this repository, and only one of them runs.**

| | v2 (`src/v2/`) | v1 (`src/pipeline.ts`, `src/scoring/`, `src/extraction/`) |
|---|---|---|
| MCP `peeky_web_search` | **serves this** | no |
| MCP `peeky_fetch_page` | **serves this** | no |
| MCP `peeky_find_sources` | **serves this** | no |
| CLI `--search --pipeline v2` | yes | — |
| CLI `--search` (default), `--fetch`, `--url`, `--file` | — | yes |
| Eval harness `--pipeline v1` | — | yes |

**v1 is retained on purpose and must not be deleted or "cleaned up".** `src/eval/adapters/v1.ts` injects fetchers into its `search()` to reproduce the measured baseline, and a baseline you cannot re-run is not a baseline. That extends to v1's known bugs — see [Known v1 bugs, deliberately unfixed](#known-v1-bugs-deliberately-unfixed).

**Measured result** (tranche 2, held out, n=134): v2 nugget recall **0.458** vs v1 **0.338**. Source precision 0.774 vs 0.737, canonical MRR 0.325 vs 0.237, bad rate a tie at 0.042 vs 0.041, and v2 spends more characters (10.5k vs 7.1k). The tuning-set figure was +0.201 and was inflated by overfitting; quote the held-out number.

## Build & Run Commands

```bash
pnpm build          # Compile TypeScript via tsup to dist/
pnpm build:watch    # Watch mode compilation
pnpm build:tsc      # Type-check only (tsc)
pnpm start          # Run CLI (dist/cli.js)
pnpm mcp            # Run MCP server (dist/cli.js mcp)
pnpm eval           # Run the evaluation harness CLI (dist/eval/cli.js)
pnpm test           # Run tests in watch mode (vitest)
pnpm test:run       # Run tests once
pnpm test:coverage  # Run tests with coverage report
```

**`build:tsc` overwrites the bundled `dist/eval/cli.js` with a broken one.** Always run `pnpm build` after a type-check pass, or `pnpm eval` will fail in a confusing way.

`pnpm` may not be on PATH; `npx --yes pnpm@10.14.0 <script>` works.

**CLI usage:**
```bash
# Setup (src/cli.ts)
npx peeky-search setup              # One-time setup (starts SearXNG in Docker)
npx peeky-search setup --check      # Check prerequisites only
npx peeky-search start|stop|status  # Manage the SearXNG container
npx peeky-search uninstall          # Remove all config

# Extraction (src/index.ts)
node dist/cli.js --search --query "..." [--max 5] [--pipeline v2]
node dist/cli.js --url "https://..." --query "..."       # v1
node dist/cli.js --fetch --url "https://..."             # v1
node dist/cli.js --query "..." --file page.html --debug  # v1
```

## Project Structure

```
src/
├── cli.ts                # Unified CLI entry (setup/start/stop/status/mcp)
├── index.ts              # Extraction entry (file/URL/search/fetch modes)
├── types.ts              # v1 shared types
├── pipeline.ts           # v1 pipeline orchestrator
│
├── v2/                   # THE PIPELINE THAT RUNS
│   ├── types.ts          # Doc / DocNode / Passage / PassageScore / Authority
│   ├── parse.ts          # HTML -> DocNode tree (the semantic parser)
│   ├── pagekind.ts       # reference/guide/qa/issue/changelog/spec/blog/listicle
│   ├── passages.ts       # DocNodes -> passages (the retrieval unit)
│   ├── query.ts          # Query understanding: operators, error strings, symbols, versions
│   ├── rank.ts           # Passage scoring over ONE corpus-wide candidate pool
│   ├── authority.ts      # Source trust, independent of text match
│   ├── assemble.ts       # Budget-aware selection (score-per-character)
│   ├── rerank.ts         # OPTIONAL cross-encoder stage. Off. Do not turn on — see below
│   ├── pipeline.ts       # searchV2(): stage orchestration + resolved config
│   └── fetch/
│       ├── resolver.ts   # Adapter priority: stackexchange > github > registry > markdown > html
│       ├── stackexchange.ts  # API (votes, accepted flags) — SO 403s every scraper
│       ├── github.ts     # API / raw README
│       ├── registry.ts   # npm registry metadata, homepage resolution
│       ├── markdown.ts   # .md siblings, llms.txt
│       └── html.ts       # Generic HTML, via parse.ts
│
├── eval/                 # Evaluation harness (dev tooling; see below)
│   ├── cli.ts            # peeky-eval: corpus/record/docs/run/score/diff/dump
│   ├── cache.ts          # Content-addressed corpus: pages/ serp/ docs/
│   ├── queryset.ts       # Query set + label loading and validation
│   ├── nuggets.ts        # The matcher. Strict, deterministic, model-free
│   ├── score.ts          # Scoreboard: macro-averaged metrics
│   ├── runner.ts         # Run execution and run-file IO
│   ├── diff.ts           # Run-to-run comparison
│   └── adapters/         # v1.ts, v2.ts, oracle.ts
│
├── mcp/
│   ├── server.ts         # MCP entry. All three tools are wired to orchestrator-v2
│   ├── orchestrator-v2.ts    # runSearchV2() + formatters + fetchPageV2() — WHAT SHIPS
│   ├── orchestrator.ts   # v1 search/fetchPage + session dedup. Baseline only
│   ├── query-parser.ts   # v1 operator parsing (v2/query.ts mirrors it exactly)
│   ├── searxng.ts        # SearXNG API client
│   └── scraper.ts        # v1 parallel scraper
│
├── preprocessing/        # v1: strip.ts, segment.ts, tokenize.ts
├── scoring/              # v1: bm25.ts, heuristics.ts, quality.ts, ranker.ts
├── extraction/           # v1: anchors.ts, expand.ts, dedupe.ts
├── output/excerpts.ts    # v1 excerpt assembly
├── setup/                # Docker/SearXNG setup and management
└── utils/logger.ts       # Singleton logger

eval/                     # Harness DATA. Mostly gitignored — see below
├── queries/queryset.json # 200 queries. COMMITTED (it is source)
├── LABELING.md           # The labeling rubric. COMMITTED
├── labels/               # NOT COMMITTED
├── corpus/               # NOT COMMITTED
└── runs/                 # NOT COMMITTED
```

`tokenize.ts` and `bm25.ts` are shared: v2 uses v1's tokenizer and IDF primitives. They are not v1-only code.

## Architecture

### The three MCP tools

| Tool | Returns | Typical output |
|---|---|---|
| `peeky_web_search` | verbatim excerpts, heading path, source URL | ~11k chars |
| `peeky_find_sources` | ranked URL list: kind, source, authority, one teaser line | ~1.7k chars |
| `peeky_fetch_page` | one page, whole or query-focused | ≤12k chars |

Tool descriptions are the only part of this package that costs a caller tokens on **every** turn. The current three total ~1,030 tokens on the wire; the previous two totalled ~1,460. Operator syntax is stated once, in a shared `OPERATORS` constant. **When editing a description, check the wire size rather than the source length** — the JSON schema is half of it.

### v2 pipeline

```
parseQuery -> fetch docs -> detect page kind -> build passages
    -> score ALL passages against ONE corpus-wide candidate set
    -> score each source's authority
    -> assemble under budget
```

1. **Query understanding** (`query.ts`): separates search operators from extraction text (mirroring `mcp/query-parser.ts` step-for-step so v1's dork syntax keeps working), then pulls out error strings, code symbols, versions, and quoted phrases as high-signal exact anchors.
2. **Fetch** (`fetch/resolver.ts`): first adapter whose `canHandle` claims the URL wins, falling through on failure. Structured sources are tried before generic HTML, which claims everything.
3. **Parse** (`parse.ts`): HTML into a typed `DocNode` tree. Keeps code-block languages, tables, links with anchor text, dates, and Q&A vote/accepted signals.
4. **Page kind** (`pagekind.ts`): detected from the document, never supplied by the caller — the page already announces what it is.
5. **Passages** (`passages.ts`): contiguous runs of nodes sharing a heading path, split only at node boundaries. Then coalesced in `pipeline.ts` to ~900 chars: `buildPassages` segments correctly but produces the wrong *retrieval* unit, because BM25 hands a perfect score to a 123-character fragment.
6. **Rank** (`rank.ts`): BM25 0.30, exact anchors 0.35, heading match 0.13, structure 0.10, endorsement 0.18, semantic 0. `b = 0.45`, well below v1's 0.75 — document-calibrated length normalization applied to passages prefers captions to explanations.
7. **Authority** (`authority.ts`): positive (declared homepage, standards body, primary source, project docs, peer citation) and negative (link index, no substance, thin body, self-promotion, social platform, listicle) signals, each stating a mechanism about the *document as parsed*. Reorders strongly, suppresses only at the floor.
8. **Assemble** (`assemble.ts`): greedy under a character budget, ordered by score **per character**, with document diversity, novelty, coverage re-decided each round, and a relevance floor. It never pads to fill the budget.

**The single most important structural fact:** v1 ranks each page in isolation, so IDF is computed per page. v2 scores every passage from every fetched document in one pool. That is where most of the gain lives.

**`rerank.ts` is off and stays off.** A cross-encoder was measured in seven configurations and lost 0.054-0.077 recall in every one, with every confidence interval excluding zero, at +2.0s/query. Fine-tuning one on our labels needs ~100k queries; the whole set is 200. The experiment that produced those numbers is not in the repository — it was scratch code with a large ML dependency, and the result is the part worth keeping. `@huggingface/transformers` is not a dependency in any position; `createTransformersScorer` reaches it through a dynamic import if someone installs it.

### MCP path

`src/mcp/orchestrator-v2.ts` is deliberately thin: SERP → session dedup → `searchV2`. **No blocked-domain list, no pre-scrape title filter, no URL dedup.** Those are v1 stages, and `src/eval/adapters/v2.ts` — the thing every measured number describes — hands raw SERP URLs straight to `searchV2`. Adding filters here would mean shipping a pipeline the harness never scored, which is exactly the gap that let the live parser diverge from the eval for weeks. **Keep this path equal to the measured one.**

Session dedup is the one exception, and it is cross-call state about what the caller has seen, not a judgement about page quality. Keys are `url:sortedQueryTokens` composites, so the same URL is re-fetched for a different query (extraction is query-dependent) but skipped for the same one.

SearXNG is asked for `maxResults * 2` URLs because v2 drops documents that fail to fetch or bottom out on authority.

`fetchPageV2` exists for **capability**, not scoring: v1's `fetchPage` is a raw HTML GET, so Stack Overflow (403s every UA) and GitHub (JS-rendered) always failed. With a query it runs the same `searchV2` used by search, so ranking and assembly match; without one it returns the whole readable document in order up to 12,000 chars.

**`diagnostics` was removed from the MCP schema.** It reported on v1 filter stages this path does not have. An argument a model can pass that silently does nothing is worse than no argument.

`peeky_find_sources` is the same run, listed rather than quoted: `runSearchV2` with `SURVEY_BUDGET` and a different formatter, so its ORDERING is identical to what `peeky_web_search` would have produced. Three things about it are load-bearing:

- **It cannot skip assembly.** A page reaches `V2Result.pages` only if assembly selected a passage from it, so a survey has to re-budget (one short passage per doc, from many docs) rather than bypass the stage.
- **`relevanceFloor` drops to 0.15.** The 0.35 default is the "never pad the budget" rule, which is right when every character is quoted back and wrong for a survey — ask for ten sources at 0.35 and you get four, with no sign the other six existed.
- **`pageOrder.canonicalFirst` is on.** Canonical documents sort ahead of everything else before the score key is consulted. Under the default multiplicative `canonicalBoost` alone, whether the project's own manual leads depends on the SERP position it drew that minute: measured live on "react useEffect cleanup function", react.dev's best passage scores 0.750 against w3schools' 0.795, so it led on one call and sat behind a blog on the next. **This is coupled to the floor above** — a partition can only reorder pages assembly selected, and at 0.35 an outmatched canonical page is dropped from the result entirely, leaving nothing to promote. Raising the floor back silently re-breaks it.
- **It does NOT write to the session.** The caller has been *told* about these pages, not shown them; recording them would make the follow-up `peeky_web_search` skip its own recommendations. Hence `recordSession: false`.

`Authority.canonical` is tight enough to partition on: it needs a structural claim (declared homepage, standards body, primary source, the project's own domain serving its own docs, enough peer citations) or a score at or above `canonicalThreshold` — and that threshold is evaluated inside `scoreAuthority`, **before** `applySerpPrior`, so ranking well can never make a page canonical. What it does *not* cover is a documentation site that is neither the project's domain nor a standards body: MDN on a CSS query scores 0.85 and is not flagged, so the partition is a no-op there. `canonicalHosts` is the field designed for that and nothing populates it on the MCP path yet.

`SURVEY_BUDGET` and `SURVEY_PAGE_ORDER` are **not measured** — every published number describes the search budget and the multiplicative boost. The metrics that would judge it (`sourcePrecision`, `canonicalMrr`, `badRate`) are page-level and already exist, so it is scoreable against the current labels as soon as a corpus is recorded.

**`finalUrl` means "the fetch followed a redirect", not "where the bytes came from".** The formatters cite `finalUrl ?? url`, so an adapter that sets it to a machine-readable endpoint hands the model that endpoint to quote and follow. The markdown adapter used to set it to the `.md` sibling and the registry adapter to `registry.npmjs.org/…`; both now leave it unset, and only `html.ts` — where it is a genuine redirect target — still sets it.

### v1 pipeline (baseline only)

Preprocess → segment into sentences → quality gate → tokenize → rank (BM25 0.6 + nine heuristics 0.4) → select anchors → expand context → dedupe → assemble. Heuristic weights: headingPath 0.17, coverage 0.16, proximity 0.14, headingProximity 0.11, structure 0.11, density 0.09, outlier 0.09, metaSection 0.08, position 0.05. Two relevance modes, strict (single page) and search (multi-page). `docs/algorithm-walkthrough.md` traces it end to end.

### Key data types

```typescript
// v2 — src/v2/types.ts
type NodeKind = "heading" | "prose" | "code" | "list-item" | "table"
              | "quote" | "callout" | "definition" | "question" | "answer";
type PageKind = "reference" | "guide" | "qa" | "issue" | "changelog"
              | "spec" | "blog" | "listicle" | "unknown";
type DocSource = "html" | "markdown" | "stackexchange" | "github" | "registry";

interface DocNode {
    kind: NodeKind; text: string; order: number; headingPath: string[];
    level?: number; lang?: string; links?: DocLink[];
    votes?: number; accepted?: boolean; author?: string; date?: string;
}

interface Doc {
    url: string; finalUrl?: string; title: string;
    kind: PageKind; source: DocSource; nodes: DocNode[];
    publishedAt?: string; lang?: string; kindEvidence?: string;
}

// v1 — src/types.ts: Sentence, ScoredSentence, Chunk, RankingResult
```

## Evaluation harness

The harness came first, before the rewrite: every v1 constant was hand-tuned with no scoreboard, and there was no way to tell whether a change helped. It is dev tooling and it ships in the package (`peeky-eval`), but it needs a corpus and labels the user supplies.

### The three phases

1. **Label, once.** A human or a model reads the full text of every cached page for a query (`peeky-eval dump <queryId>`) and writes the atomic facts a good answer must contain, plus a grade per source. Rubric: `eval/LABELING.md`.
2. **Replay, offline.** `record` is the only command allowed to touch the network. Everything else replays the frozen corpus, so a run is a pure function of (config, corpus, query set).
3. **Score, deterministically.** Substring matching over anchors. Macro-averaged over queries.

### Why there is no LLM judge

Judge-to-judge noise is larger than the ~2% effects that need detecting, so an LLM judge would still produce a number and it would still be believed. Intelligence goes in at *authoring* time; scoring stays model-free, which is what makes the loop cost seconds and makes runs a week apart comparable.

### Label format

```jsonc
{
  "id": "n2",
  "text": "Human-readable fact. Never used for matching.",
  "anchors": [["cleanup", "teardown"], ["dependenc", "deps"]],  // ALL groups; ANY term in a group
  "pattern": "optional regex, case-insensitive",
  "window": 220,     // MANDATORY: max chars between first and last matched anchor
  "weight": 1,       // 2 only when missing it makes the whole result useless
  "sources": ["https://..."]   // pages you confirmed state this fact
}
```

Terms are lowercase substrings, so stem-like prefixes (`dependenc`) cover the family without a stemmer at eval time. **`window` is mandatory** — without it a nugget "matches" because its terms are scattered across an unrelated 3k excerpt.

Source grades: `canonical` (the authoritative source), `good`, `acceptable` (partially useful), `bad` (SEO farm, wrong, contentless). **Grade content, never parseability** — a page the pipeline could not read is not thereby a bad source.

### Metrics (`src/eval/score.ts`)

| Metric | Meaning |
|---|---|
| `nuggetRecall` | Weighted fraction of labeled facts present in the output. The headline. |
| `conditionalNuggetRecall` | Restricted to nuggets whose declared source page was returned. Isolates extraction from retrieval. `null`, not 0, when undefined. |
| `sourcePrecision` | Graded pages that are `canonical`/`good`. Ungraded pages excluded from both sides. |
| `badRate` | Graded pages that are `bad`. Separate from `sourcePrecision` because `acceptable` ≠ `bad`. `null` when no page is graded. |
| `canonicalMrr` | 1/rank of the first `canonical` page. |
| `efficiency` | Matched nuggets per 1k chars. Secondary — recall and source precision are the primary targets. |

### The corpus

Content-addressed, three directories: `pages/` (raw HTML), `serp/` (search results with the engine selection stamped on each), `docs/` (serialized v2 `Doc`s from structured adapters, recorded because those adapters cannot run during an offline replay).

Two invariants keep the v1-vs-v2 comparison honest:
- A recorded `Doc` **never replaces** the raw HTML. Both are stored, so both pipelines see the same universe of URLs.
- `docs/` is optional and lazily created; a corpus recorded before it existed reads back byte-identical, revision included.

**Numbers from two different corpora are not comparable.** Different documents, recorded at different times, possibly off different engines.

### Tranches

Tranche 1 (60 queries) is the tuning set — ~40 design decisions have seen it. Tranche 2 (140 queries, 134 labeled) is **held out**: labeled after v2 was finished, reported once. That gap is why the honest gain is +0.120 and not the +0.201 tranche 1 showed.

### Commands

```bash
pnpm eval corpus --check                 # readiness gate: SERPs cached, pages cached, engine mix
pnpm eval record --tranche 2 --adapters  # ONLY networked command; resumable, idempotent
pnpm eval run --pipeline v2 --tranche 2 --id t2-v2
pnpm eval score t2-v2                    # re-score after editing labels
pnpm eval diff t2-v1 t2-v2               # regressions first
pnpm eval dump <queryId> [--url <url>]   # the labeling view
pnpm eval docs                           # structured-doc coverage
```

`--pipeline oracle` runs a selector that can see the answer key — the ceiling the candidate pool allows (0.963 recall in a median 3,589 chars). Use it to tell "the content was never fetched" apart from "the content was fetched and not selected".

### What is not committed, and why

`eval/labels/`, `eval/corpus/`, `eval/corpus-*/`, `eval/runs/` and `eval/experiments/` are gitignored. The corpus is other people's pages. The labels are a permanent, machine-readable, publicly attributed judgement on named third-party sites — sound method, bad thing to publish from a repository whose job is to distribute search machinery. **Do not commit them, and do not "helpfully" remove them from `.gitignore`.**

Consequence for tooling: `eval/labels/` exists only on the machine that authored it, and git will not warn before an operation destroys ignored files. Treat it as unbacked user data.

**This has already happened once.** `eval/corpus/` was lost; `eval/labels/` survived in a separate backup directory and was restored (194 of 200 queries). That asymmetry is worth knowing because the two halves cost very different amounts to rebuild: the corpus is a `peeky-eval record` pass — hours of paced network, bounded by Stack Exchange's 300 requests/day — while the labels are the expensive, human-authored half. **Back up `eval/labels/` deliberately; the corpus can always be re-recorded.** Note that numbers from a re-recorded corpus are not comparable to older runs, so a fresh v1-vs-v2 pair has to be re-run together.

## TypeScript Conventions

### Strict mode

`noUncheckedIndexedAccess` (indexing returns `T | undefined`) and `exactOptionalPropertyTypes` (missing ≠ `undefined`) are both on. The second one is why you see `...(x !== undefined && { x })` spreads instead of `x: x`.

### Type patterns

**Type-only imports:**
```typescript
import type { Doc, Passage } from "./types";
import { buildPassages } from "./passages";
```

**Type guards** for runtime narrowing:
```typescript
function isElement(node: AnyNode): node is CheerioElement {
    return node.type === "tag";
}
```

**String unions** for known values (`NodeKind`, `PageKind`, `DocSource`, `BlockType`).

**Config interfaces with a separate resolved type.** v2's convention: a partial `V2Config` in, a fully-resolved serializable `ResolvedV2Config` recorded on the run, so a run states the exact settings it executed with.

```typescript
interface RankConfig { weights?: RankWeights; bm25?: Bm25Config; }
export const DEFAULT_RANK_CONFIG: RankConfig = { /* ... */ };
```

### Null/undefined handling

- Return `null` for "not found"; an empty result for "nothing matched"
- Always check indexed access: `const item = arr[i]; if (item === undefined) return;`
- `??` for defaults, `?.` for nested access
- Explicit `=== undefined` rather than truthiness for numbers

### Export patterns

- Named exports for types and functions; default export only for singletons (`Logger`)
- Export the config type and its `DEFAULT_*` const next to the function that consumes them

## Code Style

- `const` by default; `let` only when reassigned
- `for...of` for loops with early returns; indexed `for` when you need to look ahead or behind
- Single-responsibility, pure functions where possible; factory functions (`create*`) for stateful objects
- Naming: `*Config`, `*Score`/`*Scores`, `*Result`, `*Weights`, `create*`, `calculate*`/`compute*`
- Comments explain **why**, and cite the measurement when a constant came from one. Several defaults in `v2/` carry the curve that chose them; keep that when you change them, and update the number rather than deleting the reasoning

### Determinism

Runs must be reproducible and diffable.

- **No `Date.now()`, no `Math.random()`** anywhere in `src/v2/` or `src/eval/`. Passage ids are FNV-1a over the URL for exactly this reason.
- All sorting is two-level: score descending, then a stable tie-break (`globalIndex`, `anchorIndex`, `url`) ascending.

```typescript
sorted.sort((a, b) => {
    const diff = b.combinedScore - a.combinedScore;
    if (diff !== 0) return diff;
    return a.globalIndex - b.globalIndex;
});
```

### Error handling

- Return empty results for edge cases rather than throwing; check preconditions early
- Wrap network operations in try/catch with a descriptive message; `AbortController` for timeouts
- An error the caller can act on beats a silent empty result — the MCP path returns a message explaining that SearXNG's engines rate-limit into empty 200s

## Testing

**Vitest.** Config `vitest.config.ts`, pattern `src/**/*.test.ts` and `src/**/__tests__/**/*.ts`, node environment, 10s timeout. 933 tests.

**15 of them fail without `eval/corpus/`**, which is gitignored and machine-local. They do not skip — `pagekind.test.ts` pins four cached pages by hash, and `parse.test.ts` / `passages.test.ts` sweep the corpus directory. On a checkout with no corpus the suite reads `15 failed | 912 passed` before anyone touches anything, so *check that number before blaming a change for it*.

```bash
pnpm test           # watch
pnpm test:run       # single run
pnpm test:coverage  # V8 coverage into coverage/
```

Tests are co-located in `__tests__/` next to the code. Describe/it/expect with explicit imports, arrange-act-assert separated by blank lines, fixtures loaded in `beforeAll`. Integration tests use `test-fixtures/*.html`; `src/v2/__tests__/fixtures/` holds v2's parser fixtures.

`src/mcp/__tests__/orchestrator-v2.test.ts` covers the two formatters as pure functions over a fixed `V2Result`. That became possible only once `runSearchV2` was split out of `searchV2Mcp`; while the module was one string-returning function, testing the rendering meant running a search. **Still missing: a test pinning the live fetch path and the eval adapter to the same parser output.**

## Build Configuration

**tsup** (`tsup.config.ts`): entries `src/cli.ts`, `src/index.ts`, `src/mcp/server.ts`, `src/eval/cli.ts`; ESM only; target node20; clean build.

**tsconfig**: ESNext modules, esnext target, strict plus the two options above, declarations and source maps on.

## Gotchas

### The parser divergence — the most expensive class of bug on this project

The eval adapter parsed with `v2/parse.ts` while the live HTML fetcher parsed with v1's `preprocessHtml` + `htmlToNodes`. **Every measured number described a parser no user ran**, and they diverged exactly where it was most expensive: `parse.ts` exists to avoid v1's `/comment/` boilerplate pattern, which deletes every answer on a Q&A page, and the live path reintroduced it. Fixed — the live adapter now calls `parseHtml`. **There is still no test pinning the two together.**

The general form, which has recurred five times here: *a gain, a corpus, or a parser measured against a weak proxy evaporates, inverts, or turns out to describe something else when you look at the real thing.* Check the instrument, especially when it reports success.

### Sweeping UI text near code

`removeUIElements` sweeps `a, span, div, p` anywhere in the container, and `emit()` filters every node again on its way into the document. Syntax highlighters wrap every token in its own span, so the sweep reaches individual identifiers.

The pattern list is now **two tiers**, and the split is the fix for a bug that ran much wider than it looked. Five of the ten original patterns had an optional prefix or an optional object, so each reduced to a bare content word: `/^(scroll\s*to\s*)?top$/i` to `/^top$/i`, and the same for `copy`, `share`, `edit`, `feedback`. Those are real headings on real pages — the Dockerfile reference's `COPY`, MDN's `top`, the Web Share API's `Share` — and because `emit()` had no code exemption and no element to inspect, a match deleted the heading outright. A deleted heading also drops out of `headingPath`, so everything below it is filed under the wrong section. The list was, in fact, exactly inverted: it dropped those five content words and kept all three residues a copy widget leaves behind (`Copied!`, `Copy to clipboard`, `copied`).

- `UI_TEXT_PATTERNS` (safe) — every pattern names its object; no optional group may reduce one to a single word. Applied everywhere, `emit()` included. `code` nodes are exempt outright.
- `UI_TEXT_WEAK_PATTERNS` (bare words) — fires only when `looksLikeControl()` agrees: an interactive role, an anchor that goes nowhere, a clipboard `data-*` hook, or a UI-ish class/`aria-label`. Never on a heading.

**Keep the invariant when adding a pattern: if it can match a word a page might legitimately use as a heading, it belongs in the weak tier.**

`CODE_CLEANUP_PATTERNS` had the same flaw with worse consequences — a leading `\s*` matches zero characters, so `/\s*(Try|Run|Copy)\s*$/` fired on any code block whose last token merely *ended with* the word, turning `err := io.Copy` into `err := io.`. Each pattern now requires the artifact to start its own line.

### Environment

- **SearXNG's upstream engines rate-limit under sustained load and then answer HTTP 200 with an empty result list.** Not an error, not on a timer. The recorder paces at 3000ms and aborts after 5 consecutive failures; the MCP path returns a message saying so rather than "no results".
- **An empty SERP is an error and is never cached.** A 200-with-no-results is a statement about when you asked, not about the query.
- **Stack Overflow 403s every User-Agent.** Only `api.stackexchange.com` works — 300 requests/day unauthenticated, and a question costs two.
- `grep` returns nothing on `src/v2/parse.ts` (1300+ lines). Cause unknown; `sed`, `wc` and node all work.
- Node runs `.mts` directly but cannot resolve this project's extensionless relative imports. To exercise project modules from a scratch script, write a temporary vitest file under `src/` and delete it after.

### Known v1 bugs, deliberately unfixed

Fixing these makes the baseline not-v1. Leave them alone, including during a cleanup pass:
- `deduplicateUrls` runs **before** the score sort, despite its comment
- Dead `?? url` null-coalesce in `processPage`
- Diagnostics truncation under-counts
