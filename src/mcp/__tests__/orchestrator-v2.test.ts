/**
 * Coverage for the module that actually ships.
 *
 * CLAUDE.md has flagged `orchestrator-v2.ts` as the highest-value gap in the
 * suite for a while, and the reason it stayed a gap is that the module was one
 * long function returning a string: to test the rendering you had to run a
 * search. Splitting `runSearchV2` off from the two formatters fixes that, and
 * everything below is a pure function over a fixed `V2Result` — no network, no
 * SearXNG, no fetching.
 */

import { describe, it, expect } from "vitest";
import { parseQuery } from "../../v2/query";
import { formatForMcp, formatSurvey } from "../orchestrator-v2";
import type { V2Excerpt, V2Page, V2Result } from "../../v2/pipeline";
import type { Authority } from "../../v2/types";

function excerpt(text: string, headingPath: string[] = []): V2Excerpt {
    return { text, headingPath, score: 1, charCount: text.length, passageIds: ["p1"] };
}

function authority(score: number, canonical = false, reasons: string[] = []): Authority {
    return { score, canonical, reasons };
}

function page(overrides: Partial<V2Page> = {}): V2Page {
    return {
        url: "https://example.com/docs/guide",
        title: "A Guide",
        kind: "guide",
        source: "html",
        authority: authority(0.62),
        excerpts: [excerpt("Some body text about the thing.")],
        charCount: 31,
        rank: 1,
        ...overrides,
    };
}

function result(pages: V2Page[]): V2Result {
    return {
        query: parseQuery("a query"),
        pages,
        totalChars: pages.reduce((sum, p) => sum + p.charCount, 0),
        diagnostics: {
            consideredUrls: [],
            unavailableUrls: [],
            excludedUrls: [],
            docsFetched: pages.length,
            passagesBuilt: pages.length,
            passagesSelected: pages.length,
            kindByUrl: {},
        },
    };
}

describe("formatForMcp", () => {
    it("leads each page with a linked title and prints ancestor headings only", () => {
        const out = formatForMcp(
            "q",
            result([page({ excerpts: [excerpt("Cleanup\nReturn a function.", ["API", "useEffect", "Cleanup"])] })]),
            0
        );

        expect(out).toContain("## [A Guide](https://example.com/docs/guide)");
        // The excerpt text already opens with its own heading; only the
        // ancestors say where in the document it sits.
        expect(out).toContain("> API > useEffect");
        expect(out).not.toContain("> API > useEffect > Cleanup");
    });

    it("prefers finalUrl when the fetch followed a redirect", () => {
        const out = formatForMcp("q", result([page({ finalUrl: "https://example.com/docs/guide/v2" })]), 0);

        expect(out).toContain("(https://example.com/docs/guide/v2)");
    });

    it("reports how many pages the session filter skipped", () => {
        expect(formatForMcp("q", result([page()]), 3)).toContain("(3 already fetched this session, skipped)");
        expect(formatForMcp("q", result([page()]), 0)).not.toContain("already fetched");
    });

    it("explains an empty result rather than returning nothing", () => {
        const out = formatForMcp("react hooks", result([]), 0);

        expect(out).toContain('No usable content found for: "react hooks"');
        expect(out).toContain("failed to fetch");
    });
});

describe("formatSurvey", () => {
    const surveyed = result([
        page({
            rank: 1,
            url: "https://timerlib.example/reference/use-timer",
            title: "useTimer",
            kind: "reference",
            source: "markdown",
            authority: authority(0.91, true, ["+0.30 declared homepage", "+0.15 project docs"]),
            excerpts: [excerpt("Reference\nuseTimer schedules a callback and clears it on unmount.", ["Reference"])],
        }),
        page({
            rank: 2,
            url: "https://qa.example/questions/1",
            title: "Why does my timer fire twice?",
            kind: "qa",
            source: "stackexchange",
            authority: authority(0.54),
        }),
    ]);

    it("lists provenance per source", () => {
        const out = formatSurvey("timer cleanup", surveyed, 0, false);

        expect(out).toContain("1. useTimer");
        expect(out).toContain("https://timerlib.example/reference/use-timer");
        expect(out).toContain("reference · via markdown · authority 0.91 · CANONICAL");
        expect(out).toContain("2. Why does my timer fire twice?");
        expect(out).toContain("qa · via stackexchange · authority 0.54");
    });

    it("costs a fraction of a search over the same result", () => {
        // At the real assembly budget a search returns ~11,000 characters over
        // ~5 documents. Sized like that, because the survey's per-row overhead
        // is fixed and only looks expensive against toy excerpts.
        const realistic = result(
            Array.from({ length: 5 }, (_, i) =>
                page({
                    rank: i + 1,
                    url: `https://example.com/page-${i}`,
                    excerpts: [excerpt(`Heading ${i}\n${"substantive sentence about the topic. ".repeat(55)}`)],
                })
            )
        );

        const survey = formatSurvey("q", realistic, 0, false).length;
        const search = formatForMcp("q", realistic, 0).length;

        expect(survey).toBeLessThan(search * 0.2);
    });

    it("marks only canonical pages as CANONICAL", () => {
        const out = formatSurvey("q", surveyed, 0, false);

        expect(out.match(/CANONICAL/g)).toHaveLength(1);
    });

    it("drops the repeated heading line from the teaser", () => {
        const out = formatSurvey("q", surveyed, 0, false);

        expect(out).toContain('"useTimer schedules a callback and clears it on unmount."');
    });

    it("truncates a long teaser on a word boundary", () => {
        const long = "word ".repeat(80).trim();
        const out = formatSurvey("q", result([page({ excerpts: [excerpt(long)] })]), 0, false);
        const teaser = out.split("\n").find((line) => line.trim().startsWith('"'));

        expect(teaser).toBeDefined();
        expect(teaser).toContain("…");
        expect(teaser).not.toMatch(/wor…/);
    });

    it("shows authority reasons only when asked", () => {
        expect(formatSurvey("q", surveyed, 0, false)).not.toContain("declared homepage");
        expect(formatSurvey("q", surveyed, 0, true)).toContain("+0.30 declared homepage");
    });

    it("points at the tools that read a source in full", () => {
        const out = formatSurvey("q", surveyed, 0, false);

        expect(out).toContain("peeky_fetch_page");
        expect(out).toContain("peeky_web_search");
    });

    it("explains an empty survey", () => {
        expect(formatSurvey("zzz", result([]), 0, false)).toContain('No usable sources for: "zzz"');
    });

    it("survives a page whose passage held nothing but its heading", () => {
        const out = formatSurvey(
            "q",
            result([page({ excerpts: [excerpt("Overview", ["Overview"])] })]),
            0,
            false
        );

        expect(out).toContain("1. A Guide");
        expect(out).not.toContain('""');
    });
});
