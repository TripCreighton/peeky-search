import { describe, it, expect } from "vitest";
import { validate, gradeFor, warningsForLabel, ValidationError } from "../queryset";
import type { Nugget, Query, QueryLabel, SourceLabel } from "../types";

function createQuery(overrides: Partial<Query> = {}): Query {
    return {
        id: "q1",
        text: "how to use pnpm workspaces",
        category: "how-to",
        difficulty: 1,
        ...overrides,
    };
}

function createLabel(overrides: Partial<QueryLabel> = {}): QueryLabel {
    return {
        queryId: "q1",
        nuggets: [],
        sources: [],
        labeledAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

function createSource(overrides: Partial<SourceLabel> = {}): SourceLabel {
    return {
        match: "example.com",
        grade: "good",
        ...overrides,
    };
}

/** A valid nugget by default, including the required `window`. */
function createNugget(overrides: Partial<Nugget> = {}): Nugget {
    return {
        id: "n1",
        text: "a fact",
        anchors: [["x"]],
        window: 100,
        ...overrides,
    };
}

describe("validate", () => {
    it("passes for a well-formed query set and label set", () => {
        const queries = [createQuery()];
        const labels = new Map([
            [
                "q1",
                createLabel({
                    nuggets: [
                        createNugget({ id: "n1", anchors: [["pnpm"], ["workspace"]] }),
                    ],
                    sources: [createSource()],
                }),
            ],
        ]);

        expect(() => validate(queries, labels)).not.toThrow();
    });

    it("collects multiple problems in a single throw, not just the first", () => {
        // Two independent, unrelated problems: an invalid category on the
        // query, and an uppercase anchor term on the label.
        const queries = [createQuery({ category: "not-a-real-category" as never })];
        const labels = new Map([
            [
                "q1",
                createLabel({
                    nuggets: [createNugget({ id: "n1", anchors: [["PNPM"]] })],
                }),
            ],
        ]);

        let caught: ValidationError | undefined;
        try {
            validate(queries, labels);
        } catch (err) {
            caught = err as ValidationError;
        }

        expect(caught).toBeInstanceOf(ValidationError);
        expect(caught?.problems.length).toBeGreaterThanOrEqual(2);
        expect(caught?.message).toContain("category");
        expect(caught?.message).toContain("lowercase");
    });

    it("does not throw on the first problem found (all queries are checked)", () => {
        const queries = [
            createQuery({ id: "", text: "" }),
            createQuery({ id: "q2", difficulty: 9 as never }),
        ];

        let caught: ValidationError | undefined;
        try {
            validate(queries, new Map());
        } catch (err) {
            caught = err as ValidationError;
        }

        expect(caught).toBeInstanceOf(ValidationError);
        // id-missing, text-empty (both from q1) plus the bad difficulty on q2.
        expect(caught?.problems.length).toBeGreaterThanOrEqual(3);
    });

    it("rejects duplicate query ids", () => {
        const queries = [createQuery({ id: "dup" }), createQuery({ id: "dup" })];

        expect(() => validate(queries, new Map())).toThrowError(/duplicate id/);
    });

    it("rejects a label referencing an unknown queryId", () => {
        const queries = [createQuery({ id: "q1" })];
        const labels = new Map([["orphan", createLabel({ queryId: "orphan" })]]);

        expect(() => validate(queries, labels)).toThrowError(/does not reference a known query/);
    });

    it("rejects duplicate nugget ids within a label", () => {
        const queries = [createQuery()];
        const labels = new Map([
            [
                "q1",
                createLabel({
                    nuggets: [
                        createNugget({ id: "dup", anchors: [["a"]] }),
                        createNugget({ id: "dup", anchors: [["b"]] }),
                    ],
                }),
            ],
        ]);

        expect(() => validate(queries, labels)).toThrowError(/duplicate nugget id/);
    });

    it("rejects an uppercase anchor term loudly", () => {
        const queries = [createQuery()];
        const labels = new Map([
            [
                "q1",
                createLabel({
                    nuggets: [createNugget({ id: "n1", anchors: [["UpperCase"]] })],
                }),
            ],
        ]);

        expect(() => validate(queries, labels)).toThrowError(/lowercase/);
    });

    it("rejects an empty anchor group", () => {
        const queries = [createQuery()];
        const labels = new Map([
            [
                "q1",
                createLabel({
                    nuggets: [createNugget({ id: "n1", anchors: [[]] })],
                }),
            ],
        ]);

        expect(() => validate(queries, labels)).toThrowError(/anchor group/);
    });

    it("rejects empty anchors array on a nugget", () => {
        const queries = [createQuery()];
        const labels = new Map([
            [
                "q1",
                createLabel({
                    nuggets: [createNugget({ id: "n1", anchors: [] })],
                }),
            ],
        ]);

        expect(() => validate(queries, labels)).toThrowError(/anchors must be non-empty/);
    });

    it("rejects an uncompilable pattern regex", () => {
        const queries = [createQuery()];
        const labels = new Map([
            [
                "q1",
                createLabel({
                    nuggets: [
                        createNugget({ id: "n1", anchors: [["x"]], pattern: "(unclosed[" }),
                    ],
                }),
            ],
        ]);

        expect(() => validate(queries, labels)).toThrowError(/does not compile/);
    });

    it("rejects a nugget weight <= 0", () => {
        const queries = [createQuery()];
        const labels = new Map([
            [
                "q1",
                createLabel({
                    nuggets: [createNugget({ id: "n1", anchors: [["x"]], weight: 0 })],
                }),
            ],
        ]);

        expect(() => validate(queries, labels)).toThrowError(/weight must be > 0/);
    });

    it("rejects a negative nugget weight", () => {
        const queries = [createQuery()];
        const labels = new Map([
            [
                "q1",
                createLabel({
                    nuggets: [createNugget({ id: "n1", anchors: [["x"]], weight: -1 })],
                }),
            ],
        ]);

        expect(() => validate(queries, labels)).toThrowError(/weight must be > 0/);
    });

    it("rejects a nugget source that does not parse as a URL", () => {
        const queries = [createQuery()];
        const labels = new Map([
            [
                "q1",
                createLabel({
                    nuggets: [
                        createNugget({ id: "n1", anchors: [["x"]], sources: ["not a url"] }),
                    ],
                }),
            ],
        ]);

        expect(() => validate(queries, labels)).toThrowError(/not a valid URL/);
    });

    it("rejects an invalid SourceLabel grade", () => {
        const queries = [createQuery()];
        const labels = new Map([
            [
                "q1",
                createLabel({
                    sources: [{ match: "example.com", grade: "excellent" as never }],
                }),
            ],
        ]);

        expect(() => validate(queries, labels)).toThrowError(/invalid grade/);
    });

    it("rejects an empty SourceLabel match", () => {
        const queries = [createQuery()];
        const labels = new Map([
            [
                "q1",
                createLabel({
                    sources: [createSource({ match: "" })],
                }),
            ],
        ]);

        expect(() => validate(queries, labels)).toThrowError(/source match is empty/);
    });

    it("rejects an invalid difficulty", () => {
        const queries = [createQuery({ difficulty: 4 as never })];

        expect(() => validate(queries, new Map())).toThrowError(/invalid difficulty/);
    });

    it("rejects an invalid tranche", () => {
        const queries = [createQuery({ tranche: 3 as never })];

        expect(() => validate(queries, new Map())).toThrowError(/invalid tranche/);
    });

    it("accepts a query with no tranche field", () => {
        const queries = [createQuery()];

        expect(() => validate(queries, new Map())).not.toThrow();
    });

    describe("nugget window", () => {
        it("rejects a nugget with no window, naming the query id and nugget id", () => {
            const queries = [createQuery({ id: "q1" })];
            const nugget = { id: "n1", text: "a fact", anchors: [["x"]] } as Nugget;
            const labels = new Map([
                ["q1", createLabel({ queryId: "q1", nuggets: [nugget] })],
            ]);

            let caught: ValidationError | undefined;
            try {
                validate(queries, labels);
            } catch (err) {
                caught = err as ValidationError;
            }

            expect(caught).toBeInstanceOf(ValidationError);
            expect(caught?.message).toContain("window is required");
            expect(caught?.message).toContain("q1");
            expect(caught?.message).toContain("n1");
        });

        it("rejects a non-integer window", () => {
            const queries = [createQuery()];
            const labels = new Map([
                [
                    "q1",
                    createLabel({
                        nuggets: [createNugget({ id: "n1", anchors: [["x"]], window: 12.5 })],
                    }),
                ],
            ]);

            expect(() => validate(queries, labels)).toThrowError(/window must be a positive integer/);
        });

        it("rejects a zero window", () => {
            const queries = [createQuery()];
            const labels = new Map([
                [
                    "q1",
                    createLabel({
                        nuggets: [createNugget({ id: "n1", anchors: [["x"]], window: 0 })],
                    }),
                ],
            ]);

            expect(() => validate(queries, labels)).toThrowError(/window must be a positive integer/);
        });

        it("rejects a negative window", () => {
            const queries = [createQuery()];
            const labels = new Map([
                [
                    "q1",
                    createLabel({
                        nuggets: [createNugget({ id: "n1", anchors: [["x"]], window: -10 })],
                    }),
                ],
            ]);

            expect(() => validate(queries, labels)).toThrowError(/window must be a positive integer/);
        });

        it("accepts a positive integer window, including one above the recommended max", () => {
            const queries = [createQuery()];
            const labels = new Map([
                [
                    "q1",
                    createLabel({
                        nuggets: [createNugget({ id: "n1", anchors: [["x"]], window: 900 })],
                    }),
                ],
            ]);

            // 900 > the 600-char recommendation is a *warning* concern
            // (see warningsForLabel), not a validation failure.
            expect(() => validate(queries, labels)).not.toThrow();
        });
    });
});

describe("warningsForLabel", () => {
    it("warns, but does not throw or reject, when a nugget's window exceeds 600", () => {
        const label = createLabel({
            nuggets: [createNugget({ id: "n1", anchors: [["x"]], window: 900 })],
        });

        const warnings = warningsForLabel(label);

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("q1");
        expect(warnings[0]).toContain("n1");
        expect(warnings[0]).toContain("900");
    });

    it("does not warn when window is within the recommended max", () => {
        const label = createLabel({
            nuggets: [createNugget({ id: "n1", anchors: [["x"]], window: 600 })],
        });

        const warnings = warningsForLabel(label);

        expect(warnings).toHaveLength(0);
    });

    it("does not warn for a nugget with no window at all (that is validate's job)", () => {
        const nugget = { id: "n1", text: "a fact", anchors: [["x"]] } as Nugget;
        const label = createLabel({ nuggets: [nugget] });

        const warnings = warningsForLabel(label);

        expect(warnings).toHaveLength(0);
    });

    it("returns one warning per overlong nugget, and none for well-formed ones", () => {
        const label = createLabel({
            nuggets: [
                createNugget({ id: "ok", anchors: [["x"]], window: 100 }),
                createNugget({ id: "too-wide-1", anchors: [["y"]], window: 601 }),
                createNugget({ id: "too-wide-2", anchors: [["z"]], window: 5000 }),
            ],
        });

        const warnings = warningsForLabel(label);

        expect(warnings).toHaveLength(2);
        expect(warnings.some((w) => w.includes("too-wide-1"))).toBe(true);
        expect(warnings.some((w) => w.includes("too-wide-2"))).toBe(true);
        expect(warnings.some((w) => w.includes("\"ok\""))).toBe(false);
    });
});

describe("gradeFor", () => {
    it("returns null when nothing matches", () => {
        const sources = [createSource({ match: "example.com", grade: "good" })];

        const grade = gradeFor("https://other.com/page", sources);

        expect(grade).toBeNull();
    });

    it("an exact URL match beats a domain match", () => {
        const sources = [
            createSource({ match: "example.com", grade: "acceptable" }),
            createSource({ match: "https://example.com/docs/guide", grade: "canonical" }),
        ];

        const grade = gradeFor("https://example.com/docs/guide", sources);

        expect(grade).toBe("canonical");
    });

    it("an exact URL match beats a domain match regardless of array order", () => {
        const sources = [
            createSource({ match: "https://example.com/docs/guide", grade: "canonical" }),
            createSource({ match: "example.com", grade: "bad" }),
        ];

        const grade = gradeFor("https://example.com/docs/guide", sources);

        expect(grade).toBe("canonical");
    });

    it("falls back to a domain match when no URL match applies", () => {
        const sources = [createSource({ match: "example.com", grade: "good" })];

        const grade = gradeFor("https://example.com/some/other/page", sources);

        expect(grade).toBe("good");
    });

    it("strips a leading www. from the URL host before matching a domain", () => {
        const sources = [createSource({ match: "example.com", grade: "good" })];

        const grade = gradeFor("https://www.example.com/page", sources);

        expect(grade).toBe("good");
    });

    it("strips a leading www. from the match string too", () => {
        const sources = [createSource({ match: "www.example.com", grade: "good" })];

        const grade = gradeFor("https://example.com/page", sources);

        expect(grade).toBe("good");
    });

    it("matches a subdomain via endsWith(.domain)", () => {
        const sources = [createSource({ match: "example.com", grade: "acceptable" })];

        const grade = gradeFor("https://docs.example.com/page", sources);

        expect(grade).toBe("acceptable");
    });

    it("does not match an unrelated domain that merely contains the string", () => {
        const sources = [createSource({ match: "example.com", grade: "good" })];

        const grade = gradeFor("https://notexample.com/page", sources);

        expect(grade).toBeNull();
    });

    it("a URL prefix match matches any deeper path under it", () => {
        const sources = [
            createSource({ match: "https://example.com/docs/", grade: "canonical" }),
        ];

        const grade = gradeFor("https://example.com/docs/guide/deep/page", sources);

        expect(grade).toBe("canonical");
    });
});
