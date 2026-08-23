# Labeling standard

Labels are the definition of "good" for this project. Every tuning decision,
every v1-vs-v2 comparison, and eventually an automated weight search all
optimize against what is written here. A sloppy label does not produce a noisy
score — it produces a confident wrong one, in the flattering direction.

Read this before authoring a single nugget.

## What we are measuring

Given a query, did the pipeline put **the actual answer** in front of the model?

Not: did it find a particular page. Not: did it echo a page's exact phrasing.
The question is whether the returned excerpts contain the facts a person needed.
That is why labels are *nuggets* — atomic facts — rather than ranked lists of
URLs.

## Authoring a nugget

A nugget is one atomic fact that a good answer to this query must contain.

```json
{
  "id": "n2",
  "text": "The cleanup function runs before the effect re-runs with changed dependencies",
  "anchors": [
    ["cleanup", "teardown", "return"],
    ["before", "prior to", "re-run", "rerun", "again"],
    ["dependenc", "deps"]
  ],
  "window": 220,
  "weight": 1,
  "sources": ["https://react.dev/reference/react/useEffect"]
}
```

- **`text`** — the fact in plain language. Never used for matching; it exists so
  a human reading a failure can tell instantly what was missed.
- **`anchors`** — array of groups. **ALL groups must match; ANY term inside a
  group satisfies it.** This is the whole expressive power of the format:
  groups are the AND, terms within a group are the OR.
- **`window`** — required. See below.
- **`weight`** — default 1. Use 2 only for a fact that *is* the answer, where
  returning everything else and missing this one would make the result useless.
- **`sources`** — every cached URL you personally confirmed states this fact.
  Drives `conditionalNuggetRecall`, which isolates extraction quality from
  retrieval quality. Be accurate; a wrong entry here corrupts that metric.

### Choosing anchor terms

**Lowercase always.** Matching runs against normalized (lowercased) text, so an
uppercase term silently never matches. The validator rejects these, but do not
rely on it.

**Use stem-like prefixes.** Terms match as plain substrings, so `dependenc`
covers dependency/dependencies/dependencies'. `configur` covers
configure/configuration/configured. This is deliberately cheaper and more
predictable than a stemmer.

**Put synonyms in the same group.** A fact stated by two different pages will
use different words. `["cleanup", "teardown", "return"]` catches all the ways a
page might phrase the same concept. Under-supplying synonyms is the most common
labeling error: you write the nugget against react.dev's wording, and a
perfectly good MDN page that says the same thing scores as a miss.

**Do not anchor on the query's own words alone.** If the query is
"react useEffect cleanup" and your anchors are `[["react"], ["useeffect"],
["cleanup"]]`, you have written a nugget that matches any page *about* the
topic. That measures nothing. Anchor on the terms that carry the *answer* —
the mechanism, the flag, the number, the order of operations.

### Windows are required

`window` caps how far apart the matched anchors may be, measured as the
smallest span containing one term from every group.

Without it, a nugget matches when its terms appear *anywhere* in one excerpt —
and excerpts run 2,000–3,000 characters. Marketing copy mentioning "cache" in
its second sentence and "invalidate" in its ninth would score as a hit. That is
not a hypothetical; it is the default failure mode this field exists to stop.

- **150–250** — typical. A fact stated in a sentence or two.
- **250–400** — a fact that legitimately spans a short paragraph.
- **over 600** — the validator warns. Almost always a sign you have written two
  facts and should split them.

Tighter is safer. A window slightly too tight costs you a true positive on one
query; a window far too loose inflates every score in the set.

### How many, and which

**3–6 nuggets per query.** Fewer and the metric is coarse and jumpy; more and
you are labeling the page rather than the answer.

Good nuggets:

- the direct answer to what was asked
- the mechanism or reason behind it
- a concrete specific: a flag, a default value, a limit, an ordering, a name
- an important caveat or common failure mode

Not nuggets:

- **topic restatement** — "useEffect is a React hook". True, matches any page,
  measures nothing.
- **a page's editorial phrasing** — you are labeling the fact, not the prose.
- **anything opinion-shaped** — "X is better than Y" is not checkable.
- **anything that will be false in six months** — version numbers as facts,
  current pricing, "the latest release".

### The self-check, and it is not optional

For every nugget, ask: **would this match a generic filler paragraph that
happens to be on-topic?**

Concretely: imagine a content-farm page that discusses the subject at length
and answers nothing. Would your anchors and window match some paragraph of it?
If yes, the nugget is too loose — tighten the window, or replace a topic term
with an answer term.

This one check catches most bad labels. The harness cannot do it for you: a
false-positive nugget looks exactly like a success.

## Grading sources

Grade **every URL in the query's cached SERP**, not only the ones you liked.
`sourcePrecision` is computed over graded pages only, and coverage is reported
next to it — ungraded pages make the metric measure less, not nothing.

| Grade | Meaning |
| --- | --- |
| `canonical` | The authoritative source. Official docs for that library, the spec, the RFC, the regulator (IRS, FDA, CFPB), the project's own repo or issue tracker. Usually 1–2 per query, sometimes zero. |
| `good` | Accurate and genuinely useful, but not authoritative. A solid Stack Overflow answer, a competent blog post that is correct and specific. |
| `acceptable` | Partially useful. Touches the answer but thin, dated, or padded. |
| `bad` | SEO content farm, AI-generated filler, wrong, dangerously outdated, paywalled with no content, or pure affiliate bait. |

`match` may be an exact URL or a bare domain. An exact URL grade beats a domain
grade, so grade a domain broadly and then override specific pages.

**Grading `bad` honestly is load-bearing.** A stated goal of v2 is to stop
ranking content farms above official documentation. If farms are graded
`acceptable` out of politeness, the metric cannot see the problem and the tuner
will never learn to fix it. If a page is padded restated-obvious nonsense
wrapped in ads, it is `bad`.

## Workflow

1. `node dist/eval/cli.js dump <queryId>` — cleaned markdown for every cached
   page of that query, rendered with the **v2 parser**: the same view the
   oracle scores nuggets against, so a fact you can read in the dump is a fact
   a nugget can match. (`--parser v1` shows v1's older, strictly narrower view
   — it deletes whole pages on class-name patterns and cannot render tables at
   all. Tranche 1 was labeled through that view, which is why some pages look
   fuller now.)
2. Read enough to actually know the answer. You cannot write a good nugget for
   a question you have not answered.
3. Write 3–6 nuggets against the *facts*, drawing synonyms from how the
   different pages phrase them.
4. Grade every source.
5. Run the self-check on each nugget.
6. Write `eval/labels/<queryId>.json`.

```json
{
  "queryId": "api-docs-react-useeffect-cleanup",
  "labeledAt": "2026-08-21T00:00:00.000Z",
  "rubric": "One line on what a good answer looks like.",
  "nuggets": [ ... ],
  "sources": [
    { "match": "react.dev", "grade": "canonical" },
    { "match": "https://example.com/blog/post", "grade": "acceptable", "note": "correct but padded" }
  ]
}
```

## If a query turns out to be unanswerable

Some queries will have a SERP with no real answer in it. That is a finding, not
a blocker. Label it anyway with whatever nuggets a *correct* answer would need,
grade the sources honestly, and note it in `rubric`. A query where every source
is `bad` is exactly the case v2 needs to be measured on.
