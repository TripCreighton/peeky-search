import { describe, it, expect } from "vitest";
import { expandAnchor, buildChunkText } from "../expand";
import type { Sentence, ScoredSentence } from "../../types";

function createSentence(
    text: string,
    globalIndex: number,
    options: Partial<Sentence> = {}
): Sentence {
    return {
        text,
        tokens: text.split(" "),
        blockIndex: globalIndex,
        sentenceIndex: 0,
        globalIndex,
        headingPath: [],
        position: globalIndex / 10,
        blockType: "p",
        ...options,
    };
}

function createScoredSentence(
    text: string,
    globalIndex: number,
    options: Partial<Sentence> = {}
): ScoredSentence {
    return {
        ...createSentence(text, globalIndex, options),
        bm25Score: 0.5,
        heuristicScore: 0.5,
        combinedScore: 0.5,
    };
}

describe("buildChunkText", () => {
    it("formats paragraphs with spaces", () => {
        const sentences: Sentence[] = [
            createSentence("First sentence.", 0),
            createSentence("Second sentence.", 1),
        ];

        const text = buildChunkText(sentences);

        expect(text).toBe("First sentence. Second sentence.");
    });

    it("formats headings with double newlines", () => {
        const sentences: Sentence[] = [
            createSentence("Some text.", 0),
            createSentence("Heading", 1, { blockType: "h2" }),
            createSentence("More text.", 2),
        ];

        const text = buildChunkText(sentences);

        expect(text).toContain("Some text.");
        expect(text).toContain("\n\nHeading");
        expect(text).toContain("\n\nMore text.");
    });

    it("formats code blocks with fences", () => {
        const sentences: Sentence[] = [
            createSentence("Explanation.", 0),
            createSentence("const x = 1;", 1, { blockType: "pre" }),
            createSentence("More explanation.", 2),
        ];

        const text = buildChunkText(sentences);

        expect(text).toContain("```\nconst x = 1;\n```");
    });

    it("formats list items with bullets", () => {
        const sentences: Sentence[] = [
            createSentence("A list:", 0),
            createSentence("Item one", 1, { blockType: "li" }),
            createSentence("Item two", 2, { blockType: "li" }),
        ];

        const text = buildChunkText(sentences);

        expect(text).toContain("\n- Item one");
        expect(text).toContain("\n- Item two");
    });

    it("handles empty sentences array", () => {
        const text = buildChunkText([]);

        expect(text).toBe("");
    });
});

describe("expandAnchor", () => {
    it("expands to include context before and after", () => {
        const allSentences: Sentence[] = [
            createSentence("Before 1.", 0),
            createSentence("Before 2.", 1),
            createSentence("Anchor sentence.", 2),
            createSentence("After 1.", 3),
            createSentence("After 2.", 4),
        ];
        const anchor = createScoredSentence("Anchor sentence.", 2);

        const chunk = expandAnchor(anchor, allSentences, {
            contextBefore: 2,
            contextAfter: 2,
            expandToSection: false,
            maxChunkChars: 10000,
        });

        expect(chunk.sentences).toHaveLength(5);
        expect(chunk.sentences.map(s => s.text)).toContain("Before 1.");
        expect(chunk.sentences.map(s => s.text)).toContain("Anchor sentence.");
        expect(chunk.sentences.map(s => s.text)).toContain("After 2.");
    });

    it("does not exceed array bounds at start", () => {
        const allSentences: Sentence[] = [
            createSentence("Anchor at start.", 0),
            createSentence("After.", 1),
        ];
        const anchor = createScoredSentence("Anchor at start.", 0);

        const chunk = expandAnchor(anchor, allSentences, {
            contextBefore: 5, // Would go negative
            contextAfter: 2,
            expandToSection: false,
            maxChunkChars: 10000,
        });

        // Should not error, start index clamped to 0
        expect(chunk.sentences.length).toBeGreaterThan(0);
        expect(chunk.sentences[0]?.globalIndex).toBe(0);
    });

    it("does not exceed array bounds at end", () => {
        const allSentences: Sentence[] = [
            createSentence("Before.", 0),
            createSentence("Anchor at end.", 1),
        ];
        const anchor = createScoredSentence("Anchor at end.", 1);

        const chunk = expandAnchor(anchor, allSentences, {
            contextBefore: 2,
            contextAfter: 5, // Would exceed length
            expandToSection: false,
            maxChunkChars: 10000,
        });

        // Should not error, end index clamped to length-1
        expect(chunk.sentences.length).toBeGreaterThan(0);
        const lastSentence = chunk.sentences[chunk.sentences.length - 1];
        expect(lastSentence?.globalIndex).toBe(1);
    });

    it("respects section boundaries (stops at same-level heading)", () => {
        const allSentences: Sentence[] = [
            createSentence("Section 1", 0, { blockType: "h2" }),
            createSentence("Content 1.", 1),
            createSentence("Content 2.", 2),
            createSentence("Section 2", 3, { blockType: "h2" }), // Same level
            createSentence("Content 3.", 4),
        ];
        const anchor = createScoredSentence("Content 1.", 1);

        const chunk = expandAnchor(anchor, allSentences, {
            expandToSection: true,
            maxChunkChars: 10000,
        });

        // Should include Section 1, Content 1, Content 2
        // But NOT Section 2 or Content 3
        expect(chunk.sentences.map(s => s.text)).toContain("Section 1");
        expect(chunk.sentences.map(s => s.text)).toContain("Content 1.");
        expect(chunk.sentences.map(s => s.text)).toContain("Content 2.");
        expect(chunk.sentences.map(s => s.text)).not.toContain("Section 2");
        expect(chunk.sentences.map(s => s.text)).not.toContain("Content 3.");
    });

    it("allows code block to exceed budget by 1.5x", () => {
        const allSentences: Sentence[] = [
            createSentence("Short intro.", 0),
            createSentence("Anchor here.", 1),
            createSentence("x".repeat(100), 2, { blockType: "pre" }), // 100 chars of code
        ];
        const anchor = createScoredSentence("Anchor here.", 1);

        const chunk = expandAnchor(anchor, allSentences, {
            maxChunkChars: 80, // Small budget
            includeCodeBlocks: true,
            expandToSection: false,
        });

        // Code block should be included even though it exceeds budget
        // because 100 < 80 * 1.5 = 120
        expect(chunk.sentences.some(s => s.blockType === "pre")).toBe(true);
    });

    it("preserves heading path from anchor", () => {
        const allSentences: Sentence[] = [
            createSentence("Content.", 0),
        ];
        const anchor = createScoredSentence("Content.", 0);
        anchor.headingPath = ["React", "Hooks"];

        const chunk = expandAnchor(anchor, allSentences, {
            expandToSection: false,
            maxChunkChars: 10000,
        });

        expect(chunk.headingPath).toEqual(["React", "Hooks"]);
    });

    it("sets anchor index correctly", () => {
        const allSentences: Sentence[] = [
            createSentence("Before.", 0),
            createSentence("Anchor.", 1),
            createSentence("After.", 2),
        ];
        const anchor = createScoredSentence("Anchor.", 1);

        const chunk = expandAnchor(anchor, allSentences, {
            expandToSection: false,
            maxChunkChars: 10000,
        });

        expect(chunk.anchorIndex).toBe(1);
    });

    it("calculates charCount from raw content", () => {
        const allSentences: Sentence[] = [
            createSentence("12345", 0), // 5 chars
            createSentence("67890", 1), // 5 chars
        ];
        const anchor = createScoredSentence("12345", 0);

        const chunk = expandAnchor(anchor, allSentences, {
            expandToSection: false,
            maxChunkChars: 10000,
        });

        // Raw chars = 5 + 5 = 10 (not including space in formatted text)
        expect(chunk.charCount).toBe(10);
    });
});
