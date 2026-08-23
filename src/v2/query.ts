/**
 * Query understanding for v2.
 *
 * v1's `src/mcp/query-parser.ts` only separates search-engine operators from
 * extraction text — it has no idea an error code, a code symbol, or a
 * version number is sitting in the query, so nothing downstream can treat
 * them specially. `parseQuery` supersedes it: `operators` preserves the same
 * site:/-exclude/filetype:/OR/AND semantics (so v1's dork syntax keeps
 * working), while `errorStrings`, `symbols`, and `versions` pull out the
 * high-signal anchors a plain BM25 term list would flatten into ordinary
 * words.
 */

import { tokenize } from "../preprocessing/tokenize";
import type { ParsedQuery } from "./types";

function uniquePreserveOrder(items: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of items) {
        if (!seen.has(item)) {
            seen.add(item);
            out.push(item);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Operators — mirrors src/mcp/query-parser.ts's parseSearchOperators exactly,
// step order included, so extraction text stays byte-for-byte equivalent.
// ---------------------------------------------------------------------------

const OR_AND_BETWEEN_SITES_RE = /\bsite:[\w.-]+\s+(OR|AND)\s+(?=site:)/gi;
const SITE_OP_RE = /\bsite:[\w.-]+/gi;
const EXCLUDE_CAPTURE_RE = /(?:^|\s)(-\w+)/g;
const EXCLUDE_STRIP_RE = /(^|\s)-\w+/g;
const FILETYPE_OP_RE = /\bfiletype:\w+/gi;
const QUOTE_RE = /"([^"]+)"/g;

interface OperatorExtraction {
    operators: string[];
    /** Query text with all operator syntax removed and quotes unwrapped — same shape as v1's `extractionQuery`. */
    cleaned: string;
}

function extractOperatorsAndClean(raw: string): OperatorExtraction {
    const operators: string[] = [];
    let working = raw;

    // Must run before the generic site: strip below (matches v1's order).
    for (const m of working.matchAll(OR_AND_BETWEEN_SITES_RE)) {
        if (m[1] !== undefined) operators.push(m[1]);
    }
    working = working.replace(OR_AND_BETWEEN_SITES_RE, "");

    for (const m of working.matchAll(SITE_OP_RE)) operators.push(m[0]);
    working = working.replace(SITE_OP_RE, "");

    for (const m of working.matchAll(EXCLUDE_CAPTURE_RE)) {
        if (m[1] !== undefined) operators.push(m[1]);
    }
    working = working.replace(EXCLUDE_STRIP_RE, " ");

    for (const m of working.matchAll(FILETYPE_OP_RE)) operators.push(m[0]);
    working = working.replace(FILETYPE_OP_RE, "");

    working = working.replace(QUOTE_RE, "$1");
    working = working.replace(/\s+/g, " ").trim();

    return { operators, cleaned: working };
}

// ---------------------------------------------------------------------------
// Phrases
// ---------------------------------------------------------------------------

function extractPhrases(raw: string): string[] {
    const phrases: string[] = [];
    for (const m of raw.matchAll(QUOTE_RE)) {
        if (m[1] !== undefined) phrases.push(m[1]);
    }
    return phrases;
}

// ---------------------------------------------------------------------------
// Error strings — high-signal anchors that should dominate ranking. Several
// independent shapes, all narrow enough to avoid swallowing ordinary
// technical acronyms (CSS, JSON, HTTP, JVM, ...) that show up constantly in
// non-debugging categories.
// ---------------------------------------------------------------------------

/** "fatal: ...", "panic: ...", "Error: ..." prefix through end of string. */
const ERROR_LABEL_RE = /\b(?:fatal|panic|error)\s*:\s*.{1,150}/gi;
/** SCREAMING_SNAKE_CASE codes: ERR_PNPM_OUTDATED_LOCKFILE. Requires at least one underscore. */
const SCREAMING_SNAKE_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
/** Node.js errno-style codes: ERESOLVE, ENOENT, ECONNREFUSED. */
const NODE_ERRNO_RE = /\bE[A-Z]{3,}\b/g;
/** TypeScript diagnostic codes: TS2589, TS2345. */
const TS_CODE_RE = /\bTS\d{3,5}\b/g;
/** Single-letter + digits compiler/error codes: E501, C2065. */
const COMPILER_CODE_RE = /\b[A-Z]\d{3,5}\b/g;
/** "exit 137", "exit code 137". */
const EXIT_CODE_RE = /\bexit(?:\s+code)?\s+\d+\b/gi;
/** HTTP status phrasings: "HTTP 403", "404 Not Found". */
const HTTP_STATUS_RE =
    /\bHTTP\/?\d?\.?\d?\s*[1-5]\d{2}\b|\b[1-5]\d{2}\s+(?:forbidden|unauthorized|not found|bad request|internal server error)\b/gi;
/** A quoted phrase that reads like an error message rather than an ordinary phrase. */
const ERRORISH_PHRASE_RE = /\b(?:error|exception|fatal|panic|cannot|failed|denied|refused)\b/i;

const ERROR_STRING_PATTERNS = [
    ERROR_LABEL_RE,
    SCREAMING_SNAKE_RE,
    NODE_ERRNO_RE,
    TS_CODE_RE,
    COMPILER_CODE_RE,
    EXIT_CODE_RE,
    HTTP_STATUS_RE,
];

function extractErrorStrings(raw: string, phrases: string[]): string[] {
    const found: string[] = [];

    for (const pattern of ERROR_STRING_PATTERNS) {
        for (const m of raw.matchAll(pattern)) {
            found.push(m[0].trim());
        }
    }

    for (const phrase of phrases) {
        if (ERRORISH_PHRASE_RE.test(phrase)) found.push(phrase);
    }

    return uniquePreserveOrder(found);
}

// ---------------------------------------------------------------------------
// Symbols — code identifiers.
// ---------------------------------------------------------------------------

/** camelCase: useEffect, withFileTypes. */
const CAMEL_CASE_RE = /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g;
/** PascalCase: AbortSignal, CrashLoopBackOff. Requires 2+ humps to avoid matching plain capitalized words. */
const PASCAL_CASE_RE = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g;
/** snake_case: spawn_blocking, map_or_else, jsonb_set. */
const SNAKE_CASE_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
/** ::-scoped paths: std::vec::Vec. */
const SCOPE_PATH_RE = /\b[A-Za-z_]\w*(?:::[A-Za-z_]\w*)+\b/g;
/** foo() call shapes. */
const CALL_SHAPE_RE = /\b[A-Za-z_]\w*\(\)/g;
/** Dotted paths: context.Err, Intl.NumberFormat, fs.promises.readdir. */
const DOTTED_PATH_RE = /\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b/g;

const SYMBOL_PATTERNS = [CAMEL_CASE_RE, PASCAL_CASE_RE, SNAKE_CASE_RE, SCOPE_PATH_RE, CALL_SHAPE_RE, DOTTED_PATH_RE];

function extractSymbols(raw: string): string[] {
    const found: string[] = [];
    for (const pattern of SYMBOL_PATTERNS) {
        for (const m of raw.matchAll(pattern)) {
            found.push(m[0]);
        }
    }
    return uniquePreserveOrder(found);
}

// ---------------------------------------------------------------------------
// Versions — normalized to bare digits (no "v" prefix): "v4" -> "4".
// ---------------------------------------------------------------------------

const V_PREFIX_RE = /\bv(\d+(?:\.\d+)*)\b/gi;
const DOTTED_VERSION_RE = /\b(\d+\.\d+(?:\.\d+)?)\b/g;
const EDITION_YEAR_RE = /\b(\d{4})\s+edition\b/gi;
// A modest, curated set of ecosystem names that commonly appear directly
// before a bare version number in these queries ("next 15", "eslint 9").
const PRODUCT_VERSION_RE =
    /\b(?:python|node|react|next(?:\.js)?|vue|angular|go|rust|java|php|ruby|postgres|postgresql|mysql|redis|docker|kubernetes|k8s|eslint|webpack|vite|express|dotnet|jdk|npm|pnpm|yarn|jest|vitest|tailwind|typescript|ts)\s+v?(\d+(?:\.\d+)*)\b/gi;

function extractVersions(raw: string): string[] {
    const found: string[] = [];
    for (const m of raw.matchAll(V_PREFIX_RE)) {
        if (m[1] !== undefined) found.push(m[1]);
    }
    for (const m of raw.matchAll(DOTTED_VERSION_RE)) {
        if (m[1] !== undefined) found.push(m[1]);
    }
    for (const m of raw.matchAll(EDITION_YEAR_RE)) {
        if (m[1] !== undefined) found.push(m[1]);
    }
    for (const m of raw.matchAll(PRODUCT_VERSION_RE)) {
        if (m[1] !== undefined) found.push(m[1]);
    }
    return uniquePreserveOrder(found);
}

// ---------------------------------------------------------------------------

/**
 * Parse a raw query into its structural parts. A term may legitimately
 * appear in more than one field (e.g. `map_or_else` is both a `symbols`
 * entry and, after stemming, part of `terms`) — that overlap is intended,
 * not a bug: different scoring components read different fields.
 */
export function parseQuery(raw: string): ParsedQuery {
    const phrases = uniquePreserveOrder(extractPhrases(raw));
    const { operators, cleaned } = extractOperatorsAndClean(raw);
    const errorStrings = extractErrorStrings(raw, phrases);
    const symbols = extractSymbols(raw);
    const versions = extractVersions(raw);
    const terms = tokenize(cleaned);

    return {
        raw,
        terms,
        phrases,
        errorStrings,
        symbols,
        versions,
        operators: uniquePreserveOrder(operators),
    };
}
