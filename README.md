# Peeky Search

[![npm version](https://img.shields.io/npm/v/peeky-search.svg)](https://www.npmjs.com/package/peeky-search)
[![license](https://img.shields.io/npm/l/peeky-search.svg)](https://github.com/TripCreighton/peeky-search/blob/main/LICENSE)

**Find the answer you're actually looking for.**

Built-in web search gives you summaries. peeky-search gives you the Stack Overflow answer with the code fix, the GitHub discussion where someone debugged your exact issue, the documentation paragraph that actually explains the edge case.

No LLM summarization layer. Just IR-based extraction (BM25 + structural heuristics) that surfaces relevant passages directly from sources.

```bash
npx peeky-search --search --query "zod transform vs refine" --max 3
```

```
# Search Results for: "zod transform vs refine"

Found 3 of 3 pages with relevant content.

## Zod: .transform() vs .refine() - Stack Overflow
Source: https://stackoverflow.com/questions/73715295

Use `.refine()` when you want to add custom validation logic that returns
true/false. Use `.transform()` when you want to modify the parsed value
before it's returned.

### Key difference
`.refine()` validates and returns the same type. `.transform()` can change
the output type entirely:

const stringToNumber = z.string().transform(val => parseInt(val));
// Input: string, Output: number
```

## Who this is for

- **Developers debugging weird issues** - surfaces the GitHub discussion or Stack Overflow answer with your exact error
- **Agent and RAG builders** - verifiable excerpts with source attribution, not synthesized summaries
- **Anyone tired of "here's an overview"** - when you need the specific fix, not a tutorial

## Evidence vs Summaries

Built-in web search tools use an LLM to **summarize** pages. You get a polished overview, but edge cases get smoothed away.

peeky-search extracts **evidence** - the actual passages from sources, ranked by relevance. You see exactly what the docs say, what the maintainer wrote in that GitHub thread, what the accepted Stack Overflow answer recommends.

| What you get | peeky-search | Built-in WebSearch |
|--------------|--------------|---------------------|
| Output | Source excerpts you can verify | AI-interpreted summary |
| Edge cases | Surfaces gotchas from real discussions | Often summarized away |
| Attribution | Know exactly which page said what | "According to my search..." |
| LLM processing | None - pure IR extraction | Hidden summarization call |
| Speed | ~3-4 seconds | ~20-25 seconds |

### What peeky surfaces that summaries miss

Summaries give you the consensus. peeky gives you the specific details that actually solve your problem:

| Query | What peeky extracted |
|-------|---------------------|
| vitest mock timers | Edge case: `vi.stubGlobal` for mocking undefined properties |
| node.js backpressure | The `_readableState.pipes.once('drain')` hack for Transform streams |
| Zod .transform() | The `as const satisfies` pattern, `readonly` array gotchas |
| Next.js hydration error | Material UI gotcha: `Typography` defaults to `<p>` |
| CVE-2024-3094 xz backdoor | Links to Filippo Valsorda's analysis and xzbot reproduction repo |
| Bun vs better-sqlite3 | GitHub discussion where maintainer debunks the benchmark methodology |

These are the details buried in page 3 of search results, in comment threads, in "Related" sidebars - the stuff a human would find by clicking around, but that summaries gloss over.

### Example: Finding the Real Answer

For `Bun SQLite vs better-sqlite3 performance`:

**Built-in WebSearch** returned Bun's official claims (3-6x faster) and some general skepticism.

**peeky-search** found the actual GitHub discussion where a better-sqlite3 maintainer breaks down why the benchmark is misleading - showing that for real SQLite-heavy queries, better-sqlite3 can actually be faster.

That's the difference: summaries give you the marketing. peeky gives you the GitHub thread where someone actually investigated.

## Installation

Requires [Docker](https://docker.com) to run the SearXNG search backend.

```bash
npx peeky-search setup
```

This will:
1. Check prerequisites (Docker installed and running)
2. Start a local SearXNG instance in Docker
3. Output the MCP config to add to your client

Then add the config to your MCP client and restart it.

### Privacy

peeky-search runs entirely locally:
- **SearXNG** runs in Docker on your machine
- **Searches don't hit Anthropic, OpenAI, or any third party**
- No query logging, no telemetry, no data collection

Built-in web search tools route queries through the AI provider. You have no visibility into what happens to those queries.

### Commands

```bash
npx peeky-search setup              # One-time setup
npx peeky-search setup --port 9999  # Use custom port
npx peeky-search status             # Check if SearXNG is running
npx peeky-search start              # Start SearXNG
npx peeky-search stop               # Stop SearXNG
npx peeky-search uninstall          # Remove everything
```

### MCP Client Configuration

After running setup, add this to your MCP client config:

```json
{
  "mcpServers": {
    "peeky-search": {
      "command": "npx",
      "args": ["-y", "peeky-search", "mcp"],
      "env": {
        "SEARXNG_URL": "http://localhost:8888"
      }
    }
  }
}
```

**Where to add this:**
- **Claude Code**: Run `claude mcp add` and provide the config, or edit `~/.claude/settings.json`
- **Cursor**: Add to `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally
- **Other MCP clients**: Check your client's documentation for where MCP server configs go

## Usage

### MCP Tools

Once configured, your MCP client will have access to two tools:

#### `peeky_web_search`

Search the web and get extracted excerpts.

**Input:**
```json
{
  "query": "react useEffect cleanup function",
  "maxResults": 5,
  "diagnostics": false
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Search query. Supports `site:`, `"quotes"`, `-exclude` |
| `maxResults` | number | Pages to fetch (default 5, max 10) |
| `diagnostics` | boolean | Include filtering details (default false) |
| `sessionKey` | string | Key for cross-call deduplication. Same URL can be re-fetched for different queries (uses `url:tokens` composite keys). |

**Output:** Extracted excerpts from multiple pages with source URLs.

#### `peeky_fetch_page`

Fetch and read a single web page.

**Input:**
```json
{
  "url": "https://react.dev/learn/synchronizing-with-effects",
  "query": "cleanup function"
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | string | The URL to fetch and read |
| `query` | string | Optional. Focus extraction on this query. If omitted, returns full cleaned content. |

**Output:** Cleaned page content in markdown format with title and source URL. If `query` is provided, returns focused excerpts relevant to the query.

### CLI

**Search mode** (uses SearXNG):
```bash
npx peeky-search --search --query "prisma vs drizzle orm" --max 5
```

**URL mode** (extract from a specific page):
```bash
npx peeky-search --url "https://docs.example.com/auth" --query "JWT refresh tokens"
```

**Fetch mode** (get cleaned page content):
```bash
npx peeky-search --fetch --url "https://react.dev/learn"
npx peeky-search --fetch --url "https://react.dev/learn" --query "useState"
```

**File mode** (extract from local HTML):
```bash
npx peeky-search --query "authentication" --file docs.html --debug
```

**Additional options:**
- `--timing` or `-t`: Show performance timing breakdown
- `--diagnostics`: Show page-by-page extraction details (search mode)

## How It Works

### Search Pipeline

```
SearXNG → Dedupe URLs → Block JS domains → Title filter → Session dedupe
                                                                ↓
                                                          Scrape pages
                                                                ↓
                                                    Extract → Rank → Budget
```

1. **Search**: Query local SearXNG for URLs
2. **Pre-scrape filtering**: Skip blocked domains, filter by title/snippet relevance (40% query token threshold)
3. **Session deduplication**: Skip URLs already fetched for similar queries
4. **Scrape**: Parallel fetch with timeout handling
5. **Extract & rank**: Run extraction pipeline, rank by combined relevance
6. **Budget**: Fit results within character limits

### Extraction Pipeline

```
HTML → Strip boilerplate → Extract blocks → Segment sentences
                                                    ↓
                                              BM25 + Heuristics
                                                    ↓
                                            Rank → Select anchors
                                                    ↓
                                      Expand context → Deduplicate
                                                    ↓
                                          Assemble excerpts (budget)
```

1. **Preprocess**: Strip scripts, styles, nav, ads, and boilerplate
2. **Segment**: Extract blocks (headings, paragraphs, lists, code) into sentences
3. **Quality gate**: Reject low-quality pages (too few sentences, mostly fragments)
4. **Score**: BM25 for term relevance + 9 structural heuristics
5. **Select**: Pick top sentences with position/content diversity
6. **Expand**: Build context around anchors, respecting section boundaries
7. **Assemble**: Fit excerpts within character budget

## Performance

### Token efficiency

Compared to fetching raw HTML/markdown and sending it to context:

| Metric | Raw fetch | peeky-search |
|--------|-----------|--------------|
| Content per page | 30-80KB | 1-4KB |
| Tokens per page | ~15,000-40,000 | ~500-2,000 |
| 5-page search | ~200KB, ~50k tokens | ~12KB, ~3,000 tokens |

**~95% reduction vs raw HTML fetching.** Built-in web search also compresses content (via summarization), but uses a hidden LLM call to do it - peeky achieves similar token counts with pure IR, no intermediate model.

### Speed

- **Extraction**: ~20-50ms per page (pure computation, no LLM)
- **Search**: ~3-4s total for 5 pages (network-bound)
- **No hidden costs**: What you see is what you pay for

## Scoring System

**BM25** (weight: 0.6): Classic term frequency-inverse document frequency.

**Heuristics** (weight: 0.4):

| Metric | Weight | What it measures |
|--------|--------|------------------|
| headingPath | 0.17 | Query terms in section headings |
| coverage | 0.16 | IDF-weighted term coverage |
| proximity | 0.14 | How close query terms appear |
| headingProximity | 0.11 | Distance to matching heading |
| structure | 0.11 | Block type (headings, code valued higher) |
| density | 0.09 | Query term concentration |
| outlier | 0.09 | Anomaly detection for high-value sentences |
| metaSection | 0.08 | Penalizes intro/conclusion/meta content |
| position | 0.05 | Early content bonus |

### Extraction Modes

- **strict**: For single-page extraction. Requires strong multi-term matches.
- **search**: For multi-page search. Looser thresholds, accepts partial matches.

## Configuration

### Pipeline Defaults

```typescript
{
  bm25Weight: 0.6,
  heuristicWeight: 0.4,
  maxAnchors: 5,
  minScore: 0.25,
  diversityThreshold: 0.4,
  contextBefore: 5,
  contextAfter: 8,
  maxExcerpts: 3,
  charBudget: 6000
}
```

### MCP Defaults

```typescript
{
  searxngUrl: "http://localhost:8888",
  maxResults: 5,
  timeout: 5000,
  perPageCharBudget: 3000,
  totalCharBudget: 12000
}
```

## Tips

### Disable built-in web search

Models may default to their built-in web search tool if it's enabled. To ensure the model uses peeky-search:

- **Claude Code**: Disable web search in settings, or the model will prefer WebSearch over MCP tools
- **Other clients**: Check if built-in web/browser tools can be disabled

### Add a rule or memory

Some models won't recognize MCP tools unless explicitly instructed. Add a rule like:

> Use peeky_web_search for web searches. Use peeky_fetch_page to read URLs.

**Where to add this:**
- **Cursor**: Add to `.cursorrules` or project rules
- **Other clients**: Add to system prompt, memories, or custom instructions

## Acknowledgements

- [SearXNG](https://github.com/searxng/searxng) - Privacy-respecting metasearch engine that powers the search backend
- [Model Context Protocol](https://modelcontextprotocol.io/) - The protocol that makes this usable by AI assistants
- [Cheerio](https://cheerio.js.org/) - Fast HTML parsing
- [stemmer](https://github.com/words/stemmer) - Porter stemming for token normalization

## Disclaimer

This tool fetches and extracts content from publicly accessible web pages. Users are responsible for ensuring their use complies with applicable laws and the terms of service of any websites accessed. The authors are not liable for misuse.

## License

MIT
