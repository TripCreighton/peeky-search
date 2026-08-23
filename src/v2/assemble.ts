/**
 * Budget-aware assembly.
 *
 * The oracle measurement is the whole argument for this module: every fact the
 * eval asks for IS present in the fetched corpus, spread across ~161k
 * characters, and v1 recovers 45% of them using 6.4k. This is a
 * selection-under-budget problem, not a missing-content problem — so the job
 * here is to spend a similar budget on a better-chosen set.
 *
 * Four constraints shape the greedy pass:
 *
 *   - DOCUMENT DIVERSITY. Facts are spread across documents, so one verbose
 *     page must not be allowed to eat the whole budget however well it scores.
 *   - NOVELTY. A near-duplicate passage costs budget and returns nothing;
 *     mirrored content across domains is common enough to need an exact-text
 *     check as well as a token-overlap one.
 *   - COVERAGE. Selection is re-decided every round on what a passage ADDS to
 *     what is already selected, not on how well it matches the query. See
 *     `coverageWeight`.
 *   - A RELEVANCE FLOOR. Efficiency is a target metric (1.20 nuggets/1k chars
 *     against v1's 0.539), so returning less text for the same facts is a win.
 *     Assembly stops when the remaining candidates stop earning their space; it
 *     never pads to fill the budget.
 *   - COST. Selection under a character ceiling is budgeted maximum coverage,
 *     so passages are ordered by score PER CHARACTER rather than by score. See
 *     `costExponent`; it is worth +0.033 recall on tranche 1 while spending
 *     fewer characters, and it is the single largest effect in this module.
 *
 * What this module is NOT short of is budget. An oracle selector allowed to see
 * the answer key, running over the exact candidate pool this module receives and
 * under the same structural caps, reaches 0.963 nugget recall in a median of
 * 3,589 characters — and 0.957 at a 6,000-character ceiling. Every fact is
 * already in the pool and affordable several times over. Everything this module
 * fails to return, it fails to return because of the ORDER it considers
 * candidates in, which is where any further work belongs.
 */

import type { Authority, Passage, PassageScore } from "./types";
import { tokenize } from "../preprocessing/tokenize";

// =============================================================================
// Input
// =============================================================================

/** A passage with everything assembly needs to order it. */
export interface RankedPassage {
    passage: Passage;
    score: PassageScore;
    /** Authority of the document this passage came from. */
    authority: Authority;
}

// =============================================================================
// Config
// =============================================================================

export interface AssembleBudget {
    /**
     * Hard ceiling on the total characters returned. Default 11000.
     *
     * Raised from 6000 on measurement, not on appetite. 78% of the nugget weight
     * the eval asks for already sits inside a page this pipeline RETURNS, while
     * only 47% of it was being selected — the loss was passages left behind on
     * pages already paid for.
     *
     * Re-measured under the priced selector (`costExponent`), which changed the
     * shape enough to be worth restating. Tranche 1, everything else fixed:
     *
     *    6000 chars: recall 0.470  badRate 0.065  eff 0.601
     *    8000 chars: recall 0.564  badRate 0.064  eff 0.544
     *   10000 chars: recall 0.623  badRate 0.063  eff 0.484
     *   11000 chars: recall 0.664  badRate 0.063  eff 0.472
     *   13000 chars: recall 0.668  badRate 0.077  eff 0.409
     *   16000 chars: recall 0.699  badRate 0.077  eff 0.365
     *
     * 11000 is the knee and the reason this stays where it is. Below it recall
     * falls fast; above it the curve flattens hard — the 2000 characters from
     * 11000 to 13000 buy +0.004 recall and cost +0.014 badRate, because by then
     * the marginal slot is going to a page that was ranked fifth for a reason.
     * Reaching 0.70 by spending alone needs ~16000 characters and gives back a
     * quarter of the efficiency to get there.
     */
    totalChars?: number;
    /** Max passages taken from any one document. Default 6. */
    maxPassagesPerDoc?: number;
    /**
     * Max characters taken from any one document. The passage cap alone is not
     * enough: three long passages from one authoritative page will happily
     * consume most of the budget and squeeze out the pages carrying the
     * remaining facts. Default 5000.
     *
     * PER-DOCUMENT BUDGET ALLOCATION IS A DEAD END, and the measurement is
     * recorded here so it is not attempted a third time. The intuition is
     * strong — the facts we miss visibly cluster on pages we already returned,
     * so a page that has proved itself should earn more of the budget — and it
     * is wrong in BOTH directions. A per-passage multiplier on documents already
     * drawn from, swept across two orders of magnitude on tranche 1:
     *
     *   spread  0.8 → recall 0.580   0.9 → 0.602
     *   uniform 1.0 → recall 0.659  (this configuration)
     *   concentrate 1.1 → 0.632   1.35 → 0.620   1.5 → 0.624   2.0 → 0.601
     *
     * Boosting by a document's summed score mass instead of by its draw count
     * behaves the same way: recall 0.625 at weight 1.0 against 0.659 uniform,
     * though it does buy source precision (0.800 against 0.752).
     *
     * The reason is structural rather than a tuning failure. Any per-document
     * term is MONOTONE WITHIN a document, so it cannot reorder that document's
     * own passages — it only changes how many are taken, in the order the
     * ranking already put them. On the tranche-1 TCP query the page we miss
     * facts on contributes its selected passage at rank 0 and the three passages
     * carrying the missed facts at ranks 22, 25 and 28; closing a 22-rank gap by
     * multiplication necessarily drags that page's ranks 1-21 in first, which is
     * exactly what the sweep shows as pages fall from 4.8 to 3.6 while recall
     * falls with them. The loss is in the ordering WITHIN a page, and no budget
     * allocation can reach it.
     */
    maxCharsPerDoc?: number;
    /** Max distinct documents represented in the output. Default 5. */
    maxDocs?: number;
    /**
     * How strongly authority reorders. `finalScore` is multiplied by
     * `1 + authorityWeight * (authority - 0.5) * 2`, so at 0.5 a
     * maximally-authoritative source gets +50% and a bottom-scoring one -50%.
     * Default 0.5.
     */
    authorityWeight?: number;
    /**
     * Authority at or below which a document is additionally damped by
     * `suppressFactor`. Set deliberately low: a content farm can still be the
     * only page stating a correct mechanism, and suppressing it trades recall
     * for precision. Default 0.15.
     */
    suppressBelow?: number;
    /** Multiplier applied below `suppressBelow`. Damping, not exclusion. Default 0.4. */
    suppressFactor?: number;
    /**
     * Stop once a candidate scores below this fraction of the best candidate's
     * score. This is the "do not pad" rule. Default 0.35.
     */
    relevanceFloor?: number;
    /** Token-containment above which a passage counts as already covered. Default 0.65. */
    noveltyThreshold?: number;
    /** Passages shorter than this are never worth a budget slot. Default 60. */
    minPassageChars?: number;
    /**
     * How much a passage's ordering is decided by what it ADDS rather than by
     * how well it matches.
     *
     * Measured, and the reason this module was rewritten: over an identical
     * candidate pool, an oracle selector that can see the answer key reaches
     * 0.966 nugget recall in ~2000 characters, while every relevance-ranked
     * selector spends three times that to reach 0.46-0.51. The pool is not short
     * of relevant passages; it is full of relevant passages that repeat each
     * other. So the ordering question is not "which passage matches best" but
     * "which passage says something none of the selected ones say".
     *
     * At 0 assembly is pure authority-weighted relevance (the previous
     * behaviour). At 1 a fully-redundant passage is worth nothing at all.
     *
     * The measured effect is real but small, and the shape of the curve is worth
     * recording so nobody re-runs the experiment: on tranche 1, 0.35 buys
     * +0.010 badRate and +0.038 source precision at unchanged recall, while 0.7
     * COSTS 0.026 recall. A strong diversity penalty pushes the second-best
     * passage on the right page out in favour of a novel passage on a worse one,
     * because novel WORDS are not novel FACTS. It is kept at the low end for
     * that reason rather than turned off, and the knob stays exposed.
     */
    coverageWeight?: number;
    /**
     * How much a passage's LENGTH counts against it when choosing what to select
     * next. 0 orders purely by score; 1 orders by score per character.
     *
     * This is the correction for what the budget actually is. Selection under a
     * fixed character ceiling is a budgeted maximum-coverage problem, and the
     * greedy that approximates it well picks the best RATIO of value to cost, not
     * the best value: taking an 1,895-character passage ahead of a 900-character
     * one of similar score spends twice the budget for the same claim, and the
     * passage that gets squeezed out is a fact we never return.
     *
     * The measured reason it is here: on tranche 1, of the nugget weight that
     * sits on a page the pipeline already RETURNED but did not select, 99 of 110
     * was blocked by the total budget being full — not by the relevance floor,
     * not by the per-document caps, and not by the novelty check. Ordering had
     * never been told what the budget costs.
     *
     * Measured on tranche 1, everything else fixed: 0 → recall 0.611, 0.25 →
     * 0.619, 0.5 → 0.615, 0.7 → 0.644, 1.0 → 0.621. It is a genuine optimum
     * rather than a monotone preference for brevity: past ~0.8 the ordering
     * starts buying fragments, and both recall and source precision give way.
     *
     * Cost is measured in units of `costReference` characters so the utility
     * stays on a readable scale; the scale itself cannot change the argmax.
     */
    costExponent?: number;
    /** Characters treated as one unit of cost. Scale only. Default 1000. */
    costReference?: number;
}

type ResolvedBudget = Required<AssembleBudget>;

export const DEFAULT_ASSEMBLE_BUDGET: ResolvedBudget = {
    totalChars: 11000,
    maxPassagesPerDoc: 6,
    maxCharsPerDoc: 5000,
    maxDocs: 5,
    authorityWeight: 0.5,
    suppressBelow: 0.15,
    suppressFactor: 0.4,
    relevanceFloor: 0.35,
    noveltyThreshold: 0.65,
    minPassageChars: 60,
    coverageWeight: 0.35,
    costExponent: 0.7,
    costReference: 1000,
};

// =============================================================================
// Ordering
// =============================================================================

/**
 * Blend relevance with source trust.
 *
 * Multiplicative rather than additive so authority scales a passage's own
 * relevance instead of substituting for it: an authoritative page that does not
 * answer the question still does not answer the question.
 */
export function finalScore(entry: RankedPassage, budget: ResolvedBudget): number {
    const relevance = Math.max(0, entry.score.combined);
    let multiplier = 1 + budget.authorityWeight * (entry.authority.score - 0.5) * 2;
    if (entry.authority.score <= budget.suppressBelow) multiplier *= budget.suppressFactor;
    return relevance * Math.max(0, multiplier);
}

// =============================================================================
// Novelty
// =============================================================================

/** Whitespace- and case-insensitive fingerprint, for mirrored content that is byte-identical after normalization. */
function exactKey(text: string): string {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Containment rather than Jaccard: a short passage fully contained in a long
 * one already selected adds nothing, and Jaccard would score that pair low
 * purely because the lengths differ.
 */
function containment(candidate: Set<string>, selected: Set<string>): number {
    if (candidate.size === 0) return 0;
    let shared = 0;
    for (const token of candidate) {
        if (selected.has(token)) shared++;
    }
    return shared / candidate.size;
}

// =============================================================================
// Coverage
// =============================================================================

/**
 * Informativeness weight per token, over the candidate set itself.
 *
 * A token appearing in nearly every candidate passage carries almost no
 * information about which passage to pick next — it is the topic, not the
 * fact. A token appearing in three passages out of four hundred is where a
 * stated fact lives. So novelty is measured in IDF mass rather than in token
 * counts: adding one passage that mentions `idempotent` for the first time is
 * worth more than adding a fourth restatement of the topic vocabulary.
 *
 * Computed from the candidates rather than injected, so assembly stays a pure
 * function of its input and can be unit-tested without a corpus.
 */
export function tokenWeights(tokenSets: Set<string>[]): Map<string, number> {
    const df = new Map<string, number>();
    for (const tokens of tokenSets) {
        for (const token of tokens) df.set(token, (df.get(token) ?? 0) + 1);
    }
    const total = Math.max(1, tokenSets.length);
    const weights = new Map<string, number>();
    for (const [token, count] of df) {
        weights.set(token, Math.log(1 + total / count));
    }
    return weights;
}

/**
 * The fraction of this passage's information weight that is NOT already
 * covered by what has been selected.
 *
 * A fraction rather than an absolute mass, so a long passage does not win a
 * budget slot merely by containing more words; what is being asked is "how much
 * of what this passage says is new", which is the quantity a reader cares about
 * per character spent.
 */
export function noveltyFraction(
    tokens: Set<string>,
    covered: Set<string>,
    weights: Map<string, number>,
): number {
    let total = 0;
    let novel = 0;
    for (const token of tokens) {
        const weight = weights.get(token) ?? 1;
        total += weight;
        if (!covered.has(token)) novel += weight;
    }
    if (total <= 0) return 1;
    return novel / total;
}

// =============================================================================
// Marginal utility
// =============================================================================

/**
 * What one more passage is worth right now, given what is already selected.
 *
 * Two corrections to the raw authority-weighted relevance, each answering a
 * question the plain score cannot:
 *
 *   - NOVELTY: how much of what it says has not already been said.
 *   - COST: what it will consume of a budget that is the measured binding
 *     constraint. Dividing by length turns "pick the best passage" into "pick
 *     the best passage per character", which is the greedy that actually
 *     approximates budgeted maximum coverage.
 *
 * There is deliberately no third term for how many passages this document has
 * already been given: see `maxCharsPerDoc` for the measurement that rules it
 * out in both directions.
 *
 * Pure and exported so each correction can be unit-tested in isolation.
 */
export function marginalUtility(
    final: number,
    novelty: number,
    charCount: number,
    settings: ResolvedBudget,
): number {
    const value = final * (1 - settings.coverageWeight + settings.coverageWeight * novelty);
    if (settings.costExponent === 0) return value;
    const reference = Math.max(1, settings.costReference);
    // Guard the degenerate passage: `minPassageChars` already excludes anything
    // this short, but the function must stay total for direct callers.
    const cost = Math.pow(Math.max(1, charCount) / reference, settings.costExponent);
    return cost > 0 ? value / cost : value;
}

// =============================================================================
// Entry point
// =============================================================================

/**
 * Select passages greedily under a character budget, maximizing COVERAGE rather
 * than relevance.
 *
 * Each round picks the eligible passage with the highest marginal utility —
 * authority-weighted relevance discounted by how much of what it says has
 * already been said. The relevance floor still runs off the undiscounted score,
 * so coverage decides the ORDER of selection but can never promote a passage
 * that does not answer the question.
 *
 * Deterministic throughout: ties in marginal utility resolve on passage id
 * ascending, so an equal-scoring pair always selects the same way and an eval
 * diff stays meaningful.
 */
export function assemble(scored: RankedPassage[], budget: AssembleBudget = {}): Passage[] {
    const settings: ResolvedBudget = { ...DEFAULT_ASSEMBLE_BUDGET, ...budget };

    const eligible = scored.filter((entry) => entry.passage.charCount >= settings.minPassageChars);

    // Document mass is read off the SAME scores that order passages, so a page
    // cannot gain mass from passages that would never be eligible anyway.
    const candidates = eligible
        .map((entry) => ({
            entry,
            final: finalScore(entry, settings),
            tokens: new Set(tokenize(entry.passage.text)),
            taken: false,
        }))
        .sort((a, b) => {
            const diff = b.final - a.final;
            if (diff !== 0) return diff;
            return a.entry.passage.id.localeCompare(b.entry.passage.id);
        });

    const best = candidates[0];
    if (best === undefined) return [];
    const floor = best.final * settings.relevanceFloor;

    // Read off the candidate set itself, so assembly stays a pure function of
    // its input and can be unit-tested without a corpus.
    const weights = tokenWeights(candidates.map((candidate) => candidate.tokens));

    const selected: Passage[] = [];
    const selectedTokens: Set<string>[] = [];
    const covered = new Set<string>();
    const seenExact = new Set<string>();
    const perDoc = new Map<string, number>();
    const charsPerDoc = new Map<string, number>();
    let used = 0;

    for (;;) {
        if (used >= settings.totalChars) break;

        let chosen: (typeof candidates)[number] | null = null;
        let chosenUtility = 0;

        for (const candidate of candidates) {
            if (candidate.taken) continue;
            // Sorted by `final`, so everything from here down is below the floor
            // too. This is the "do not pad the budget" rule, and it is kept on
            // the undiscounted score deliberately: novelty may reorder what is
            // worth reading, but it may not make an irrelevant passage eligible.
            if (candidate.final < floor) break;

            const passage = candidate.entry.passage;
            const docCount = perDoc.get(passage.docUrl) ?? 0;
            const docChars = charsPerDoc.get(passage.docUrl) ?? 0;
            if (docCount >= settings.maxPassagesPerDoc) continue;
            if (docCount === 0 && perDoc.size >= settings.maxDocs) continue;
            if (docChars + passage.charCount > settings.maxCharsPerDoc && docCount > 0) continue;
            if (used + passage.charCount > settings.totalChars) continue;
            if (seenExact.has(exactKey(passage.text))) continue;

            let duplicate = false;
            for (const previous of selectedTokens) {
                if (containment(candidate.tokens, previous) >= settings.noveltyThreshold) {
                    duplicate = true;
                    break;
                }
            }
            if (duplicate) continue;

            const novelty = noveltyFraction(candidate.tokens, covered, weights);
            const utility =
                marginalUtility(candidate.final, novelty, passage.charCount, settings);

            // Strictly greater, so the first passage in the deterministic
            // `final`-then-id order wins a tie.
            if (chosen === null || utility > chosenUtility) {
                chosen = candidate;
                chosenUtility = utility;
            }
        }

        if (chosen === null) break;

        const passage = chosen.entry.passage;
        chosen.taken = true;
        selected.push(passage);
        selectedTokens.push(chosen.tokens);
        for (const token of chosen.tokens) covered.add(token);
        seenExact.add(exactKey(passage.text));
        perDoc.set(passage.docUrl, (perDoc.get(passage.docUrl) ?? 0) + 1);
        charsPerDoc.set(passage.docUrl, (charsPerDoc.get(passage.docUrl) ?? 0) + passage.charCount);
        used += passage.charCount;
    }

    return selected;
}
