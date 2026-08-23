/**
 * OPTIONAL cross-encoder reranking stage. DEFAULT OFF.
 *
 * `PassageScore.semantic` has been a reserved, permanently-zero component since
 * `rank.ts` was written, and `RankContext.semantic` is the seam that fills it.
 * This module is what fills it: a two-stage retrieval shape in which the cheap
 * lexical ranker chooses which passages are worth a forward pass, and a
 * pretrained cross-encoder reorders those and nothing else.
 *
 * WHY A CROSS-ENCODER AND NOT AN EMBEDDING MODEL
 * ----------------------------------------------
 * A bi-encoder embeds query and passage separately, so it can be indexed — but
 * it can only ever compare two summaries. A cross-encoder reads the pair
 * jointly, which is what lets it distinguish a passage that STATES a fact from
 * one that MENTIONS the topic. That distinction is precisely what the current
 * feature set cannot make: measured over tranche 1's candidate passages, the
 * best within-query AUC any combination of lexical, structural and positional
 * features reaches is 0.718. The price is that there is no index: it costs one
 * forward pass PER PAIR, every query, which is why only the top `topK`
 * survivors of the first stage are ever scored.
 *
 * THE DEPENDENCY IS DELIBERATELY NOT IMPORTED HERE
 * ------------------------------------------------
 * `@huggingface/transformers` is NOT a dependency of this package, in any
 * position. It is reached only through a dynamic import inside
 * `createTransformersScorer`, so anyone wanting to run the stage installs it
 * themselves. Nothing in the shipping pipeline, and no test, loads it: the stage
 * is driven through the `PairScorer` function type, so a stub is a two-line
 * closure. If the reranker is never switched on, this file costs one unused
 * module and no install weight.
 */

import type { Passage, PassageScore } from "./types";
import type { RankConfig } from "./rank";

// =============================================================================
// The seam
// =============================================================================

/**
 * Score every text against one query. Higher is more relevant; the scale is
 * whatever the model emits and is normalized downstream.
 *
 * A plain function rather than a class so the stage can be exercised with a
 * closure — which is how every test in this repository drives it, and why none
 * of them need the model or the network.
 */
export type PairScorer = (query: string, texts: string[]) => Promise<number[]>;

// =============================================================================
// Config
// =============================================================================

/**
 * How reranked scores are mapped onto the 0-1 scale every other `PassageScore`
 * component lives on.
 *
 * `minmax` spreads the reranked set across the full range, exactly as `rank.ts`
 * already max-normalizes BM25 against the candidate set. It is scale-free, so
 * one blend weight means the same thing for a model whose logits span -12..+11
 * and for one that emits 0..8.
 *
 * `sigmoid` keeps the model's ABSOLUTE calibration instead: a query for which
 * nothing is relevant produces uniformly small semantic scores rather than
 * being stretched to look decisive. That is the more honest mapping and the
 * weaker signal, because assembly only ever compares within one query.
 *
 * `permute` is a DIAGNOSTIC, and only meaningful at weight 1. It hands the
 * top-K back the first stage's own score VALUES, reassigned in the reranker's
 * order — the same multiset of scores, permuted. Everything downstream that
 * reads a score magnitude rather than a rank (`relevanceFloor`, and the
 * value-per-character ordering in `marginalUtility`) therefore sees exactly the
 * distribution it saw before, so a recall difference under `permute` is
 * attributable to the reranker's ORDERING and to nothing else. Paired with a
 * constant scorer it degenerates to the identity, which measures the cost of
 * top-K truncation on its own. Those two runs together decompose the effect;
 * neither is a shape anyone would deploy.
 */
export type RerankNormalization = "minmax" | "sigmoid" | "permute";

export interface RerankConfig {
    /** Hugging Face repo id. Must publish ONNX weights. */
    model: string;
    /** Quantization passed straight to transformers.js: "fp32", "q8", "int8". */
    dtype: string;
    /**
     * How many first-stage survivors get a forward pass.
     *
     * This is the whole cost knob. Assembly can select at most
     * `maxDocs * maxPassagesPerDoc` = 30 passages, so a K far above that buys
     * only the chance that reordering promotes something the first stage had
     * ranked deep.
     */
    topK: number;
    /**
     * Convex blend weight on the semantic component, in [0, 1].
     *
     * Applied by `blendRankConfig`, which scales every LEXICAL weight by
     * `1 - weight` and sets the semantic weight to `weight`. So 0 reproduces
     * the baseline ranking exactly (a uniform rescale cannot reorder anything),
     * and 1 discards the lexical evidence entirely.
     *
     * A convex blend rather than an additive bonus because the exact-match
     * signal is the one thing a cross-encoder is reliably WORSE at: an error
     * string or a symbol is a near-certain relevance anchor, and a neural score
     * that has never seen the identifier should not be able to outvote it. A
     * blend can only ever dilute that; an additive term would let a
     * high-semantic passage outscore an exact hit outright.
     */
    weight: number;
    /** Truncation length in tokens. Passages are 900-1900 chars, so this bites. */
    maxLength: number;
    /** Pairs per forward pass. */
    batchSize: number;
    normalization: RerankNormalization;
}

/**
 * bge-reranker-base at int8, the configuration measured as costing nothing in
 * recall against fp32 while being a quarter of the size. `weight` is the number
 * that has to be earned by measurement; everything else is a cost decision.
 */
export const DEFAULT_RERANK_CONFIG: RerankConfig = {
    model: "Xenova/bge-reranker-base",
    dtype: "q8",
    topK: 50,
    weight: 0.5,
    maxLength: 256,
    batchSize: 16,
    normalization: "minmax",
};

/**
 * One reranked candidate, with the model's opinion of it and the first stage's
 * side by side.
 *
 * Exists for one measurement: whether the cross-encoder separates a passage
 * that STATES a labeled fact from one that merely mentions the topic BETTER
 * than the lexical score does. That is the entire premise of adding it, and a
 * recall number cannot answer it — a reranker can order well and still lose
 * recall to the assembly stage, or order badly and be rescued by it.
 */
export interface RerankedCandidate {
    passageId: string;
    text: string;
    /** The model's raw output, on whatever scale it emits. */
    raw: number;
    /** After `normalization`, on the 0-1 scale the blend consumes. */
    normalized: number;
    /** The first stage's `combined` for the same passage. */
    lexical: number;
}

/** Per-query cost, so the latency claim is measured rather than extrapolated from per-pair benchmarks. */
export interface RerankTiming {
    /** Pairs handed to the scorer. */
    pairs: number;
    /** Wall-clock milliseconds spent inside the scorer. */
    ms: number;
}

/**
 * Everything `searchV2` needs to run the stage. The scorer is a function and
 * therefore NOT serializable, which is why it is carried here rather than in
 * `ResolvedV2Config` — a run file has to stay a plain JSON record of the knobs.
 */
export interface RerankOptions extends Partial<RerankConfig> {
    /** Absent means the stage does not run, whatever the other knobs say. */
    scorer?: PairScorer;
    /** Observer for per-query cost. */
    onTiming?: (timing: RerankTiming) => void;
    /** Diagnostic observer. Never set by anything that ships. */
    onScored?: (candidates: RerankedCandidate[]) => void;
}

/** Strip the non-serializable fields, leaving the record of what a run was configured with. */
export function resolveRerankConfig(options: RerankOptions | undefined): RerankConfig | null {
    if (options === undefined || options.scorer === undefined) return null;
    const { scorer: _scorer, onTiming: _onTiming, ...knobs } = options;
    return { ...DEFAULT_RERANK_CONFIG, ...knobs };
}

// =============================================================================
// Blending
// =============================================================================

/**
 * Rebalance a `RankConfig` so the semantic component carries `weight` of the
 * decision and the lexical components share the rest.
 *
 * At weight 0 this returns weights that are numerically identical to the input,
 * so "reranker off" and "reranker on at weight 0" are the same run — which is
 * what makes the control in the comparison table a genuine control rather than
 * a near-miss.
 */
export function blendRankConfig(config: RankConfig, weight: number): RankConfig {
    const w = weight < 0 ? 0 : weight > 1 ? 1 : weight;
    const keep = 1 - w;
    return {
        ...config,
        weights: {
            bm25: config.weights.bm25 * keep,
            exact: config.weights.exact * keep,
            headingMatch: config.weights.headingMatch * keep,
            structure: config.weights.structure * keep,
            endorsement: config.weights.endorsement * keep,
            semantic: w,
        },
    };
}

// =============================================================================
// Normalization
// =============================================================================

function sigmoid(value: number): number {
    return 1 / (1 + Math.exp(-value));
}

/**
 * Redistribute `values` onto positions ordered by `raw`: the largest `raw`
 * receives the largest value, and so on down.
 *
 * Ties in `raw` resolve on the original index ascending, which is what makes a
 * CONSTANT scorer the exact identity — the property the truncation-only control
 * depends on.
 */
export function permuteOnto(raw: number[], values: number[]): number[] {
    const order = raw.map((value, index) => ({ value, index }));
    order.sort((a, b) => {
        const diff = b.value - a.value;
        if (diff !== 0) return diff;
        return a.index - b.index;
    });
    const descending = [...values].sort((a, b) => b - a);

    const out = new Array<number>(raw.length).fill(0);
    for (let rank = 0; rank < order.length; rank++) {
        const slot = order[rank];
        if (slot === undefined) continue;
        out[slot.index] = descending[rank] ?? 0;
    }
    return out;
}

/**
 * Map raw model outputs onto 0-1.
 *
 * `minmax` over a degenerate set (one candidate, or every score equal) returns
 * 1 rather than 0: those passages are the reranker's own top choices, and
 * handing them a zero semantic score would let the blend actively demote the
 * only things it was asked about.
 */
export function normalizeRerankScores(raw: number[], mode: RerankNormalization): number[] {
    if (mode === "sigmoid") return raw.map(sigmoid);
    if (mode === "permute") return permuteOnto(raw, raw);
    if (raw.length === 0) return [];

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of raw) {
        if (value < min) min = value;
        if (value > max) max = value;
    }
    const range = max - min;
    if (!Number.isFinite(range) || range <= 0) return raw.map(() => 1);
    return raw.map((value) => (value - min) / range);
}

// =============================================================================
// Entry point
// =============================================================================

export interface RerankResult {
    /** Semantic score in 0-1 by passage id. Passages outside the top-K are absent. */
    semantic: Map<string, number>;
    timing: RerankTiming;
    /** Every reranked candidate, in first-stage order. For diagnosis. */
    candidates: RerankedCandidate[];
}

/**
 * Rerank the first stage's top `topK` passages.
 *
 * Passages outside the top-K are deliberately left ABSENT from the returned map
 * rather than given a neutral value. `rank.ts` reads a missing entry as 0, so
 * under a convex blend a passage the first stage ranked 200th keeps only
 * `1 - weight` of its lexical score and gains nothing — which is exactly what
 * two-stage retrieval means. Pretending otherwise (a neutral 0.5 for the
 * unscored tail) would measure a system nobody can deploy, since the whole
 * point of the first stage is that the other 700 passages never cost a forward
 * pass.
 *
 * Ordering is taken from `firstStage`, which `scorePassages` already returns
 * sorted by `combined` descending with a passage-id tie-break, so the top-K
 * membership is deterministic.
 */
export async function rerankPassages(
    queryText: string,
    passages: Passage[],
    firstStage: PassageScore[],
    scorer: PairScorer,
    config: RerankConfig,
): Promise<RerankResult> {
    const byId = new Map(passages.map((passage) => [passage.id, passage]));
    const survivors: Passage[] = [];
    const survivorCombined: number[] = [];
    for (const score of firstStage) {
        if (survivors.length >= config.topK) break;
        const passage = byId.get(score.passageId);
        if (passage !== undefined) {
            survivors.push(passage);
            survivorCombined.push(score.combined);
        }
    }

    if (survivors.length === 0) {
        return { semantic: new Map(), timing: { pairs: 0, ms: 0 }, candidates: [] };
    }

    // The full passage text, heading line included. The heading is the passage's
    // context and a cross-encoder can use it; `rank.ts` excludes it from BM25
    // only because `headingMatch` scores it separately, and there is no second
    // semantic component to double-count against.
    const texts = survivors.map((passage) => passage.text);

    const start = performance.now();
    const raw = await scorer(queryText, texts);
    const ms = performance.now() - start;

    const rawScores = survivors.map((_, index) => raw[index] ?? 0);
    const normalized =
        config.normalization === "permute"
            ? permuteOnto(rawScores, survivorCombined)
            : normalizeRerankScores(rawScores, config.normalization);

    const semantic = new Map<string, number>();
    const candidates: RerankedCandidate[] = [];
    for (let i = 0; i < survivors.length; i++) {
        const passage = survivors[i];
        if (passage === undefined) continue;
        const value = normalized[i] ?? 0;
        semantic.set(passage.id, value);
        candidates.push({
            passageId: passage.id,
            text: passage.text,
            raw: rawScores[i] ?? 0,
            normalized: value,
            lexical: survivorCombined[i] ?? 0,
        });
    }

    return { semantic, timing: { pairs: survivors.length, ms }, candidates };
}

// =============================================================================
// The real model
// =============================================================================

/** Minimal structural types; the real ones live in the dev dependency. */
interface TokenizerLike {
    (
        text: string[],
        options: { text_pair: string[]; padding: boolean; truncation: boolean; max_length?: number },
    ): unknown;
}

interface ModelLike {
    (inputs: unknown): Promise<{ logits: { data: ArrayLike<number>; dims: number[] } }>;
}

export interface TransformersScorer {
    scorer: PairScorer;
    /** Milliseconds spent loading tokenizer + weights. The MCP cold-start cost. */
    loadMs: number;
    stats(): { pairs: number; inferenceMs: number; batches: number };
}

/**
 * Load a real cross-encoder from `@huggingface/transformers`.
 *
 * Throws with an actionable message when the dev dependency is missing, so an
 * experiment never silently falls back to a differently-scored code path. This
 * is the ONLY function in the file that can pull the dependency in, and nothing
 * in the shipping pipeline calls it.
 */
export async function createTransformersScorer(
    config: Partial<RerankConfig> & { cacheDir?: string } = {},
): Promise<TransformersScorer> {
    const settings = { ...DEFAULT_RERANK_CONFIG, ...config };

    // The specifier is held in a variable ON PURPOSE. A bundler resolves a
    // literal dynamic import and inlines the target, which put 1.5 MB of
    // transformers.js and a 410 KB native ONNX binding inside the shipping
    // bundle the first time this was written. Behind a variable esbuild leaves
    // the import alone, so the module is reached at RUNTIME or not at all —
    // which is the only way a dev dependency stays a dev dependency.
    const specifier = "@huggingface/transformers";
    type Transformers = typeof import("@huggingface/transformers");

    let lib: Transformers;
    try {
        lib = (await import(specifier)) as Transformers;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
            "@huggingface/transformers is not installed. It is deliberately not a dependency of " +
                `this package; install it yourself to use this stage: \`pnpm add -D @huggingface/transformers\`. (${message})`,
        );
    }

    if (config.cacheDir !== undefined) lib.env.cacheDir = config.cacheDir;

    const start = performance.now();
    const tokenizer = (await lib.AutoTokenizer.from_pretrained(settings.model)) as unknown as TokenizerLike;
    const model = (await lib.AutoModelForSequenceClassification.from_pretrained(settings.model, {
        dtype: settings.dtype as never,
        device: "cpu",
    })) as unknown as ModelLike;
    const loadMs = performance.now() - start;

    let pairs = 0;
    let inferenceMs = 0;
    let batches = 0;

    const scorer: PairScorer = async (query, texts) => {
        const scores: number[] = [];
        for (let i = 0; i < texts.length; i += settings.batchSize) {
            const batch = texts.slice(i, i + settings.batchSize);
            const inputs = tokenizer(new Array<string>(batch.length).fill(query), {
                text_pair: batch,
                padding: true,
                truncation: true,
                max_length: settings.maxLength,
            });

            const t0 = performance.now();
            const output = await model(inputs);
            inferenceMs += performance.now() - t0;
            batches += 1;
            pairs += batch.length;

            // num_labels is 1 for the MS MARCO regression heads and for
            // bge-reranker; 2 for models trained as binary classifiers. The last
            // column is the relevance logit in either case.
            const dims = output.logits.dims;
            const width = dims[dims.length - 1] ?? 1;
            for (let row = 0; row < batch.length; row++) {
                scores.push(output.logits.data[row * width + (width - 1)] ?? 0);
            }
        }
        return scores;
    };

    return { scorer, loadMs, stats: () => ({ pairs, inferenceMs, batches }) };
}
