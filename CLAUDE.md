# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

peeky-search is an IR-based (Information Retrieval) HTML content extraction tool with MCP server integration. Given an HTML document and a search query, it extracts the most relevant excerpts using BM25 scoring combined with structural heuristics. The pipeline preprocesses HTML, segments content into sentences, ranks by relevance, and assembles coherent excerpts.

**Core capabilities:**
- HTML preprocessing with boilerplate removal
- Sentence-level segmentation with heading path tracking
- Document quality gating (rejects low-quality/spam pages early)
- BM25 + 9-metric heuristic scoring for relevance ranking
- Two relevance modes: strict (single-page) and search (multi-page)
- Anchor-based excerpt extraction with context expansion
- Chunk deduplication and budget-aware assembly
- MCP server with SearXNG integration for web search
- Session-based URL deduplication across multiple searches

## Build & Run Commands

```bash
pnpm build          # Compile TypeScript via tsup to dist/
pnpm build:watch    # Watch mode compilation
pnpm build:tsc      # Type-check only (tsc)
pnpm start          # Run CLI (dist/cli.js)
pnpm start:watch    # Development mode with nodemon
pnpm mcp            # Run MCP server (dist/cli.js mcp)
pnpm cli            # Run CLI (alias for start)
pnpm test           # Run tests in watch mode (vitest)
pnpm test:run       # Run tests once
pnpm test:coverage  # Run tests with coverage report
```

**CLI usage:**
```bash
# Setup commands (via cli.ts)
npx peeky-search setup              # One-time setup (starts SearXNG in Docker)
npx peeky-search setup --port 9999  # Use custom port
npx peeky-search setup --check      # Check prerequisites only
npx peeky-search start              # Start SearXNG container
npx peeky-search stop               # Stop SearXNG container
npx peeky-search status             # Check if SearXNG is running
npx peeky-search uninstall          # Remove all config

# Extraction commands (delegated to index.ts)
node dist/cli.js --query "search terms" --file page.html [--debug]
node dist/cli.js --url "https://example.com" --query "search terms" [--debug]
node dist/cli.js --search --query "search terms" [--max 5] [--debug]
node dist/cli.js --fetch --url "https://example.com" [--query "optional focus"]

# Help
npx peeky-search --help
```

## Project Structure

```
src/
├── cli.ts                # Unified CLI entry point (setup/start/stop/status/mcp commands)
├── index.ts              # Extraction logic entry point (file/URL/search modes)
├── pipeline.ts           # Main extraction pipeline orchestrator
├── types.ts              # Shared type definitions
├── __tests__/            # Integration tests
│   └── pipeline.integration.test.ts
├── preprocessing/
│   ├── strip.ts          # HTML stripping, boilerplate removal, main content detection
│   ├── segment.ts        # Block extraction and sentence segmentation
│   ├── tokenize.ts       # Text normalization, stemming, stop word removal
│   └── __tests__/        # Unit tests for preprocessing
├── scoring/
│   ├── bm25.ts           # BM25 scoring implementation (k1=1.5, b=0.75)
│   ├── heuristics.ts     # 9 heuristic scores: position, headingProximity, density,
│   │                     # structure, proximity, headingPath, coverage, outlier, metaSection
│   ├── quality.ts        # Document quality assessment (rejects spam/low-quality early)
│   ├── ranker.ts         # Combined ranking with relevance detection (strict/search modes)
│   └── __tests__/        # Unit tests for scoring
├── extraction/
│   ├── anchors.ts        # Anchor sentence selection with position and content diversity
│   ├── expand.ts         # Context expansion around anchors with section boundaries
│   ├── dedupe.ts         # Chunk deduplication, merging, and subset removal
│   └── __tests__/        # Unit tests for extraction
├── output/
│   ├── excerpts.ts       # Final excerpt assembly and formatting
│   └── __tests__/        # Unit tests for output
├── mcp/
│   ├── types.ts          # MCP-specific type definitions
│   ├── server.ts         # MCP server entry point with peeky_web_search and peeky_fetch_page tools
│   ├── orchestrator.ts   # Search orchestration: SearXNG → scrape → extract → format
│   ├── query-parser.ts   # Search operator parsing (site:, "quotes", -exclude, filetype:)
│   ├── searxng.ts        # SearXNG API client
│   ├── scraper.ts        # Parallel web scraper with timeout handling
│   └── __tests__/        # Unit tests for MCP
├── setup/                # Docker/SearXNG setup and management
│   ├── index.ts          # Setup wizard orchestrator
│   ├── checks.ts         # Docker/SearXNG prerequisite checks
│   ├── docker.ts         # Docker container management (start/stop)
│   ├── templates.ts      # Configuration templates
│   └── uninstall.ts      # Cleanup functionality
└── utils/
    └── logger.ts         # Singleton logger (log, error, debug, timing methods)

test-fixtures/            # HTML fixtures for integration tests
├── basic-article.html    # Standard article with headings and code blocks
├── boilerplate-heavy.html # Page with nav, footer, ads to test stripping
├── code-documentation.html # Technical docs with code examples
├── low-quality.html      # Spam/low-quality content for quality gate testing
├── abbreviations.html    # Content with Dr., Inc., etc. for sentence splitting
└── nested-headings.html  # Deep heading hierarchy for path tracking
```

## Architecture

### Extraction Pipeline Stages

1. **Preprocess** (`preprocessing/strip.ts`): Strip scripts/styles, remove boilerplate (nav, footer, ads), find main content container
2. **Segment** (`preprocessing/segment.ts`): Extract blocks (h1-h6, p, li, pre), split into sentences, track heading paths
3. **Quality Gate** (`scoring/quality.ts`): Reject low-quality documents early (too few sentences, mostly fragments, short median length)
4. **Tokenize** (`preprocessing/tokenize.ts`): Normalize text, remove stop words, apply stemming
5. **Rank** (`scoring/ranker.ts`): Score sentences with BM25 + 9 heuristics, detect relevance
6. **Select Anchors** (`extraction/anchors.ts`): Pick top sentences with content/position diversity
7. **Expand** (`extraction/expand.ts`): Build context chunks around anchors, respect section boundaries
8. **Dedupe** (`extraction/dedupe.ts`): Merge overlapping chunks, remove subsets
9. **Assemble** (`output/excerpts.ts`): Select excerpts within character budget

### MCP Search Pipeline

1. **Search SearXNG**: Query local SearXNG instance for URLs
2. **Dedupe URLs**: Remove version duplicates (e.g., `/v1/` vs `/v2/` paths)
3. **Filter Blocked Domains**: Remove JS-rendered sites (medium.com, npmjs.com, etc.)
4. **Pre-scrape Title Filtering**: Compute relevance from title + snippet + URL tokens, reject if <40% query token overlap
5. **Session Deduplication**: Filter URLs already fetched for similar queries (uses `url:sortedTokens` composite keys, so same URL can be re-fetched for different queries)
6. **Scrape Pages**: Parallel fetch with timeout handling
7. **Extract Excerpts**: Run extraction pipeline on each page (search mode)
8. **Compute Relevance**: Weighted scoring (titleMatch 0.35, excerptScore 0.35, urlMatch 0.15, searxngScore 0.15)
9. **Format Results**: Assemble within total character budget (12000 default)

### Pre-scrape Title Filtering

Before scraping, each SearXNG result is scored by tokenizing the title, snippet, and URL path, then checking what fraction of query tokens appear. Results below 40% (`MIN_PRESCRAPE_RELEVANCE = 0.4`) are filtered to save bandwidth. This prevents scraping pages that are clearly off-topic based on their search result metadata.

### Session Deduplication

Session keys use composite `url:sortedTokens` format so:
- Same URL + same query tokens = skipped (already fetched this content for this query)
- Same URL + different query tokens = fetched again (extraction is query-dependent)

Stemming normalizes variations ("hooks" → "hook"), so near-identical queries dedupe correctly.

### Relevance Modes

- **strict mode** (single-page): Require multiple query terms co-occurrence OR central term + high BM25
- **search mode** (multi-page): Looser thresholds - single strong sentence OR co-occurrence OR central term

### Key Data Types

```typescript
// Core content unit after segmentation
interface Sentence {
    text: string;
    tokens: string[];
    blockIndex: number;
    sentenceIndex: number;
    globalIndex: number;
    headingPath: string[];
    position: number;      // 0-1 normalized position
    blockType: BlockType;
}

// After scoring
interface ScoredSentence extends Sentence {
    bm25Score: number;
    heuristicScore: number;
    combinedScore: number;
}

// Expanded context around an anchor
interface Chunk {
    sentences: Sentence[];
    anchorIndex: number;
    score: number;
    text: string;
    charCount: number;
    headingPath: string[];
}

// Ranking output with relevance detection
interface RankingResult {
    sentences: ScoredSentence[];
    hasRelevantResults: boolean;
    metrics: { maxBm25: number; maxCombined: number; cooccurrenceCount: number; };
}
```

### Heuristic Scoring (9 metrics)

| Metric | Weight | Description |
|--------|--------|-------------|
| headingPath | 0.17 | IDF-weighted heading match |
| coverage | 0.16 | IDF-weighted term coverage |
| proximity | 0.14 | Minimal spanning window for query terms |
| headingProximity | 0.11 | Distance to nearest query-matching heading |
| structure | 0.11 | Block type bonus (headings, code) |
| density | 0.09 | Query term density in sentence |
| outlier | 0.09 | Anomaly detection via median/MAD |
| metaSection | 0.08 | Penalizes intro/conclusion/meta content |
| position | 0.05 | Early content bonus (piecewise 0.3-1.0) |

## MCP Server

**Entry point:** `pnpm mcp` or `npx peeky-search mcp`

**Tools:**

`peeky_web_search` - Search the web and extract relevant excerpts
- `query` (string, required): Search query with technical terms. Supports operators: `site:`, `"quotes"`, `-exclude`
- `maxResults` (number, optional): Max pages to scrape (default 5, max 10)
- `diagnostics` (boolean, optional): Include detailed diagnostics about why pages were filtered or failed (default: false)
- `sessionKey` (string, optional): Key for cross-call URL deduplication. URLs fetched with the same key won't be re-fetched.

`peeky_fetch_page` - Fetch and read a single web page
- `url` (string, required): The URL to fetch and read
- `query` (string, optional): Focus extraction on this query. If omitted, returns full cleaned content.

**Environment variables:**
- `SEARXNG_URL`: SearXNG instance URL (default: `http://localhost:8888`)

**Character budgets:**
- Per-page: 3000 chars
- Total: 12000 chars

**Blocked domains** (JS-rendered or low-quality):
- medium.com, npmjs.com, researchgate.net, grokipedia.org
- GitHub repo main pages (but issues/discussions work fine)

## TypeScript Conventions

### Strict Mode

This project uses strict TypeScript with additional safety options:
- `noUncheckedIndexedAccess`: Array/object index access returns `T | undefined`
- `exactOptionalPropertyTypes`: Distinguishes between `undefined` and missing properties

### Type Patterns

**Type-only imports** - Separate type imports from value imports:
```typescript
import type { Sentence, ScoredSentence } from "../types";
import { createBM25Scorer } from "./bm25";
```

**Namespace type imports** - For external library types:
```typescript
import type * as cheerio from "cheerio";
import type { AnyNode, Element as CheerioElement } from "domhandler";
```

**Type guards** - Create predicates for runtime narrowing:
```typescript
function isElement(node: AnyNode): node is CheerioElement {
    return node.type === "tag";
}

function isBlockTag(tagName: string): tagName is BlockType {
    return /^h[1-6]$/.test(tagName) || tagName === "p" || tagName === "li" || tagName === "pre";
}
```

**String unions** - Constrain known values:
```typescript
type BlockType = "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "li" | "pre";
```

**Index signature types** - For dynamic key access:
```typescript
interface TermFrequencyMap {
    [term: string]: number;
}
```

**Config interfaces with optional properties** - Define defaults separately:
```typescript
interface RankerConfig {
    bm25Weight?: number;
    heuristicWeight?: number;
    relevanceMode?: "strict" | "search";
}

const DEFAULT_CONFIG: Required<Omit<RankerConfig, "bm25Config">> = {
    bm25Weight: 0.6,
    heuristicWeight: 0.4,
    relevanceMode: "strict",
};
```

### Null/Undefined Handling

- Return `null` for "not found" or "no result"
- Always check array index access: `const item = arr[i]; if (item === undefined) return;`
- Use nullish coalescing for defaults: `tf[token] ?? 0`
- Use optional chaining for nested access: `result.debug?.sentenceCount`

### Export Patterns

- **Named exports** for types and functions: `export type Block`, `export function extractBlocks`
- **Default exports** only for singleton classes: `export default Logger`
- **Re-export configs** alongside functions: `export { type AnchorConfig } from "./anchors"`

## Code Style

### General

- Use `const` by default, `let` only when reassignment is needed
- Prefer `for...of` over `.forEach()` for loops with early returns or complex logic
- Use `for` loops with index when you need the index or need to look ahead/behind
- Collapse whitespace: `.replace(/\s+/g, " ").trim()`

### Function Design

- **Single responsibility**: Each function does one thing
- **Pure functions** where possible: Same inputs always produce same outputs
- **Factory pattern** for stateful objects: `createBM25Scorer()` returns a scorer object
- **Config objects** for functions with many optional parameters

### Naming Conventions

- Config interfaces: `*Config` suffix (e.g., `RankerConfig`)
- Score interfaces: `*Score` or `*Scores` suffix (e.g., `HeuristicScores`)
- Result interfaces: `*Result` suffix (e.g., `RankingResult`)
- Weight interfaces: `*Weights` suffix (e.g., `HeuristicWeights`)
- Factory functions: `create*` prefix (e.g., `createBM25Scorer`)
- Computation functions: `calculate*` or `compute*` prefix

### Determinism

All sorting must be deterministic with two-level ordering:
1. Primary: Score/metric descending
2. Tie-break: globalIndex or anchorIndex ascending

Example:
```typescript
rankedSentences.sort((a, b) => {
    const scoreDiff = b.combinedScore - a.combinedScore;
    if (scoreDiff !== 0) return scoreDiff;
    return a.globalIndex - b.globalIndex;
});
```

### Algorithm Implementation

- **Document stats computation**: Pre-compute corpus statistics once, reuse for scoring
- **Score normalization**: Use min-max normalization to combine scores from different scales
- **Greedy selection**: For anchor selection and excerpt assembly, use greedy algorithms with diversity constraints
- **Alternating expansion**: Chunk expansion adds context before/after symmetrically
- **Timeout handling**: Use AbortController pattern for fetch operations

### Error Handling

- Return empty results for edge cases (empty input, no matches) rather than throwing
- Check preconditions early and return early
- Use explicit undefined checks rather than truthy/falsy tests for numbers
- Wrap network operations in try/catch with descriptive error messages

## Build Configuration

**tsup.config.ts:**
- Entries: `src/cli.ts`, `src/index.ts`, `src/mcp/server.ts`
- Format: ESM only
- Target: node20
- Clean build enabled

**tsconfig.json:**
- Module: ESNext
- Target: esnext
- Strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
- Declaration files generated (.d.ts)
- Source maps enabled

## Testing

### Framework

Uses **Vitest** for unit and integration testing:
- Config: `vitest.config.ts`
- Test pattern: `src/**/*.test.ts` and `src/**/__tests__/**/*.ts`
- Environment: Node
- Timeout: 10 seconds per test

### Test Organization

Tests are co-located with source code in `__tests__/` directories:
```
src/module/
├── feature.ts
└── __tests__/
    └── feature.test.ts
```

Integration tests use HTML fixtures from `test-fixtures/` directory.

### Running Tests

```bash
pnpm test           # Watch mode - reruns on file changes
pnpm test:run       # Single run - CI/pre-commit
pnpm test:coverage  # With V8 coverage report
```

### Test Conventions

**Describe/it/expect pattern** with explicit imports:
```typescript
import { describe, it, expect } from "vitest";
import { myFunction } from "../myModule";

describe("myFunction", () => {
    it("handles basic case", () => {
        const result = myFunction("input");

        expect(result).toBe("expected");
    });
});
```

**Arrange-Act-Assert** structure with blank lines:
```typescript
it("extracts relevant excerpts", () => {
    // Arrange
    const html = "<p>content</p>";
    const query = "content";

    // Act
    const result = extractExcerpts(html, query);

    // Assert
    expect(result.excerpts.length).toBeGreaterThan(0);
});
```

**Integration tests** load fixtures in `beforeAll`:
```typescript
let fixtureHtml: string;

beforeAll(() => {
    fixtureHtml = readFileSync(join(fixturesDir, "fixture.html"), "utf-8");
});
```

### Test Categories

| Category | Location | Purpose |
|----------|----------|---------|
| Unit | `src/*/\__tests__/*.test.ts` | Test individual functions in isolation |
| Integration | `src/\__tests__/pipeline.integration.test.ts` | Test full extraction pipeline with fixtures |

### Coverage

V8 coverage with reporters: text (console) and html (`coverage/` directory)
- Includes: `src/**/*.ts`
- Excludes: test files
