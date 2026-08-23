import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseQuery } from "../query";
import { parseSearchOperators } from "../../mcp/query-parser";
import { tokenize } from "../../preprocessing/tokenize";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface QuerysetEntry {
    id: string;
    text: string;
    category: string;
    difficulty: number;
    tranche: number;
    note?: string;
}

function loadQueryset(): QuerysetEntry[] {
    const path = join(__dirname, "..", "..", "..", "eval", "queries", "queryset.json");
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { queries: QuerysetEntry[] };
    return parsed.queries;
}

describe("parseQuery", () => {
    const queryset = loadQueryset();

    it("loads a non-trivial queryset for table-driven checks", () => {
        expect(queryset.length).toBeGreaterThan(50);
    });

    it("produces every ParsedQuery field for every query in the set without throwing", () => {
        for (const entry of queryset) {
            const result = parseQuery(entry.text);

            expect(result.raw).toBe(entry.text);
            expect(Array.isArray(result.terms)).toBe(true);
            expect(Array.isArray(result.phrases)).toBe(true);
            expect(Array.isArray(result.errorStrings)).toBe(true);
            expect(Array.isArray(result.symbols)).toBe(true);
            expect(Array.isArray(result.versions)).toBe(true);
            expect(Array.isArray(result.operators)).toBe(true);
        }
    });

    it("yields the error string for debug-pnpm-outdated-lockfile", () => {
        const entry = queryset.find((q) => q.id === "debug-pnpm-outdated-lockfile");
        expect(entry).toBeDefined();

        const result = parseQuery(entry?.text ?? "");

        expect(result.errorStrings).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
    });

    it("yields map_or_else as a symbol for api-docs-rust-option-map-or-else", () => {
        const entry = queryset.find((q) => q.id === "api-docs-rust-option-map-or-else");
        expect(entry).toBeDefined();

        const result = parseQuery(entry?.text ?? "");

        expect(result.symbols).toContain("map_or_else");
    });

    it("yields version 4 for version-tailwind-v4-css-first", () => {
        const entry = queryset.find((q) => q.id === "version-tailwind-v4-css-first");
        expect(entry).toBeDefined();

        const result = parseQuery(entry?.text ?? "");

        expect(result.versions).toContain("4");
    });

    it("catches other common error shapes across the debugging category", () => {
        const cases: Record<string, string> = {
            "debug-node-err-require-esm": "ERR_REQUIRE_ESM",
            "debug-k8s-crashloopbackoff-exit-137": "exit code 137",
            "debug-npm-eresolve-peer-dep": "ERESOLVE",
            "debug-typescript-ts2589-excessively-deep": "TS2589",
            "debug-postgres-too-many-clients": "FATAL",
            "debug-git-refusing-unrelated-histories": "fatal",
        };

        for (const [id, expectedSubstring] of Object.entries(cases)) {
            const entry = queryset.find((q) => q.id === id);
            expect(entry, `missing queryset entry ${id}`).toBeDefined();

            const result = parseQuery(entry?.text ?? "");
            const joined = result.errorStrings.join(" | ");

            expect(joined.toUpperCase()).toContain(expectedSubstring.toUpperCase());
        }
    });

    it("extracts additional symbols across the api-docs category", () => {
        const cases: Record<string, string> = {
            "api-docs-react-useeffect-cleanup": "useEffect",
            "api-docs-go-context-withtimeout": "context.WithTimeout",
            "api-docs-node-readdir-withfiletypes": "withFileTypes",
            "api-docs-serde-rename-all-camelcase": "rename_all",
            "api-docs-tokio-spawn-blocking": "spawn_blocking",
        };

        for (const [id, expectedSymbol] of Object.entries(cases)) {
            const entry = queryset.find((q) => q.id === id);
            expect(entry, `missing queryset entry ${id}`).toBeDefined();

            const result = parseQuery(entry?.text ?? "");

            expect(result.symbols).toContain(expectedSymbol);
        }
    });

    it("extracts additional versions across the version-specific category", () => {
        const cases: Record<string, string> = {
            "version-react-19-forwardref-deprecated": "19",
            "version-eslint-9-flat-config-required": "9",
            "version-postgres-15-public-schema-permissions": "15",
            "version-go-122-loop-variable-scope": "1.22",
            "version-rust-2021-edition-changes": "2021",
        };

        for (const [id, expectedVersion] of Object.entries(cases)) {
            const entry = queryset.find((q) => q.id === id);
            expect(entry, `missing queryset entry ${id}`).toBeDefined();

            const result = parseQuery(entry?.text ?? "");

            expect(result.versions).toContain(expectedVersion);
        }
    });

    it("a term may appear in more than one field (symbols and terms overlap)", () => {
        const result = parseQuery("rust Option map_or_else signature closure arguments");

        expect(result.symbols).toContain("map_or_else");
        // tokenize splits/stems snake_case pieces into the term list too.
        expect(result.terms.some((t) => t.includes("map") || t.includes("els"))).toBe(true);
    });

    describe("operator parity with src/mcp/query-parser.ts", () => {
        // Every case from src/mcp/__tests__/query-parser.test.ts. Equivalence
        // is checked by comparing tokenized terms: v1's extractionQuery (with
        // operators/quotes stripped) tokenized the same way as v2's terms
        // field should match.
        const cases: Array<{ name: string; query: string }> = [
            { name: "site: operator", query: "react hooks site:reactjs.org" },
            { name: "site: with subdomain", query: "typescript site:docs.microsoft.com" },
            { name: "-excluded terms", query: "react tutorial -beginner -video" },
            { name: "-exclude at start", query: "-exclude react hooks" },
            { name: "filetype: operator", query: "javascript tutorial filetype:pdf" },
            { name: "quoted phrase", query: '"react hooks" tutorial' },
            { name: "multiple quoted phrases", query: '"react hooks" "state management"' },
            { name: "all operators together", query: '"exact phrase" site:example.com -exclude filetype:html' },
            { name: "only operators remain", query: "site:example.com -term filetype:pdf" },
            { name: "extra whitespace", query: "react   hooks    tutorial" },
            { name: "empty query", query: "" },
            { name: "case preserved", query: "React Hooks Tutorial" },
            { name: "site: without TLD", query: "test site:localhost" },
            { name: "hyphenated domain", query: "test site:my-example.co.uk" },
            { name: "OR between site:", query: "site:github.com OR site:stackoverflow.com react hooks" },
            { name: "AND between site:", query: "site:github.com AND site:stackoverflow.com typescript" },
            { name: "multiple OR between site:", query: "site:github.com OR site:stackoverflow.com OR site:reddit.com query" },
            { name: "OR preserved in regular text", query: "invalid OR operation error" },
            { name: "OR preserved inside quotes", query: '"invalid OR clause" site:github.com' },
        ];

        for (const { name, query } of cases) {
            it(`matches v1 extraction for: ${name}`, () => {
                const v1 = parseSearchOperators(query);
                const v1Terms = tokenize(v1.extractionQuery);

                const v2 = parseQuery(query);

                expect(v2.terms).toEqual(v1Terms);
            });
        }
    });

    describe("individual field extraction", () => {
        it("extracts a quoted phrase", () => {
            const result = parseQuery('"react hooks" tutorial');

            expect(result.phrases).toEqual(["react hooks"]);
        });

        it("extracts operators matching v1 semantics", () => {
            const result = parseQuery("react tutorial -beginner site:reactjs.org filetype:pdf");

            expect(result.operators).toContain("-beginner");
            expect(result.operators).toContain("site:reactjs.org");
            expect(result.operators).toContain("filetype:pdf");
        });

        it("extracts HTTP status phrasing error strings", () => {
            const result = parseQuery("getting HTTP 403 forbidden from the API");

            expect(result.errorStrings.some((s) => s.includes("403"))).toBe(true);
        });

        it("extracts a foo() call-shape symbol", () => {
            const result = parseQuery("what does useMemo() actually memoize");

            expect(result.symbols).toContain("useMemo()");
        });

        it("extracts a ::-scoped path symbol", () => {
            const result = parseQuery("rust std::sync::Arc clone semantics");

            expect(result.symbols).toContain("std::sync::Arc");
        });

        it("normalizes a v-prefixed version to bare digits", () => {
            const result = parseQuery("upgrade to node v20");

            expect(result.versions).toContain("20");
        });
    });
});
