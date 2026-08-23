# peeky-search

[![npm version](https://img.shields.io/npm/v/peeky-search.svg)](https://www.npmjs.com/package/peeky-search)
[![license](https://img.shields.io/npm/l/peeky-search.svg)](https://github.com/TripCreighton/peeky-search/blob/main/LICENSE)

A local web search server for coding agents. It runs your query through a
SearXNG instance on your machine, fetches the result pages, and returns the
passages that answer the question — **the sources' own words, quoted, with the
URL they came from.**

There is no summarization step. Nothing is paraphrased, nothing is passed
through a second model, and no query leaves your machine except to the search
engines SearXNG queries on your behalf.

Install it as an MCP server and your agent gets two tools: `peeky_web_search`
and `peeky_fetch_page`.

## Example

```console
$ npx peeky-search --search --query "RuntimeError Event loop is closed asyncio python" --max 3 --pipeline v2
```

```
3 pages for "RuntimeError Event loop is closed asyncio python"

---

## ["Asyncio Event Loop is Closed" when getting loop](https://stackoverflow.com/questions/45600579/asyncio-event-loop-is-closed-when-getting-loop)

When trying to run the asyncio hello world code example given in the docs:
import asyncio

async def hello_world():
    print("Hello World!")

loop = asyncio.get_event_loop()
loop.run_until_complete(hello_world())
loop.close()
I get the error:
RuntimeError: Event loop is closed
I am using python 3.5.3.

You have already called loop.close() before you ran that sample piece of code,
on the global event loop:
>>> import asyncio
>>> asyncio.get_event_loop().close()
>>> asyncio.get_event_loop().is_closed()
True
...
```

That page is Stack Overflow, which answers every scraper with HTTP 403.
peeky reads it through the Stack Exchange API instead, so the question and its
accepted answer arrive with vote counts attached.

## Why

Built-in web search tools summarize. A summary is a second model's reading of a
page, and the details it drops are disproportionately the ones you needed: the
version the fix applies to, the flag that changes the behaviour, the caveat in
the third comment.

peeky returns evidence instead. You read what the maintainer actually wrote, and
you can follow the URL to check it.

|  | peeky-search | Built-in web search |
|---|---|---|
| Output | Verbatim source excerpts | Model-written summary |
| Attribution | Per-passage source URL and heading path | "According to my search…" |
| Extra model calls | None | One hidden summarization pass |
| Where queries go | Your machine → SearXNG → engines | Through your AI provider |
| Blocked sources | Reads Stack Exchange, GitHub, npm via their APIs | Varies |

Concretely: the pages behind a five-result search hold roughly 900 KB of HTML
between them (mean 189 KB per page, sampled over 639 cached pages). peeky
returns 7–11 KB of text, in about five seconds on a warm SearXNG.

## Install

Requires [Docker](https://docker.com) (for SearXNG) and Node 20+.

```bash
npx peeky-search setup
```

That checks prerequisites, starts a local SearXNG container, and prints the MCP
config to add to your client.

```json
{
  "mcpServers": {
    "peeky-search": {
      "command": "npx",
      "args": ["-y", "peeky-search", "mcp"],
      "env": { "SEARXNG_URL": "http://localhost:8888" }
    }
  }
}
```

- **Claude Code** — `claude mcp add`, or edit `~/.claude/settings.json`
- **Cursor** — `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json`
- **Others** — see your client's MCP documentation

Managing the container:

```bash
npx peeky-search status      # is SearXNG running?
npx peeky-search start
npx peeky-search stop
npx peeky-search setup --port 9999
npx peeky-search uninstall
```

> **Known issue:** the `SEARXNG_URL` environment variable is emitted by `setup`
> but is not yet read by the server, which always uses `http://localhost:8888`.
> A non-default `--port` therefore does not work end to end. Tracked below under
> [Limitations](#limitations).

## Tools

### `peeky_web_search`

Search, fetch the results, and return the passages that answer the query.

| Parameter | Type | Description |
|---|---|---|
| `query` | string, required | Supports `site:`, `"exact phrase"`, `-exclude`, and `OR`/`AND` between `site:` operators |
| `maxResults` | number | Pages to return. Default 5, clamped to 1–10 |
| `sessionKey` | string | Deduplicates across calls. Keys are `url:queryTokens`, so the same page is re-fetched for a different question but skipped for the same one |

Returns one section per page: the title as a link, then each excerpt preceded by
the heading path it sits under. Code blocks keep their fences.

### `peeky_fetch_page`

Read one page.

| Parameter | Type | Description |
|---|---|---|
| `url` | string, required | The page to read |
| `query` | string | Return only the passages answering it. Omit for the whole readable document in order, up to 12,000 characters |

This is the tool to reach for when a search excerpt looks promising but thin.
It resolves Stack Exchange, GitHub, and npm URLs through their APIs, and reads
documentation sites that publish markdown from source, so it opens pages that
refuse ordinary fetching.

## How it works

```
query ──► parse: operators, error strings, code symbols, versions
   │
SearXNG ──► candidate URLs (16 deep)
              │
              ▼
   fetch: Stack Exchange API · GitHub API · npm registry
          · markdown sibling · generic HTML
              │
              ▼
   parse to a node tree ──► detect page kind ──► build passages
              │
              ▼
   score every passage from every page in ONE pool
     BM25 · exact anchors · heading match · structure · endorsement
              │
              ▼
   score each source's authority, and multiply it in
              │
              ▼
   assemble under budget
     score-per-character · document diversity · novelty · coverage
```

Four decisions do most of the work:

**One candidate pool.** Passages from every fetched document are scored
together, so IDF is computed across the whole candidate set for the query. Rank
each page separately — as v1 did — and IDF is computed over the sentences of a
single page, where almost every term is rare and BM25 degenerates into a term
count. Pooling is what lets a strong passage on the fourth result beat a
mediocre one on the first.

**Passages, not sentences.** A passage is a run of nodes under one heading,
split only at node boundaries, so a code block is never cut in half. Scoring
them directly removes the anchor → expand → deduplicate round trip: there is
nothing to reassemble because nothing was taken apart.

**Source authority, scored separately.** Text-match alone rewards pages
optimized to look like an answer, which is exactly what a content farm is built
to do. Authority is scored independently — declared homepage, standards body,
primary source, peer citation on one side; link-only body, no substantive
paragraph, thin content, self-promotion on the other — and multiplied into the
ranking. Every negative signal describes the document as parsed rather than
naming a host, because a hostname blocklist fits the set you tuned it on and
transfers to nothing.

**Structured sources before scraping.** Where an API exists, it is used. That is
how Stack Overflow is readable at all, and it is where the accepted-answer flag
and vote counts come from.

## Results

peeky ships an evaluation harness, and the pipeline above (v2) was built against
it. The numbers below are from **134 held-out queries** — labelled after v2 was
finished, scored once — against v1, the sentence-level BM25 pipeline it replaced.

| Metric | v1 | v2 | |
|---|---|---|---|
| Nugget recall | 0.338 | **0.458** | Did the output contain the facts the query needed? |
| Conditional recall | 0.463 | **0.526** | Same, over pages that were returned — extraction, not retrieval |
| Source precision | 0.737 | **0.774** | Returned pages graded `canonical` or `good` |
| Bad rate | 0.041 | 0.042 | Returned pages graded `bad` |
| Canonical MRR | 0.237 | **0.325** | How high the authoritative source lands |
| Efficiency | **0.327** | 0.297 | Matched facts per 1,000 characters |
| Mean characters | **7,102** | 10,543 | |

68 queries improved, 33 regressed, 33 were unchanged.

Four things worth stating plainly:

- The same measurement on the **tuning** set read +0.201. That number was
  inflated by overfitting; +0.120 is the one to quote.
- **Bad rate is a tie.** The problem that motivated the project — content farms
  outranking official documentation — is not solved. v2 surfaces the
  authoritative source higher, but it does not filter the farms out.
- v2 spends about 50% more characters to get there.
- An oracle selecting from the same candidate pool, allowed to see the answer
  key, reaches 0.963 recall in a median of 3,589 characters. Every fact is
  already in the pool. What v2 misses, it misses on ordering.

## CLI

The CLI exists for debugging and development; the MCP server is the product.

```bash
# what an agent gets
npx peeky-search --search --query "prisma nested writes" --max 5 --pipeline v2

# read one page
npx peeky-search --fetch --url "https://react.dev/learn"
npx peeky-search --fetch --url "https://react.dev/learn" --query "useState"

# extract from a local file
npx peeky-search --query "authentication" --file page.html --debug
```

`--search` defaults to the v1 pipeline for backward compatibility; pass
`--pipeline v2` to see what the MCP server actually returns. `--fetch`, `--url`
and `--file` still run v1.

## Evaluation harness

`peeky-eval` scores a pipeline against a frozen corpus of pages using
hand-written labels. It is how every claim above was produced, and it is
included in the package.

**How it works.** For each query, a person reads the full text of every cached
result and writes down the atomic facts a good answer must contain — *nuggets* —
plus a grade for each source. Scoring then matches those facts against a
pipeline's output by substring, with no model in the loop:

```json
{
  "id": "n2",
  "text": "The cleanup function runs before the effect re-runs with changed dependencies",
  "anchors": [["cleanup", "teardown"], ["before", "prior to", "re-run"], ["dependenc", "deps"]],
  "window": 220
}
```

All anchor groups must match; any term within a group satisfies it. `window`
caps the characters between the first and last match, so a fact cannot be
"found" because its terms are scattered across unrelated text.

**Why no LLM judge.** The effects that need detecting are around 2%.
Judge-to-judge variation is larger than that, so an LLM judge would still emit a
number and it would still be believed. Putting the judgement in at authoring
time and keeping scoring deterministic means two runs a week apart are
comparable, and a scoring pass takes seconds.

**Metrics.** `nuggetRecall` (the headline), `conditionalNuggetRecall`
(extraction isolated from retrieval), `sourcePrecision`, `badRate`,
`canonicalMrr`, and `efficiency`. All are macro-averaged over queries.

**Commands.**

```bash
pnpm eval corpus --check                 # what is cached, and is it enough to run
pnpm eval record --tranche 1 --adapters  # the only command that uses the network
pnpm eval run --pipeline v2 --tranche 1  # replay, score, print the scoreboard
pnpm eval diff run-a run-b               # what changed, regressions first
pnpm eval dump <queryId>                 # every cached page as clean markdown
```

`--pipeline oracle` runs a selector that can see the answer key, which measures
the ceiling the candidate pool allows — it separates "never fetched" from
"fetched and not chosen".

**What you have to supply.** The 200-query set is committed
([`eval/queries/queryset.json`](eval/queries/queryset.json)) and so is the
labelling rubric ([`eval/LABELING.md`](eval/LABELING.md)). The corpus and the
labels are not: the corpus is gigabytes of other people's pages, and the labels
are per-site quality judgements that this project has no business publishing.
To run the harness you record your own corpus and write your own labels. Your
absolute numbers will differ from the ones above; differences measured within
your own corpus are what it is for.

## Development

```bash
pnpm install
pnpm build          # tsup -> dist/
pnpm test           # vitest, watch
pnpm test:run       # single run (900 tests)
pnpm build:tsc      # type-check only
```

Note that `build:tsc` overwrites the bundled `dist/eval/cli.js`; run `pnpm
build` after it.

```
src/
├── v2/           the pipeline that runs — parse, passages, rank, authority, assemble, fetch/
├── mcp/          server + orchestration (orchestrator-v2.ts is what ships)
├── eval/         the harness — corpus cache, labels, scorer, adapters
├── preprocessing/, scoring/, extraction/, output/    v1, kept as the eval baseline
└── setup/        Docker + SearXNG management
```

v1 is retained deliberately: the harness replays it to reproduce the baseline,
and a baseline you cannot re-run is not a baseline. It is no longer served to
any caller.

See [CONTRIBUTING.md](CONTRIBUTING.md), and [CLAUDE.md](CLAUDE.md) for a fuller
architectural tour.

## Limitations

- `SEARXNG_URL` is not read by the server yet; the port is effectively fixed at
  8888.
- Content farms are still returned. Authority reorders results but does not
  reject them, and the measured bad rate is unchanged from v1.
- Unauthenticated API quotas apply to the structured sources: Stack Exchange
  allows 300 requests/day per IP, GitHub 60/hour. Past those, those results
  degrade to whatever HTML is available — which for Stack Overflow is nothing.
- SearXNG's upstream engines rate-limit under sustained use and then return an
  empty result list rather than an error. peeky reports this rather than
  claiming no results exist.
- `src/mcp/orchestrator-v2.ts` has no direct test coverage.
- HTML comments and MDX artifacts can survive into excerpts from some sources.

## Acknowledgements

[SearXNG](https://github.com/searxng/searxng) for the search backend, the
[Model Context Protocol](https://modelcontextprotocol.io/) for the tool
interface, [Cheerio](https://cheerio.js.org/) for HTML parsing, and
[stemmer](https://github.com/words/stemmer) for token normalization.

## Disclaimer

This tool fetches and extracts content from publicly accessible web pages. Users
are responsible for complying with applicable law and the terms of service of
the sites they access.

## License

MIT
