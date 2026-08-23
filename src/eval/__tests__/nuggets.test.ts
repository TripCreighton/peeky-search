import { describe, it, expect } from "vitest";
import {
    normalizeForMatch,
    matchNuggetInExcerpt,
    matchNuggetInPages,
    matchNuggets,
} from "../nuggets";
import type { Nugget, RunExcerpt, RunPage } from "../types";

function createExcerpt(text: string, overrides: Partial<RunExcerpt> = {}): RunExcerpt {
    return {
        text,
        headingPath: [],
        score: 1,
        ...overrides,
    };
}

function createPage(url: string, excerpts: RunExcerpt[], overrides: Partial<RunPage> = {}): RunPage {
    return {
        url,
        title: url,
        rank: 1,
        excerpts,
        charCount: excerpts.reduce((sum, e) => sum + e.text.length, 0),
        ...overrides,
    };
}

function createNugget(overrides: Partial<Nugget> = {}): Nugget {
    return {
        id: "n1",
        text: "test nugget",
        anchors: [],
        ...overrides,
    };
}

describe("normalizeForMatch", () => {
    it("lowercases text", () => {
        const text = "React USEEFFECT Cleanup";

        const result = normalizeForMatch(text);

        expect(result).toBe("react useeffect cleanup");
    });

    it("collapses whitespace runs, including newlines and tabs, to a single space", () => {
        const text = "line one\n\n  line\ttwo\r\n   line   three";

        const result = normalizeForMatch(text);

        expect(result).toBe("line one line two line three");
    });

    it("trims leading and trailing whitespace", () => {
        const text = "  \n  padded text  \t ";

        const result = normalizeForMatch(text);

        expect(result).toBe("padded text");
    });

    it("preserves punctuation used inside anchors", () => {
        const text = "Run ERR_PNPM_OUTDATED_LOCKFILE with --frozen-lockfile=false (see docs).";

        const result = normalizeForMatch(text);

        expect(result).toBe("run err_pnpm_outdated_lockfile with --frozen-lockfile=false (see docs).");
    });
});

describe("matchNuggetInExcerpt - anchor groups", () => {
    it("does not match when one anchor group is missing entirely", () => {
        const nugget = createNugget({
            anchors: [["react"], ["useeffect"], ["cleanup"]],
        });
        const excerpt = "React's useEffect hook runs after every render.";

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(false);
    });

    it("matches when every anchor group is satisfied", () => {
        const nugget = createNugget({
            anchors: [["react"], ["useeffect"], ["cleanup"]],
        });
        const excerpt = "React's useEffect hook supports an optional cleanup function.";

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(true);
    });

    it("matches when any single term within a group is present, not all of them", () => {
        const nugget = createNugget({
            anchors: [["npm", "pnpm", "yarn"]],
        });
        const excerpt = "Install the package with pnpm add.";

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(true);
    });

    it("fails a group when none of its terms are present", () => {
        const nugget = createNugget({
            anchors: [["npm", "pnpm", "yarn"]],
        });
        const excerpt = "Install the package with bun add.";

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(false);
    });

    it("matches stem-prefix anchor 'dependenc' against 'dependency'", () => {
        const nugget = createNugget({
            anchors: [["dependenc"]],
        });
        const excerpt = "This package has a single peer dependency.";

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(true);
    });

    it("matches stem-prefix anchor 'dependenc' against 'dependencies'", () => {
        const nugget = createNugget({
            anchors: [["dependenc"]],
        });
        const excerpt = "Lockfiles pin the exact versions of your dependencies.";

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(true);
    });

    it("is case and whitespace insensitive across groups", () => {
        const nugget = createNugget({
            anchors: [["react"], ["useeffect"]],
        });
        const excerpt = "  REACT\n\tprovides\r\nthe   USEEFFECT   hook.  ";

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(true);
    });

    it("does not match when anchors is an empty array", () => {
        const nugget = createNugget({ anchors: [] });
        const excerpt = "This text contains absolutely anything at all.";

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(false);
    });
});

describe("matchNuggetInExcerpt - pattern", () => {
    it("does not match when anchors are satisfied but pattern is not", () => {
        const nugget = createNugget({
            anchors: [["pnpm"], ["lockfile"]],
            pattern: "err_pnpm_outdated_lockfile",
        });
        const excerpt = "pnpm reports a generic lockfile mismatch error during install.";

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(false);
    });

    it("matches when both anchors and pattern are satisfied", () => {
        const nugget = createNugget({
            anchors: [["pnpm"], ["lockfile"]],
            pattern: "err_pnpm_outdated_lockfile",
        });
        const excerpt = "pnpm install fails with ERR_PNPM_OUTDATED_LOCKFILE when the lockfile is stale.";

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(true);
    });

    it("matches pattern case-insensitively", () => {
        const nugget = createNugget({
            anchors: [["flag"]],
            pattern: "--no-frozen-lockfile",
        });
        const excerpt = "Pass the flag --NO-FROZEN-LOCKFILE to skip the lockfile check.";

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(true);
    });

    it("throws a clear error naming the nugget id for an invalid pattern regex", () => {
        const nugget = createNugget({
            id: "broken-pattern-nugget",
            anchors: [["flag"]],
            pattern: "(unclosed[",
        });
        const excerpt = "Pass the flag to skip the check.";

        expect(() => matchNuggetInExcerpt(nugget, excerpt)).toThrow(/broken-pattern-nugget/);
    });
});

describe("matchNuggetInExcerpt - window", () => {
    it("rejects anchors scattered beyond the window limit", () => {
        const nugget = createNugget({
            anchors: [["alpha"], ["beta"]],
            window: 20,
        });
        const excerpt = `alpha ${"y".repeat(100)} beta`;

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(false);
    });

    it("accepts anchors within the window limit", () => {
        const nugget = createNugget({
            anchors: [["alpha"], ["beta"]],
            window: 20,
        });
        const excerpt = "the alpha and beta values are set together";

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(true);
    });

    it("matches with no window restriction regardless of distance", () => {
        const nugget = createNugget({
            anchors: [["alpha"], ["beta"]],
        });
        const excerpt = `alpha ${"y".repeat(100)} beta`;

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(true);
    });

    it("picks the smallest span when a term repeats, not the first occurrence", () => {
        // Layout (0-indexed): "alpha" at 0; padding of 50 "x"s at 6-55;
        // " beta alpha beta" starting at 56 puts "beta" at 57, "alpha" at 62,
        // "beta" at 68. The naive first-occurrence pairing (alpha@0, beta@57)
        // spans 61 chars; the tight cluster near the end spans only 10.
        const nugget = createNugget({
            anchors: [["alpha"], ["beta"]],
        });
        const excerpt = `alpha ${"x".repeat(50)} beta alpha beta`;

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(true);
        expect(result.span).toBe(10);
    });

    it("rejects the repeated-term case when window is smaller than the minimal span", () => {
        const nugget = createNugget({
            anchors: [["alpha"], ["beta"]],
            window: 9,
        });
        const excerpt = `alpha ${"x".repeat(50)} beta alpha beta`;

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(false);
    });

    it("accepts the repeated-term case when window matches the minimal span", () => {
        const nugget = createNugget({
            anchors: [["alpha"], ["beta"]],
            window: 10,
        });
        const excerpt = `alpha ${"x".repeat(50)} beta alpha beta`;

        const result = matchNuggetInExcerpt(nugget, excerpt);

        expect(result.matched).toBe(true);
        expect(result.span).toBe(10);
    });
});

describe("matchNuggetInExcerpt - anti-false-positive (realistic filler prose)", () => {
    it("does not match marketing homepage copy where terms appear in unrelated sentences", () => {
        const nugget = createNugget({
            anchors: [["cache"], ["invalidate"]],
            window: 50,
        });
        const filler = `
            Our platform helps modern teams ship faster than ever before. Founded by a group of
            passionate engineers, we believe that great developer tools should feel invisible.
            Thousands of companies trust us to power their critical infrastructure every single
            day. From fast-growing startups to Fortune 500 enterprises, our customers rave about
            the reliability and speed of our platform. Every request passes through an
            intelligent cache layer that keeps your application snappy even under heavy load.
            Sign up today and see why teams of all sizes choose us to power their next big idea.
            Ready to get started? Our onboarding wizard will have you up and running in minutes,
            and if you ever need to invalidate old data, our dashboard makes that a single click
            away.
        `;

        const result = matchNuggetInExcerpt(nugget, filler);

        expect(result.matched).toBe(false);
    });

    it("does not match release-notes boilerplate where terms appear in unrelated sentences", () => {
        const nugget = createNugget({
            anchors: [["breaking"], ["migration"]],
            window: 40,
        });
        const filler = `
            We're thrilled to announce our biggest release yet, packed with new features,
            performance wins, and long-requested improvements from our community. This quarter,
            our team shipped over two hundred pull requests across the entire platform, spanning
            the dashboard, the CLI, and our public API. As always, our top priority is stability,
            and this release went through weeks of rigorous internal testing before reaching
            general availability. If you run into any breaking issues after upgrading, please
            reach out to support and our team will help however we can, and remember that a full
            step by step migration is documented separately on our blog.
        `;

        const result = matchNuggetInExcerpt(nugget, filler);

        expect(result.matched).toBe(false);
    });

    it("does not match tutorial boilerplate where terms appear in unrelated sentences", () => {
        const nugget = createNugget({
            anchors: [["environment variable"], ["restart"]],
            window: 60,
        });
        const filler = `
            Getting your local development environment set up correctly is the first step
            toward a smooth workflow. Configuration for this project is driven primarily through
            a handful of environment variable definitions that live in a local file you create
            yourself and never commit to version control. After everything looks good, open a
            terminal, run the development server, and watch the logs to confirm everything
            booted cleanly. When you are done experimenting and want to pick up fresh tomorrow,
            you can simply restart your machine and everything will still be exactly where you
            left it.
        `;

        const result = matchNuggetInExcerpt(nugget, filler);

        expect(result.matched).toBe(false);
    });
});

describe("matchNuggetInPages", () => {
    it("returns no match when no page or excerpt satisfies the nugget", () => {
        const nugget = createNugget({ anchors: [["cleanup"]] });
        const pages = [
            createPage("https://a.example", [createExcerpt("Nothing relevant here.")]),
            createPage("https://b.example", [createExcerpt("Also nothing relevant.")]),
        ];

        const result = matchNuggetInPages(nugget, pages);

        expect(result).toEqual({ nuggetId: "n1", matched: false });
    });

    it("finds a match on a single page and records pageUrl and excerptIndex", () => {
        const nugget = createNugget({ anchors: [["cleanup", "teardown"]] });
        const pages = [
            createPage("https://a.example", [
                createExcerpt("An unrelated first excerpt."),
                createExcerpt("useEffect supports a cleanup function returned from the callback."),
            ]),
        ];

        const result = matchNuggetInPages(nugget, pages);

        expect(result.matched).toBe(true);
        expect(result.pageUrl).toBe("https://a.example");
        expect(result.excerptIndex).toBe(1);
    });

    it("prefers an earlier page over a later page when both match", () => {
        const nugget = createNugget({ anchors: [["cleanup"]] });
        const pages = [
            createPage("https://first.example", [
                createExcerpt("Unrelated."),
                createExcerpt("The cleanup function runs on unmount."),
            ]),
            createPage("https://second.example", [
                createExcerpt("The cleanup function also appears here."),
            ]),
        ];

        const result = matchNuggetInPages(nugget, pages);

        expect(result.pageUrl).toBe("https://first.example");
        expect(result.excerptIndex).toBe(1);
    });

    it("prefers an earlier excerpt within the same page when both match", () => {
        const nugget = createNugget({ anchors: [["cleanup"]] });
        const pages = [
            createPage("https://only.example", [
                createExcerpt("The cleanup function runs first here."),
                createExcerpt("The cleanup function also appears in this later excerpt."),
            ]),
        ];

        const result = matchNuggetInPages(nugget, pages);

        expect(result.excerptIndex).toBe(0);
    });

    it("is deterministic across repeated calls with the same input", () => {
        const nugget = createNugget({
            anchors: [["react"], ["cleanup"]],
            window: 80,
        });
        const pages = [
            createPage("https://a.example", [createExcerpt("Unrelated text about something else.")]),
            createPage("https://b.example", [
                createExcerpt("React's useEffect hook supports an optional cleanup function."),
            ]),
        ];

        const first = matchNuggetInPages(nugget, pages);
        const second = matchNuggetInPages(nugget, pages);
        const third = matchNuggetInPages(nugget, pages);

        expect(second).toEqual(first);
        expect(third).toEqual(first);
    });
});

describe("matchNuggets", () => {
    it("matches an array of nuggets against the same pages, preserving order", () => {
        const nuggets = [
            createNugget({ id: "found", anchors: [["cleanup"]] }),
            createNugget({ id: "missing", anchors: [["nonexistent-term"]] }),
        ];
        const pages = [
            createPage("https://a.example", [
                createExcerpt("useEffect supports an optional cleanup function."),
            ]),
        ];

        const results = matchNuggets(nuggets, pages);

        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({ nuggetId: "found", matched: true });
        expect(results[1]).toMatchObject({ nuggetId: "missing", matched: false });
    });

    it("is deterministic across repeated calls with the same input", () => {
        const nuggets = [
            createNugget({ id: "a", anchors: [["react"]] }),
            createNugget({ id: "b", anchors: [["cleanup"]], window: 30 }),
        ];
        const pages = [
            createPage("https://a.example", [
                createExcerpt("React's useEffect hook supports an optional cleanup function."),
            ]),
            createPage("https://b.example", [createExcerpt("Cleanup happens on unmount.")]),
        ];

        const first = matchNuggets(nuggets, pages);
        const second = matchNuggets(nuggets, pages);

        expect(second).toEqual(first);
    });

    it("returns an empty array for an empty nugget list", () => {
        const pages = [createPage("https://a.example", [createExcerpt("Some content.")])];

        const results = matchNuggets([], pages);

        expect(results).toEqual([]);
    });
});
