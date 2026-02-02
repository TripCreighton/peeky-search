import { describe, it, expect } from "vitest";
import { assembleExcerpts, formatExcerpts } from "../excerpts";
import type { Chunk, Sentence } from "../../types";

function createSentence(text: string, globalIndex: number): Sentence {
    return {
        text,
        tokens: text.split(" "),
        blockIndex: globalIndex,
        sentenceIndex: 0,
        globalIndex,
        headingPath: [],
        position: globalIndex / 10,
        blockType: "p",
    };
}

function createChunk(
    text: string,
    charCount: number,
    score: number,
    anchorIndex: number,
    headingPath: string[] = []
): Chunk {
    return {
        sentences: [createSentence(text, anchorIndex)],
        anchorIndex,
        score,
        text,
        charCount,
        headingPath,
    };
}

describe("assembleExcerpts", () => {
    it("selects excerpts within budget", () => {
        const chunks = [
            createChunk("Large content here", 500, 0.9, 0),
            createChunk("Medium content", 300, 0.8, 1),
            createChunk("Small", 100, 0.7, 2),
        ];

        const result = assembleExcerpts(chunks, "test query", {
            charBudget: 600,
            maxExcerpts: 5,
        });

        // Should fit first (500) and second (300) but second would exceed 600
        // Actually 500 < 600, so first fits. 500 + 300 = 800 > 600, so second doesn't fit
        // Third: 500 + 100 = 600 <= 600, so third fits
        expect(result.excerpts).toHaveLength(2);
        expect(result.totalChars).toBe(600);
    });

    it("respects maxExcerpts limit", () => {
        const chunks = [
            createChunk("A", 50, 0.9, 0),
            createChunk("B", 50, 0.8, 1),
            createChunk("C", 50, 0.7, 2),
            createChunk("D", 50, 0.6, 3),
        ];

        const result = assembleExcerpts(chunks, "test", {
            charBudget: 10000, // Large budget
            maxExcerpts: 2,
            minExcerptChars: 10,
        });

        expect(result.excerpts).toHaveLength(2);
    });

    it("filters out small chunks", () => {
        const chunks = [
            createChunk("Normal sized content here", 100, 0.9, 0),
            createChunk("Tiny", 20, 0.8, 1), // Below default 50
        ];

        const result = assembleExcerpts(chunks, "test", {
            minExcerptChars: 50,
        });

        expect(result.excerpts).toHaveLength(1);
        expect(result.excerpts[0]?.text).toBe("Normal sized content here");
    });

    it("sorts by score descending", () => {
        const chunks = [
            createChunk("Low score", 100, 0.3, 0),
            createChunk("High score", 100, 0.9, 1),
            createChunk("Medium score", 100, 0.6, 2),
        ];

        const result = assembleExcerpts(chunks, "test", {
            charBudget: 10000,
            maxExcerpts: 5,
            minExcerptChars: 10,
        });

        expect(result.excerpts[0]?.score).toBe(0.9);
        expect(result.excerpts[1]?.score).toBe(0.6);
        expect(result.excerpts[2]?.score).toBe(0.3);
    });

    it("includes query in result", () => {
        const chunks = [createChunk("Content", 100, 0.9, 0)];

        const result = assembleExcerpts(chunks, "react hooks", {
            minExcerptChars: 10,
        });

        expect(result.query).toBe("react hooks");
    });

    it("preserves heading path in excerpts", () => {
        const chunks = [
            createChunk("Content", 100, 0.9, 0, ["React", "Hooks"]),
        ];

        const result = assembleExcerpts(chunks, "test", {
            minExcerptChars: 10,
        });

        expect(result.excerpts[0]?.headingPath).toEqual(["React", "Hooks"]);
    });

    it("handles empty chunks array", () => {
        const result = assembleExcerpts([], "test");

        expect(result.excerpts).toHaveLength(0);
        expect(result.totalChars).toBe(0);
    });

    it("never exceeds hard budget limit", () => {
        const chunks = [
            createChunk("x".repeat(3000), 3000, 0.9, 0),
            createChunk("y".repeat(2000), 2000, 0.8, 1),
            createChunk("z".repeat(2000), 2000, 0.7, 2),
        ];

        const result = assembleExcerpts(chunks, "test", {
            charBudget: 6000,
            maxExcerpts: 10,
            minExcerptChars: 10,
        });

        // 3000 fits, 3000+2000=5000 fits, 5000+2000=7000 > 6000
        expect(result.totalChars).toBeLessThanOrEqual(6000);
    });

    it("uses default config values", () => {
        const chunks = [
            createChunk("x".repeat(100), 100, 0.9, 0),
            createChunk("y".repeat(100), 100, 0.8, 1),
            createChunk("z".repeat(100), 100, 0.7, 2),
            createChunk("w".repeat(100), 100, 0.6, 3),
        ];

        // Default maxExcerpts is 3
        const result = assembleExcerpts(chunks, "test");

        expect(result.excerpts.length).toBeLessThanOrEqual(3);
    });
});

describe("formatExcerpts", () => {
    it("formats excerpts for display", () => {
        const result = {
            excerpts: [
                {
                    text: "First excerpt content",
                    headingPath: ["Section A"],
                    score: 0.95,
                    charCount: 21,
                },
            ],
            totalChars: 21,
            query: "test query",
        };

        const formatted = formatExcerpts(result);

        expect(formatted).toContain('Query: "test query"');
        expect(formatted).toContain("Total characters: 21");
        expect(formatted).toContain("Excerpt 1");
        expect(formatted).toContain("0.950");
        expect(formatted).toContain("21 chars");
        expect(formatted).toContain("[Section A]");
        expect(formatted).toContain("First excerpt content");
    });

    it("formats multiple excerpts", () => {
        const result = {
            excerpts: [
                { text: "First", headingPath: [], score: 0.9, charCount: 5 },
                { text: "Second", headingPath: [], score: 0.8, charCount: 6 },
            ],
            totalChars: 11,
            query: "test",
        };

        const formatted = formatExcerpts(result);

        expect(formatted).toContain("Excerpt 1");
        expect(formatted).toContain("Excerpt 2");
        expect(formatted).toContain("First");
        expect(formatted).toContain("Second");
    });

    it("handles empty heading path", () => {
        const result = {
            excerpts: [
                { text: "Content", headingPath: [], score: 0.9, charCount: 7 },
            ],
            totalChars: 7,
            query: "test",
        };

        const formatted = formatExcerpts(result);

        // Should not include "[...]" line
        expect(formatted).not.toContain("[]");
    });

    it("formats nested heading path", () => {
        const result = {
            excerpts: [
                {
                    text: "Content",
                    headingPath: ["Level 1", "Level 2", "Level 3"],
                    score: 0.9,
                    charCount: 7,
                },
            ],
            totalChars: 7,
            query: "test",
        };

        const formatted = formatExcerpts(result);

        expect(formatted).toContain("[Level 1 > Level 2 > Level 3]");
    });

    it("handles no excerpts", () => {
        const result = {
            excerpts: [],
            totalChars: 0,
            query: "test",
        };

        const formatted = formatExcerpts(result);

        expect(formatted).toContain('Query: "test"');
        expect(formatted).toContain("Total characters: 0");
        expect(formatted).not.toContain("Excerpt");
    });
});
