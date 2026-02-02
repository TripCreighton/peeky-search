import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { extractExcerpts, extract } from "../pipeline";

const fixturesDir = join(process.cwd(), "test-fixtures");

let basicArticleHtml: string;
let boilerplateHeavyHtml: string;
let codeDocumentationHtml: string;
let lowQualityHtml: string;
let abbreviationsHtml: string;
let nestedHeadingsHtml: string;

beforeAll(() => {
    basicArticleHtml = readFileSync(join(fixturesDir, "basic-article.html"), "utf-8");
    boilerplateHeavyHtml = readFileSync(join(fixturesDir, "boilerplate-heavy.html"), "utf-8");
    codeDocumentationHtml = readFileSync(join(fixturesDir, "code-documentation.html"), "utf-8");
    lowQualityHtml = readFileSync(join(fixturesDir, "low-quality.html"), "utf-8");
    abbreviationsHtml = readFileSync(join(fixturesDir, "abbreviations.html"), "utf-8");
    nestedHeadingsHtml = readFileSync(join(fixturesDir, "nested-headings.html"), "utf-8");
});

describe("Full extraction pipeline", () => {
    describe("basic-article.html", () => {
        it("extracts relevant excerpts for 'useState' query", () => {
            const result = extractExcerpts(basicArticleHtml, "useState");

            expect(result.excerpts.length).toBeGreaterThan(0);
            expect(result.relevanceMetrics?.hasRelevantResults).toBe(true);

            // Should find content about useState
            const allText = result.excerpts.map(e => e.text).join(" ");
            expect(allText.toLowerCase()).toContain("usestate");
        });

        it("extracts relevant excerpts for 'useEffect cleanup' query", () => {
            const result = extractExcerpts(basicArticleHtml, "useEffect cleanup");

            expect(result.excerpts.length).toBeGreaterThan(0);

            // Should find cleanup-related content
            const allText = result.excerpts.map(e => e.text).join(" ");
            expect(allText.toLowerCase()).toContain("cleanup");
        });

        it("returns hasRelevantResults=false for unrelated query", () => {
            const result = extractExcerpts(basicArticleHtml, "python django orm");

            // Should not find relevant content
            expect(result.relevanceMetrics?.hasRelevantResults).toBe(false);
            expect(result.excerpts.length).toBe(0);
        });

        it("includes code blocks in excerpts", () => {
            const result = extractExcerpts(basicArticleHtml, "useState setCount");

            expect(result.excerpts.length).toBeGreaterThan(0);

            const allText = result.excerpts.map(e => e.text).join(" ");
            // Code should be included with fences
            expect(allText).toContain("setCount");
        });

        it("preserves heading path in excerpts", () => {
            const result = extractExcerpts(basicArticleHtml, "useEffect");

            expect(result.excerpts.length).toBeGreaterThan(0);

            // At least one excerpt should have heading path
            const hasPath = result.excerpts.some(e => e.headingPath.length > 0);
            expect(hasPath).toBe(true);
        });

        it("respects character budget", () => {
            const result = extractExcerpts(basicArticleHtml, "React", {
                excerpts: { charBudget: 500 },
            });

            expect(result.totalChars).toBeLessThanOrEqual(500);
        });
    });

    describe("boilerplate-heavy.html", () => {
        it("extracts content from main, ignoring nav/footer", () => {
            const result = extractExcerpts(boilerplateHeavyHtml, "API authentication");

            expect(result.excerpts.length).toBeGreaterThan(0);

            const allText = result.excerpts.map(e => e.text).join(" ");
            // Should contain API content
            expect(allText.toLowerCase()).toContain("authentication");

            // Should NOT contain nav/footer content
            expect(allText.toLowerCase()).not.toContain("home");
            expect(allText.toLowerCase()).not.toContain("copyright");
        });

        it("removes scripts and styles", () => {
            const result = extractExcerpts(boilerplateHeavyHtml, "API");

            const allText = result.excerpts.map(e => e.text).join(" ");

            // Script content should not appear
            expect(allText).not.toContain("console.log");
            expect(allText).not.toContain("trackAnalytics");

            // Style content should not appear
            expect(allText).not.toContain(".nav");
        });
    });

    describe("code-documentation.html", () => {
        it("extracts code blocks with proper formatting", () => {
            const result = extractExcerpts(codeDocumentationHtml, "strict mode typescript");

            expect(result.excerpts.length).toBeGreaterThan(0);

            const allText = result.excerpts.map(e => e.text).join("\n");
            // Should contain code block with config
            expect(allText).toContain("strict");
        });

        it("handles .line divs in code blocks", () => {
            const result = extractExcerpts(codeDocumentationHtml, "module resolution");

            expect(result.excerpts.length).toBeGreaterThan(0);

            const allText = result.excerpts.map(e => e.text).join("\n");
            // Text contains "module resolution" or "moduleResolution"
            expect(allText.toLowerCase()).toContain("module");
            expect(allText.toLowerCase()).toContain("resolution");
        });
    });

    describe("low-quality.html", () => {
        it("rejects low-quality content", () => {
            const result = extractExcerpts(lowQualityHtml, "click");

            // Should fail quality check
            expect(result.relevanceMetrics?.qualityRejectReason).toBeDefined();
            expect(result.excerpts.length).toBe(0);
        });

        it("can skip quality check if configured", () => {
            const result = extractExcerpts(lowQualityHtml, "click", {
                skipQualityCheck: true,
            });

            // Without quality check, may still fail relevance
            // but shouldn't have quality reject reason
            expect(result.relevanceMetrics?.qualityRejectReason).toBeUndefined();
        });
    });

    describe("abbreviations.html", () => {
        it("handles abbreviations in sentences", () => {
            const result = extractExcerpts(abbreviationsHtml, "research methodology");

            expect(result.excerpts.length).toBeGreaterThan(0);

            // Content should be extracted properly despite abbreviations
            const allText = result.excerpts.map(e => e.text).join(" ");
            expect(allText.toLowerCase()).toContain("research");
        });

        it("keeps Dr. and Inc. abbreviations in sentences", () => {
            const result = extractExcerpts(abbreviationsHtml, "Dr. Smith Inc.", {
                ranker: { relevanceMode: "search" },
            });

            const allText = result.excerpts.map(e => e.text).join(" ");

            // Sentence should not be broken at "Dr."
            if (allText.includes("Dr")) {
                // If found, should be part of a proper sentence
                expect(allText).toContain("Dr.");
            }
        });
    });

    describe("nested-headings.html", () => {
        it("tracks heading hierarchy correctly", () => {
            const result = extractExcerpts(nestedHeadingsHtml, "atomic values", {
                debug: true,
            });

            expect(result.excerpts.length).toBeGreaterThan(0);

            // Should have heading path showing hierarchy
            const withPath = result.excerpts.find(e => e.headingPath.length >= 2);
            expect(withPath).toBeDefined();
        });

        it("finds content in deeply nested sections", () => {
            const result = extractExcerpts(nestedHeadingsHtml, "transitive dependency");

            expect(result.excerpts.length).toBeGreaterThan(0);

            const allText = result.excerpts.map(e => e.text).join(" ");
            expect(allText.toLowerCase()).toContain("transitive");
        });
    });
});

describe("Pipeline configuration", () => {
    it("respects maxExcerpts config", () => {
        const result = extractExcerpts(basicArticleHtml, "React", {
            excerpts: { maxExcerpts: 1 },
        });

        expect(result.excerpts.length).toBeLessThanOrEqual(1);
    });

    it("respects relevanceMode: search (looser)", () => {
        // Search mode should be more permissive
        const strictResult = extractExcerpts(basicArticleHtml, "hook", {
            ranker: { relevanceMode: "strict" },
        });

        const searchResult = extractExcerpts(basicArticleHtml, "hook", {
            ranker: { relevanceMode: "search" },
        });

        // Search mode should find at least as many results
        expect(searchResult.excerpts.length).toBeGreaterThanOrEqual(strictResult.excerpts.length);
    });

    it("provides debug info when debug=true", () => {
        const result = extractExcerpts(basicArticleHtml, "useState", {
            debug: true,
        });

        expect(result.debug).toBeDefined();
        expect(result.debug?.sentenceCount).toBeGreaterThan(0);
        expect(result.debug?.topSentences).toBeDefined();
    });

    it("respects minScore threshold for anchors", () => {
        const lowThreshold = extractExcerpts(basicArticleHtml, "React", {
            anchors: { minScore: 0.1 },
        });

        const highThreshold = extractExcerpts(basicArticleHtml, "React", {
            anchors: { minScore: 0.9 },
        });

        // High threshold should produce fewer or no results
        expect(highThreshold.excerpts.length).toBeLessThanOrEqual(lowThreshold.excerpts.length);
    });
});

describe("Edge cases", () => {
    it("handles empty HTML", () => {
        const result = extract("", "test");

        expect(result.excerpts).toHaveLength(0);
        expect(result.totalChars).toBe(0);
    });

    it("handles HTML without main content", () => {
        const html = `
            <html>
            <body>
                <nav>Navigation only</nav>
            </body>
            </html>
        `;

        const result = extract(html, "test");

        expect(result.excerpts).toHaveLength(0);
    });

    it("handles empty query", () => {
        const result = extract(basicArticleHtml, "");

        // Should fall back to position-based extraction
        // May or may not have excerpts depending on implementation
    });

    it("handles query with only stop words", () => {
        const result = extract(basicArticleHtml, "the and or");

        // After tokenization, no meaningful terms remain
        // Should handle gracefully
    });

    it("handles very long query", () => {
        const longQuery = "React hooks useState useEffect useCallback useMemo useRef useContext useReducer";

        const result = extract(basicArticleHtml, longQuery);

        // Should still work with many query terms
        expect(result).toBeDefined();
    });

    it("handles query with special characters", () => {
        const result = extract(basicArticleHtml, 'React "hooks" (state)');

        // Should handle quotes and parentheses
        expect(result).toBeDefined();
    });
});

describe("Relevance metrics", () => {
    it("returns relevance metrics for all queries", () => {
        const result = extractExcerpts(basicArticleHtml, "useState");

        expect(result.relevanceMetrics).toBeDefined();
        expect(result.relevanceMetrics?.sentenceCount).toBeGreaterThan(0);
        expect(typeof result.relevanceMetrics?.queryTermCoverage).toBe("number");
        expect(typeof result.relevanceMetrics?.maxBm25).toBe("number");
        expect(typeof result.relevanceMetrics?.maxCooccurrence).toBe("number");
    });

    it("reports high coverage for focused queries", () => {
        const result = extractExcerpts(basicArticleHtml, "React hooks");

        // React and hooks appear frequently in this doc
        expect(result.relevanceMetrics?.queryTermCoverage).toBeGreaterThan(0.5);
    });

    it("reports low coverage for unrelated queries", () => {
        const result = extractExcerpts(basicArticleHtml, "python flask");

        expect(result.relevanceMetrics?.queryTermCoverage).toBe(0);
    });

    it("detects co-occurrence correctly", () => {
        const result = extractExcerpts(basicArticleHtml, "useState hook");

        // Both terms appear in the same sentences
        expect(result.relevanceMetrics?.maxCooccurrence).toBeGreaterThanOrEqual(2);
    });
});
