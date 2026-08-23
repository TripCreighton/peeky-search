/**
 * Query set and label loading/validation.
 *
 * Queries live in `eval/queries/queryset.json`; labels live one-per-query as
 * `eval/labels/*.json`. Validation collects every problem it finds and
 * throws a single error describing all of them, so a labeler fixing a batch
 * of issues does not have to run the validator once per fix.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Query, QueryCategory, QueryLabel, SourceGrade, SourceLabel } from "./types";
import { canonicalizeUrl } from "./cache";

const QUERY_CATEGORIES: readonly QueryCategory[] = [
    "api-docs",
    "debugging",
    "conceptual",
    "how-to",
    "version-specific",
    "comparison",
    "general",
];

const SOURCE_GRADES: readonly SourceGrade[] = ["canonical", "good", "acceptable", "bad"];

const VALID_DIFFICULTIES = [1, 2, 3];
const VALID_TRANCHES = [1, 2];

/**
 * Nuggets above this window are usually two facts glued together and should
 * be split. Not a hard limit: `loadLabels` warns rather than rejecting, so
 * labelers see it without being blocked.
 */
const RECOMMENDED_MAX_WINDOW = 600;

function isQueryCategory(value: unknown): value is QueryCategory {
    return typeof value === "string" && (QUERY_CATEGORIES as readonly string[]).includes(value);
}

function isSourceGrade(value: unknown): value is SourceGrade {
    return typeof value === "string" && (SOURCE_GRADES as readonly string[]).includes(value);
}

/** Thrown by `validate` with every problem found, not just the first. */
export class ValidationError extends Error {
    readonly problems: string[];

    constructor(problems: string[]) {
        super(
            `Query set / label validation failed with ${problems.length} problem(s):\n` +
            problems.map((p) => `  - ${p}`).join("\n")
        );
        this.name = "ValidationError";
        this.problems = problems;
    }
}

/** Reads `eval/queries/queryset.json`, shape `{ "queries": Query[] }`. */
export function loadQuerySet(path: string): Query[] {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { queries: Query[] };
    return parsed.queries;
}

export interface LoadLabelsResult {
    labels: Map<string, QueryLabel>;
    /**
     * Non-blocking issues found while loading (e.g. an overlong nugget
     * window). Never thrown - surface these to the labeler/CLI directly.
     */
    warnings: string[];
}

/**
 * Non-blocking warnings for a single label, e.g. a nugget whose `window` is
 * wide enough that it probably encodes two facts instead of one. Exported
 * separately so it can be unit-tested without touching the filesystem.
 */
export function warningsForLabel(label: QueryLabel): string[] {
    const warnings: string[] = [];

    for (const nugget of label.nuggets ?? []) {
        if (nugget.window !== undefined && nugget.window > RECOMMENDED_MAX_WINDOW) {
            warnings.push(
                `label "${label.queryId}" nugget "${nugget.id}": window ${nugget.window} exceeds ` +
                `the recommended max of ${RECOMMENDED_MAX_WINDOW} chars - consider splitting into two nuggets`
            );
        }
    }

    return warnings;
}

/**
 * Reads every `*.json` in `dir` (normally `eval/labels/`) as a QueryLabel.
 * Returns non-blocking warnings alongside the loaded labels; it never
 * rejects a label itself (that is `validate`'s job).
 */
export function loadLabels(dir: string): LoadLabelsResult {
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
    const labels = new Map<string, QueryLabel>();
    const warnings: string[] = [];

    for (const file of files) {
        const raw = readFileSync(join(dir, file), "utf-8");
        const label = JSON.parse(raw) as QueryLabel;
        labels.set(label.queryId, label);
        warnings.push(...warningsForLabel(label));
    }

    return { labels, warnings };
}

function validateQuery(query: Query, problems: string[], seenIds: Set<string>): void {
    const id = query.id;
    const label = id && id.trim() !== "" ? `query "${id}"` : "query with missing/empty id";

    if (!id || id.trim() === "") {
        problems.push("query: id is missing or empty");
    } else if (seenIds.has(id)) {
        problems.push(`query "${id}": duplicate id`);
    } else {
        seenIds.add(id);
    }

    if (!isQueryCategory(query.category)) {
        problems.push(`${label}: invalid category "${String(query.category)}"`);
    }

    if (!VALID_DIFFICULTIES.includes(query.difficulty)) {
        problems.push(`${label}: invalid difficulty "${String(query.difficulty)}" (must be 1, 2, or 3)`);
    }

    if (!query.text || query.text.trim() === "") {
        problems.push(`${label}: text is empty`);
    }

    if (query.tranche !== undefined && !VALID_TRANCHES.includes(query.tranche)) {
        problems.push(`${label}: invalid tranche "${String(query.tranche)}" (must be 1 or 2)`);
    }
}

function validateLabel(label: QueryLabel, knownQueryIds: Set<string>, problems: string[]): void {
    const queryLabel = label.queryId && label.queryId.trim() !== "" ? `label "${label.queryId}"` : "label with missing queryId";

    if (!label.queryId || label.queryId.trim() === "") {
        problems.push("label: queryId is missing or empty");
    } else if (!knownQueryIds.has(label.queryId)) {
        problems.push(`${queryLabel}: queryId does not reference a known query`);
    }

    const seenNuggetIds = new Set<string>();
    for (const nugget of label.nuggets ?? []) {
        if (seenNuggetIds.has(nugget.id)) {
            problems.push(`${queryLabel}: duplicate nugget id "${nugget.id}"`);
        } else {
            seenNuggetIds.add(nugget.id);
        }

        if (!nugget.anchors || nugget.anchors.length === 0) {
            problems.push(`${queryLabel} nugget "${nugget.id}": anchors must be non-empty`);
        } else {
            nugget.anchors.forEach((group, groupIndex) => {
                if (!group || group.length === 0) {
                    problems.push(`${queryLabel} nugget "${nugget.id}": anchor group ${groupIndex} must be non-empty`);
                    return;
                }
                for (const term of group) {
                    if (!term || term.trim() === "") {
                        problems.push(`${queryLabel} nugget "${nugget.id}": anchor term is empty`);
                    } else if (term !== term.toLowerCase()) {
                        problems.push(
                            `${queryLabel} nugget "${nugget.id}": anchor term "${term}" must be lowercase`
                        );
                    }
                }
            });
        }

        if (nugget.pattern !== undefined) {
            try {
                new RegExp(nugget.pattern);
            } catch {
                problems.push(`${queryLabel} nugget "${nugget.id}": pattern "${nugget.pattern}" does not compile`);
            }
        }

        if (nugget.weight !== undefined && !(nugget.weight > 0)) {
            problems.push(`${queryLabel} nugget "${nugget.id}": weight must be > 0`);
        }

        if (nugget.window === undefined) {
            problems.push(`${queryLabel} nugget "${nugget.id}": window is required`);
        } else if (!Number.isInteger(nugget.window) || nugget.window <= 0) {
            problems.push(`${queryLabel} nugget "${nugget.id}": window must be a positive integer`);
        }

        if (nugget.sources !== undefined) {
            for (const source of nugget.sources) {
                try {
                    new URL(source);
                } catch {
                    problems.push(`${queryLabel} nugget "${nugget.id}": source "${source}" is not a valid URL`);
                }
            }
        }
    }

    for (const source of label.sources ?? []) {
        if (!source.match || source.match.trim() === "") {
            problems.push(`${queryLabel}: source match is empty`);
        }
        if (!isSourceGrade(source.grade)) {
            problems.push(`${queryLabel}: invalid grade "${String(source.grade)}" for match "${source.match}"`);
        }
    }
}

/**
 * Validates queries and labels together (label validity depends on knowing
 * which query ids exist). Collects every problem and throws once; never
 * throws on the first problem found.
 */
export function validate(queries: Query[], labels: Map<string, QueryLabel>): void {
    const problems: string[] = [];
    const seenQueryIds = new Set<string>();

    for (const query of queries) {
        validateQuery(query, problems, seenQueryIds);
    }

    for (const label of labels.values()) {
        validateLabel(label, seenQueryIds, problems);
    }

    if (problems.length > 0) {
        throw new ValidationError(problems);
    }
}

/**
 * Resolves the grade for a URL against a label's source list.
 *
 * An exact URL grade wins over a domain grade. A `match` containing "/" is
 * treated as a URL prefix, tested against `canonicalizeUrl(url)`. A `match`
 * without "/" is a hostname match: `host === match` or a subdomain of it,
 * after stripping a leading `www.` from both sides. Returns null when
 * nothing matches.
 */
export function gradeFor(url: string, sources: SourceLabel[]): SourceGrade | null {
    const canonical = canonicalizeUrl(url);

    let host = "";
    try {
        host = new URL(canonical).hostname;
    } catch {
        host = "";
    }
    if (host.startsWith("www.")) host = host.slice("www.".length);

    let urlMatch: SourceGrade | null = null;
    let domainMatch: SourceGrade | null = null;

    for (const source of sources) {
        if (source.match.includes("/")) {
            if (urlMatch === null && canonical.startsWith(source.match)) {
                urlMatch = source.grade;
            }
        } else {
            let matchHost = source.match;
            if (matchHost.startsWith("www.")) matchHost = matchHost.slice("www.".length);
            if (domainMatch === null && (host === matchHost || host.endsWith(`.${matchHost}`))) {
                domainMatch = source.grade;
            }
        }
    }

    return urlMatch ?? domainMatch;
}
