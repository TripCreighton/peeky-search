/**
 * Nugget matcher for the evaluation harness.
 *
 * A nugget is an atomic fact authored against a page's full text. Matching a
 * nugget against a pipeline's returned excerpts is what turns raw pipeline
 * output into a recall metric, so the matcher must be strict, deterministic,
 * and free of false positives: a bug here silently invalidates every
 * downstream scoreboard decision.
 */
import type { AnchorGroup, Nugget, NuggetMatch, RunPage } from "./types";

/** Result of matching a single nugget against a single excerpt. */
interface ExcerptMatchResult {
    matched: boolean;
    span?: number;
}

/** One occurrence of an anchor term inside a normalized excerpt. */
interface TermOccurrence {
    index: number;
    length: number;
    groupIndex: number;
}

/**
 * Normalize text for nugget matching: lowercase, collapse all whitespace
 * runs (including newlines and tabs) to a single space, then trim.
 *
 * Punctuation is deliberately preserved — anchors legitimately contain `_`,
 * `-`, `.`, `()` (e.g. `err_pnpm_outdated_lockfile`), and substring matching
 * already makes trailing punctuation on the page side harmless.
 */
export function normalizeForMatch(text: string): string {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Find every occurrence of every anchor term in the normalized excerpt,
 * tagged with the index of the anchor group it belongs to. Overlapping
 * occurrences of the same term are all recorded.
 */
function findOccurrences(anchors: AnchorGroup[], normalizedExcerpt: string): TermOccurrence[] {
    const occurrences: TermOccurrence[] = [];

    for (let groupIndex = 0; groupIndex < anchors.length; groupIndex++) {
        const group = anchors[groupIndex];
        if (group === undefined) continue;

        for (const rawTerm of group) {
            const term = normalizeForMatch(rawTerm);
            if (term.length === 0) continue;

            let fromIndex = 0;
            while (fromIndex <= normalizedExcerpt.length) {
                const index = normalizedExcerpt.indexOf(term, fromIndex);
                if (index === -1) break;

                occurrences.push({ index, length: term.length, groupIndex });
                fromIndex = index + 1;
            }
        }
    }

    return occurrences;
}

/**
 * Minimal spanning window containing at least one occurrence from every
 * group (0..groupCount-1). Uses the same sliding-window shape as
 * `calculateProximityScore` in `scoring/heuristics.ts`: collect all tagged
 * occurrences, sort by index, slide a window forward tracking how many
 * distinct groups are covered, and shrink from the left whenever all groups
 * are covered to record the tightest span seen.
 *
 * Span = (index of last occurrence in window + length of that term) -
 * (index of first occurrence in window). Returns null if the occurrences do
 * not cover every group.
 */
function minimalSpanningWindow(occurrences: TermOccurrence[], groupCount: number): number | null {
    if (groupCount === 0) return null;

    const sorted = [...occurrences].sort((a, b) => a.index - b.index);

    const windowGroupCount = new Map<number, number>();
    let uniqueGroupsInWindow = 0;
    let left = 0;
    let minSpan: number | null = null;

    for (let right = 0; right < sorted.length; right++) {
        const rightItem = sorted[right];
        if (rightItem === undefined) continue;

        const prevCount = windowGroupCount.get(rightItem.groupIndex) ?? 0;
        windowGroupCount.set(rightItem.groupIndex, prevCount + 1);
        if (prevCount === 0) {
            uniqueGroupsInWindow++;
        }

        while (uniqueGroupsInWindow === groupCount) {
            const leftItem = sorted[left];
            if (leftItem === undefined) break;

            const span = rightItem.index + rightItem.length - leftItem.index;
            if (minSpan === null || span < minSpan) {
                minSpan = span;
            }

            const leftCount = windowGroupCount.get(leftItem.groupIndex) ?? 0;
            windowGroupCount.set(leftItem.groupIndex, leftCount - 1);
            if (leftCount - 1 === 0) {
                uniqueGroupsInWindow--;
            }
            left++;
        }
    }

    return minSpan;
}

/**
 * Match a nugget against a single excerpt's text.
 *
 * All of the following must hold for a match:
 * 1. Every anchor group is satisfied (any term in the group is a substring
 *    of the normalized excerpt).
 * 2. If `pattern` is present, it matches the normalized excerpt
 *    case-insensitively. An invalid regex throws rather than silently
 *    failing to match, since malformed nuggets should fail loudly.
 * 3. If `window` is present, the minimal spanning window covering one
 *    occurrence from every group is <= window characters.
 *
 * An empty `anchors` array never matches — a malformed nugget with no
 * anchors must not vacuously match everything.
 */
export function matchNuggetInExcerpt(nugget: Nugget, excerptText: string): ExcerptMatchResult {
    if (nugget.anchors.length === 0) {
        return { matched: false };
    }

    const normalizedExcerpt = normalizeForMatch(excerptText);

    for (const group of nugget.anchors) {
        const groupSatisfied = group.some(term => normalizedExcerpt.includes(normalizeForMatch(term)));
        if (!groupSatisfied) {
            return { matched: false };
        }
    }

    if (nugget.pattern !== undefined) {
        let regex: RegExp;
        try {
            regex = new RegExp(nugget.pattern, "i");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`Nugget "${nugget.id}" has an invalid pattern regex "${nugget.pattern}": ${message}`);
        }

        if (!regex.test(normalizedExcerpt)) {
            return { matched: false };
        }
    }

    const occurrences = findOccurrences(nugget.anchors, normalizedExcerpt);
    const span = minimalSpanningWindow(occurrences, nugget.anchors.length);

    if (nugget.window !== undefined) {
        if (span === null || span > nugget.window) {
            return { matched: false };
        }
    }

    if (span === null) {
        return { matched: true };
    }

    return { matched: true, span };
}

/**
 * Match a nugget against every excerpt of every page, in order. Pages are
 * iterated in array order, then excerpts within a page in array order; the
 * first match found is recorded. Deterministic: identical inputs always
 * yield an identical result.
 */
export function matchNuggetInPages(nugget: Nugget, pages: RunPage[]): NuggetMatch {
    for (const page of pages) {
        for (let excerptIndex = 0; excerptIndex < page.excerpts.length; excerptIndex++) {
            const excerpt = page.excerpts[excerptIndex];
            if (excerpt === undefined) continue;

            const result = matchNuggetInExcerpt(nugget, excerpt.text);
            if (result.matched) {
                return {
                    nuggetId: nugget.id,
                    matched: true,
                    pageUrl: page.url,
                    excerptIndex,
                    ...(result.span !== undefined ? { span: result.span } : {}),
                };
            }
        }
    }

    return { nuggetId: nugget.id, matched: false };
}

/** Match every nugget against a run's pages. Order-preserving over `nuggets`. */
export function matchNuggets(nuggets: Nugget[], pages: RunPage[]): NuggetMatch[] {
    return nuggets.map(nugget => matchNuggetInPages(nugget, pages));
}
