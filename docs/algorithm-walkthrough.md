# Algorithm Walkthrough

This document explains how peeky-search extracts relevant excerpts from HTML documents, step by step, using a concrete example.

## The Example

Let's say we have this HTML document about JavaScript promises:

```html
<article>
  <h1>Understanding Async JavaScript</h1>
  <p>JavaScript is a single-threaded language. This article covers async patterns.</p>

  <h2>Callbacks</h2>
  <p>Callbacks were the original way to handle async code. They can lead to callback hell.</p>

  <h2>Promises</h2>
  <p>Promises provide a cleaner way to handle asynchronous operations in JavaScript.</p>
  <p>A Promise represents a value that may be available now, later, or never.</p>
  <p>You can chain promises using .then() and handle errors with .catch().</p>

  <h2>Async/Await</h2>
  <p>Async/await is syntactic sugar over promises. It makes async code look synchronous.</p>

  <h2>Conclusion</h2>
  <p>In this article, we covered the evolution of async JavaScript patterns.</p>
</article>
```

And we search with the query: **"promises async javascript"**

---

## Stage 1: Tokenization

First, we tokenize the query to prepare it for matching.

### Input
```
"promises async javascript"
```

### Process

1. **Normalize**: lowercase, remove punctuation
   ```
   "promises async javascript"
   ```

2. **Split into words**:
   ```
   ["promises", "async", "javascript"]
   ```

3. **Remove stop words**: None in this query (common words like "the", "is", "a" would be removed)

4. **Apply stemming** (Porter stemmer reduces words to root form):
   ```
   "promises" → "promis"
   "async"    → "async"
   "javascript" → "javascript"
   ```

### Output: Query Tokens
```
["promis", "async", "javascript"]
```

---

## Stage 2: HTML Preprocessing & Segmentation

The HTML is parsed and split into sentences with metadata.

### Blocks Extracted

| Index | Type | Text | Heading Path |
|-------|------|------|--------------|
| 0 | h1 | Understanding Async JavaScript | [] |
| 1 | p | JavaScript is a single-threaded language. This article covers async patterns. | [Understanding Async JavaScript] |
| 2 | h2 | Callbacks | [Understanding Async JavaScript] |
| 3 | p | Callbacks were the original way to handle async code. They can lead to callback hell. | [Understanding Async JavaScript, Callbacks] |
| 4 | h2 | Promises | [Understanding Async JavaScript] |
| 5 | p | Promises provide a cleaner way to handle asynchronous operations in JavaScript. | [Understanding Async JavaScript, Promises] |
| 6 | p | A Promise represents a value that may be available now, later, or never. | [Understanding Async JavaScript, Promises] |
| 7 | p | You can chain promises using .then() and handle errors with .catch(). | [Understanding Async JavaScript, Promises] |
| 8 | h2 | Async/Await | [Understanding Async JavaScript] |
| 9 | p | Async/await is syntactic sugar over promises. It makes async code look synchronous. | [Understanding Async JavaScript, Async/Await] |
| 10 | h2 | Conclusion | [Understanding Async JavaScript] |
| 11 | p | In this article, we covered the evolution of async JavaScript patterns. | [Understanding Async JavaScript, Conclusion] |

### Sentences Created

Paragraph blocks get split into sentences. Each sentence gets:
- **tokens**: Stemmed, stop-word-filtered tokens
- **globalIndex**: Position in document (0-indexed)
- **position**: Normalized position (0.0 = start, 1.0 = end)
- **headingPath**: Ancestor headings for context

Example sentence (globalIndex 6):
```
text: "Promises provide a cleaner way to handle asynchronous operations in JavaScript."
tokens: ["promis", "provid", "cleaner", "handl", "asynchron", "oper", "javascript"]
position: 0.45
headingPath: ["Understanding Async JavaScript", "Promises"]
blockType: "p"
```

---

## Stage 3: BM25 Scoring

BM25 is an information retrieval algorithm that scores how relevant each sentence is to the query.

### The Math

For each query term, BM25 calculates:

```
score = IDF × (tf × (k1 + 1)) / (tf + k1 × (1 - b + b × (docLength / avgDocLength)))
```

Where:
- **IDF** = Inverse Document Frequency (rare terms score higher)
- **tf** = Term Frequency (how many times the term appears)
- **k1** = 1.5 (controls term frequency saturation)
- **b** = 0.75 (controls length normalization)

### IDF Calculation

IDF measures how "special" a term is. Terms appearing in fewer sentences get higher IDF.

Formula:
```
IDF = log((N - df + 0.5) / (df + 0.5) + 1)
```

Where:
- **N** = total sentences (12 in our example)
- **df** = document frequency (how many sentences contain this term)

| Term | Appears In | df | IDF |
|------|-----------|-----|-----|
| `promis` | sentences 4, 6, 7, 9 | 4 | log((12-4+0.5)/(4+0.5)+1) = **1.07** |
| `async` | sentences 0, 1, 8, 9 | 4 | **1.07** |
| `javascript` | sentences 0, 1, 6, 11 | 4 | **1.07** |

All three terms have similar IDF because they appear in similar numbers of sentences.

### Scoring a Sentence

Let's score sentence 6: *"Promises provide a cleaner way to handle asynchronous operations in JavaScript."*

Tokens: `["promis", "provid", "cleaner", "handl", "asynchron", "oper", "javascript"]`

| Query Term | tf | IDF | Term Score |
|------------|-----|-----|------------|
| `promis` | 1 | 1.07 | 1.07 × (1×2.5)/(1+1.5×(1-0.75+0.75×7/5.8)) = **1.41** |
| `async` | 0 | 1.07 | **0** |
| `javascript` | 1 | 1.07 | **1.41** |

**Raw BM25 Score: 2.82**

After scoring all sentences, the raw scores are normalized to [0, 1] using min-max normalization.

---

## Stage 4: Heuristic Scoring

Nine heuristics capture relevance signals beyond term matching.

### The Nine Heuristics

For sentence 6 (*"Promises provide a cleaner way..."*):

#### 1. Position Score (weight: 0.05)
Early content gets a boost.

```
position = 0.45 (middle of document)
score = 0.7 - ((0.45 - 0.3) / 0.4) × 0.2 = 0.625
```

**Score: 0.625**

---

#### 2. Heading Proximity (weight: 0.11)
Sentences near query-matching headings score higher.

The nearest heading is "Promises" (globalIndex 4), which is 2 sentences away.

```
headingOverlap = 1.0 (heading contains "promises")
distanceScore = 1 / (1 + 2/5) = 0.71
score = 1.0 × 0.6 + 0.71 × 0.4 = 0.88
```

**Score: 0.88**

---

#### 3. Density Score (weight: 0.09)
Query term density in the sentence.

```
queryTermCount = 2 (promis, javascript)
totalTokens = 7
rawDensity = 2/7 = 0.286

uniqueQueryTerms = 2
coverage = 2/3 = 0.667

score = 0.286 × 0.4 + 0.667 × 0.6 = 0.51
```

**Score: 0.51**

---

#### 4. Structure Score (weight: 0.11)
Block type and context bonuses.

```
baseScore = 0.8 (paragraph)
headingPathBonus = 0.1 (heading path contains query term "promises")
score = min(1.0, 0.8 + 0.1) = 0.9
```

**Score: 0.90**

---

#### 5. Proximity Score (weight: 0.14)
How tightly clustered are query terms in the sentence?

Uses a sliding window algorithm to find the minimal span containing all matched query terms.

```
Matched terms: "promis" at position 0, "javascript" at position 6
Span = 7 tokens (full sentence)

coverageRatio = 2/3 = 0.667
spanTightness = 1 - (7/7) = 0.0
densityInSpan = 2/7 = 0.286

score = 0.667 × 0.4 + 0.0 × 0.35 + 0.286 × 0.25 = 0.34
```

**Score: 0.34**

---

#### 6. Heading Path Score (weight: 0.17)
IDF-weighted overlap between query and ancestor headings.

Heading path: ["Understanding Async JavaScript", "Promises"]
Tokenized: `["understand", "async", "javascript", "promis"]`

```
Matched query terms: "async", "javascript", "promis" (all 3!)
matchedIdfSum = 1.07 + 1.07 + 1.07 = 3.21
totalIdfSum = 3.21

score = 0.3 + (3.21/3.21) × 0.7 = 1.0
```

**Score: 1.00** (maximum - all query terms in heading path!)

---

#### 7. Coverage Score (weight: 0.16)
IDF-weighted term coverage in the sentence.

```
Matched: "promis" (IDF 1.07), "javascript" (IDF 1.07)
Missing: "async" (IDF 1.07)

idfWeightedCoverage = 2.14/3.21 = 0.667
simpleCoverage = 2/3 = 0.667

score = 0.667 × 0.7 + 0.667 × 0.3 = 0.667
```

**Score: 0.67**

---

#### 8. Outlier Score (weight: 0.09)
Flags sentences with unusually high query term density.

Uses median/MAD (Median Absolute Deviation) statistics:
- Compute density for all sentences
- Find median and MAD
- Sentences significantly above median get boosted

```
This sentence's density = 0.286
Median density ≈ 0.15
MAD ≈ 0.08

zScore = (0.286 - 0.15) / 0.08 = 1.7

score = 0.3 + 0.7 × sigmoid(1.7 - 2) = 0.42
```

**Score: 0.42**

---

#### 9. Meta Section Score (weight: 0.08)
Penalizes intro/conclusion/meta content.

Checks if heading path contains meta patterns like "Introduction", "Conclusion", "About the Author", etc.

```
Heading path: ["Understanding Async JavaScript", "Promises"]
No meta patterns found.

score = 1.0
```

**Score: 1.00**

---

### Combined Heuristic Score

```
combined = 0.05 × 0.625    (position)
         + 0.11 × 0.88     (headingProximity)
         + 0.09 × 0.51     (density)
         + 0.11 × 0.90     (structure)
         + 0.14 × 0.34     (proximity)
         + 0.17 × 1.00     (headingPath)
         + 0.16 × 0.67     (coverage)
         + 0.09 × 0.42     (outlier)
         + 0.08 × 1.00     (metaSection)

combined = 0.031 + 0.097 + 0.046 + 0.099 + 0.048 + 0.170 + 0.107 + 0.038 + 0.080
         = 0.716
```

**Heuristic Score: 0.716**

---

## Stage 5: Combined Ranking

BM25 and heuristic scores are combined:

```
combinedScore = 0.6 × bm25Score + 0.4 × heuristicScore
```

For sentence 6:
```
combinedScore = 0.6 × 0.85 + 0.4 × 0.716 = 0.796
```

### Final Rankings (Top 5)

| Rank | Sentence | Combined Score |
|------|----------|---------------|
| 1 | "Promises provide a cleaner way to handle asynchronous operations in JavaScript." | 0.796 |
| 2 | "Async/await is syntactic sugar over promises. It makes async code look synchronous." | 0.752 |
| 3 | "A Promise represents a value that may be available now, later, or never." | 0.687 |
| 4 | "You can chain promises using .then() and handle errors with .catch()." | 0.654 |
| 5 | Understanding Async JavaScript (h1) | 0.612 |

Notice that the sentence under the "Conclusion" heading scores lower due to the metaSection penalty:
- "In this article, we covered the evolution of async JavaScript patterns." scores **0.498** (meta-content penalty applied)

---

## Stage 6: Anchor Selection

Top-ranked sentences become "anchors" for excerpt extraction, with diversity filtering.

### Diversity Filtering

We don't want excerpts that are too similar. Jaccard similarity is used:

```
J(A, B) = |A ∩ B| / |A ∪ B|
```

If two sentences have Jaccard similarity > 0.5, only the higher-scoring one becomes an anchor.

### Position Diversity

Anchors must also be at least 3 sentences apart (minPositionGap = 3).

### Selected Anchors

1. **Sentence 6** (score 0.796) - "Promises provide a cleaner way..."
2. **Sentence 9** (score 0.752) - "Async/await is syntactic sugar..."

Sentence 7 was skipped because it's too close to sentence 6 (position gap = 1).

---

## Stage 7: Context Expansion

Each anchor is expanded into a "chunk" with surrounding context.

### Expansion Strategy

1. **Find section boundaries**: Identify the heading that starts this section and where the next same-level heading begins
2. **Expand outward**: Add sentences before/after the anchor, alternating
3. **Respect character budget**: Stop when chunk exceeds ~2000 characters
4. **Include code blocks**: If a code block follows the context, include it (with 50% budget overage allowed)

### Chunk for Anchor 1 (Sentence 6)

Section boundaries: H2 "Promises" to H2 "Async/Await"

```markdown
## Promises

Promises provide a cleaner way to handle asynchronous operations in JavaScript. A Promise represents a value that may be available now, later, or never. You can chain promises using .then() and handle errors with .catch().
```

---

## Stage 8: Deduplication & Assembly

If chunks overlap, they're merged or deduplicated.

### Overlap Detection

Chunks overlapping by more than 50% of sentences get merged.

### Final Excerpt Assembly

Excerpts are assembled within a character budget (default 3000 chars per page):

1. Sort chunks by score (descending)
2. Add chunks until budget exhausted
3. Format with heading paths for context

### Final Output

```markdown
**Understanding Async JavaScript > Promises**

Promises provide a cleaner way to handle asynchronous operations in JavaScript. A Promise represents a value that may be available now, later, or never. You can chain promises using .then() and handle errors with .catch().

---

**Understanding Async JavaScript > Async/Await**

Async/await is syntactic sugar over promises. It makes async code look synchronous.
```

---

## Why This Works

The algorithm succeeds because it combines multiple signals:

1. **BM25** finds sentences with query terms, weighted by rarity (IDF)
2. **Heading path** boosts sentences under relevant sections
3. **Coverage** ensures we find sentences with multiple query terms
4. **Proximity** prefers sentences where terms appear close together
5. **Meta-section penalty** demotes intro/conclusion fluff
6. **Position** slightly prefers early content (often more substantive)
7. **Diversity filtering** ensures varied excerpts
8. **Section-aware expansion** provides complete context

The result: excerpts that directly answer the query with sufficient context to be useful.

---

## Tuning Tips

| Goal | Adjust |
|------|--------|
| More excerpts | Increase `maxAnchors` |
| Longer excerpts | Increase `maxChunkChars` |
| Stricter relevance | Switch to `relevanceMode: "strict"` |
| More diverse results | Lower `diversityThreshold` |
| Favor term clustering | Increase `proximity` weight |
| Favor section matches | Increase `headingPath` weight |
