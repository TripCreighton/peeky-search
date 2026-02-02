import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import {
    extractBlocks,
    splitIntoSentences,
    segmentBlocks,
    segmentHtml,
} from "../segment";
import type { Block } from "../../types";

describe("splitIntoSentences", () => {
    it("splits on period followed by capital letter", () => {
        const text = "First sentence. Second sentence.";

        const sentences = splitIntoSentences(text);

        expect(sentences).toEqual(["First sentence.", "Second sentence."]);
    });

    it("splits on exclamation mark", () => {
        const text = "Hello world! This is great.";

        const sentences = splitIntoSentences(text);

        expect(sentences).toEqual(["Hello world!", "This is great."]);
    });

    it("splits on question mark", () => {
        const text = "Is this working? Yes it is.";

        const sentences = splitIntoSentences(text);

        expect(sentences).toEqual(["Is this working?", "Yes it is."]);
    });

    it("does not split on abbreviations", () => {
        const text = "Dr. Smith works at Example Inc. every day.";

        const sentences = splitIntoSentences(text);

        // Should be one sentence, not split at "Dr." or "Inc."
        expect(sentences).toHaveLength(1);
        expect(sentences[0]).toBe("Dr. Smith works at Example Inc. every day.");
    });

    it("handles Mr., Mrs., Ms. abbreviations", () => {
        const text = "Mr. Jones and Mrs. Smith met Ms. Brown.";

        const sentences = splitIntoSentences(text);

        expect(sentences).toHaveLength(1);
        expect(sentences[0]).toBe("Mr. Jones and Mrs. Smith met Ms. Brown.");
    });

    it("handles e.g. and i.e. abbreviations", () => {
        const text = "Use tools, e.g. hammers. Also items, i.e. nails.";

        const sentences = splitIntoSentences(text);

        // "e.g." and "i.e." should not split
        expect(sentences).toHaveLength(2);
        expect(sentences[0]).toBe("Use tools, e.g. hammers.");
    });

    it("handles Prof. and Sr. abbreviations", () => {
        const text = "Prof. Johnson teaches Sr. students.";

        const sentences = splitIntoSentences(text);

        expect(sentences).toHaveLength(1);
    });

    it("handles empty string", () => {
        const sentences = splitIntoSentences("");

        expect(sentences).toEqual([]);
    });

    it("handles text without sentence-ending punctuation", () => {
        const text = "No punctuation here";

        const sentences = splitIntoSentences(text);

        expect(sentences).toEqual(["No punctuation here"]);
    });

    it("normalizes whitespace", () => {
        const text = "First   sentence.   Second   sentence.";

        const sentences = splitIntoSentences(text);

        expect(sentences).toEqual(["First sentence.", "Second sentence."]);
    });

    it("handles mixed punctuation", () => {
        const text = "What? Really! Yes.";

        const sentences = splitIntoSentences(text);

        expect(sentences).toEqual(["What?", "Really!", "Yes."]);
    });
});

describe("extractBlocks", () => {
    it("extracts paragraph blocks", () => {
        const $ = cheerio.load(`
            <main>
                <p>First paragraph</p>
                <p>Second paragraph</p>
            </main>
        `);

        const blocks = extractBlocks($, $("main"));

        expect(blocks).toHaveLength(2);
        expect(blocks[0]?.type).toBe("p");
        expect(blocks[0]?.text).toBe("First paragraph");
        expect(blocks[1]?.type).toBe("p");
        expect(blocks[1]?.text).toBe("Second paragraph");
    });

    it("extracts heading blocks with correct types", () => {
        const $ = cheerio.load(`
            <main>
                <h1>Main Title</h1>
                <h2>Section</h2>
                <h3>Subsection</h3>
            </main>
        `);

        const blocks = extractBlocks($, $("main"));

        expect(blocks).toHaveLength(3);
        expect(blocks[0]?.type).toBe("h1");
        expect(blocks[1]?.type).toBe("h2");
        expect(blocks[2]?.type).toBe("h3");
    });

    it("tracks heading path correctly", () => {
        const $ = cheerio.load(`
            <main>
                <h1>Title</h1>
                <p>Intro paragraph</p>
                <h2>Section One</h2>
                <p>Section one content</p>
                <h2>Section Two</h2>
                <p>Section two content</p>
            </main>
        `);

        const blocks = extractBlocks($, $("main"));

        // EXPECTED behavior based on comment "Truncate to parent level":
        // Heading path should contain ANCESTORS only, not siblings

        // h1 "Title" - no ancestors
        expect(blocks[0]?.headingPath).toEqual([]);
        // p after h1 - path includes parent "Title"
        expect(blocks[1]?.headingPath).toEqual(["Title"]);
        // h2 "Section One" - parent is h1 "Title" only
        expect(blocks[2]?.headingPath).toEqual(["Title"]);
        // p after h2 "Section One" - path includes both ancestors
        expect(blocks[3]?.headingPath).toEqual(["Title", "Section One"]);
        // h2 "Section Two" - EXPECTED: parent is h1 "Title" only (not sibling h2)
        // The heading should only have its ancestors, not its previous sibling
        expect(blocks[4]?.headingPath).toEqual(["Title"]);
        // p after h2 "Section Two" - path includes both ancestors
        expect(blocks[5]?.headingPath).toEqual(["Title", "Section Two"]);
    });

    it("handles nested heading hierarchy (h1 > h2 > h3 > h4)", () => {
        const $ = cheerio.load(`
            <main>
                <h1>Level 1</h1>
                <h2>Level 2</h2>
                <h3>Level 3</h3>
                <h4>Level 4</h4>
                <p>Deep content</p>
            </main>
        `);

        const blocks = extractBlocks($, $("main"));

        // p should have full path
        expect(blocks[4]?.headingPath).toEqual(["Level 1", "Level 2", "Level 3", "Level 4"]);
    });

    it("extracts list items", () => {
        const $ = cheerio.load(`
            <main>
                <ul>
                    <li>Item one</li>
                    <li>Item two</li>
                </ul>
            </main>
        `);

        const blocks = extractBlocks($, $("main"));

        expect(blocks).toHaveLength(2);
        expect(blocks[0]?.type).toBe("li");
        expect(blocks[0]?.text).toBe("Item one");
        expect(blocks[1]?.type).toBe("li");
        expect(blocks[1]?.text).toBe("Item two");
    });

    it("extracts pre/code blocks", () => {
        const $ = cheerio.load(`
            <main>
                <pre><code>const x = 1;
const y = 2;</code></pre>
            </main>
        `);

        const blocks = extractBlocks($, $("main"));

        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.type).toBe("pre");
        expect(blocks[0]?.text).toContain("const x = 1;");
        expect(blocks[0]?.text).toContain("const y = 2;");
    });

    it("preserves whitespace in code blocks", () => {
        const $ = cheerio.load(`
            <main>
                <pre>function foo() {
    return 42;
}</pre>
            </main>
        `);

        const blocks = extractBlocks($, $("main"));

        expect(blocks[0]?.text).toContain("function foo()");
        expect(blocks[0]?.text).toContain("return 42");
    });

    it("handles .line divs in code blocks", () => {
        const $ = cheerio.load(`
            <main>
                <pre>
                    <div class="line">const x = 1;</div>
                    <div class="line">const y = 2;</div>
                </pre>
            </main>
        `);

        const blocks = extractBlocks($, $("main"));

        expect(blocks[0]?.text).toContain("const x = 1;");
        expect(blocks[0]?.text).toContain("const y = 2;");
    });

    it("skips empty blocks", () => {
        const $ = cheerio.load(`
            <main>
                <p>Content</p>
                <p></p>
                <p>   </p>
                <p>More content</p>
            </main>
        `);

        const blocks = extractBlocks($, $("main"));

        // Empty paragraphs should be skipped
        expect(blocks).toHaveLength(2);
        expect(blocks[0]?.text).toBe("Content");
        expect(blocks[1]?.text).toBe("More content");
    });

    it("skips nav elements when skipNav is true", () => {
        const $ = cheerio.load(`
            <main>
                <p>Before nav</p>
                <nav>
                    <p>Nav content</p>
                </nav>
                <p>After nav</p>
            </main>
        `);

        const blocks = extractBlocks($, $("main"), { skipNav: true });

        expect(blocks).toHaveLength(2);
        expect(blocks[0]?.text).toBe("Before nav");
        expect(blocks[1]?.text).toBe("After nav");
    });
});

describe("segmentBlocks", () => {
    it("segments paragraph blocks into sentences", () => {
        const blocks: Block[] = [
            { type: "p", text: "First sentence. Second sentence.", index: 0, headingPath: [] },
        ];

        const sentences = segmentBlocks(blocks);

        expect(sentences).toHaveLength(2);
        expect(sentences[0]?.text).toBe("First sentence.");
        expect(sentences[1]?.text).toBe("Second sentence.");
    });

    it("treats headings as single sentences", () => {
        const blocks: Block[] = [
            { type: "h1", text: "Main Title", index: 0, headingPath: [] },
            { type: "h2", text: "Section Title", index: 1, headingPath: ["Main Title"] },
        ];

        const sentences = segmentBlocks(blocks);

        expect(sentences).toHaveLength(2);
        expect(sentences[0]?.text).toBe("Main Title");
        expect(sentences[0]?.blockType).toBe("h1");
        expect(sentences[1]?.text).toBe("Section Title");
        expect(sentences[1]?.blockType).toBe("h2");
    });

    it("treats code blocks as single sentences", () => {
        const blocks: Block[] = [
            {
                type: "pre",
                text: "const x = 1;\nconst y = 2;",
                index: 0,
                headingPath: [],
            },
        ];

        const sentences = segmentBlocks(blocks);

        expect(sentences).toHaveLength(1);
        expect(sentences[0]?.blockType).toBe("pre");
        expect(sentences[0]?.text).toContain("const x = 1;");
    });

    it("calculates position correctly", () => {
        const blocks: Block[] = [
            { type: "p", text: "First.", index: 0, headingPath: [] },
            { type: "p", text: "Second.", index: 1, headingPath: [] },
            { type: "p", text: "Third.", index: 2, headingPath: [] },
        ];

        const sentences = segmentBlocks(blocks);

        // Position = blockIndex / (totalBlocks - 1)
        expect(sentences[0]?.position).toBe(0);     // 0 / 2 = 0
        expect(sentences[1]?.position).toBe(0.5);   // 1 / 2 = 0.5
        expect(sentences[2]?.position).toBe(1);     // 2 / 2 = 1
    });

    it("calculates position as 0 for single block", () => {
        const blocks: Block[] = [
            { type: "p", text: "Only block.", index: 0, headingPath: [] },
        ];

        const sentences = segmentBlocks(blocks);

        // Single block should have position 0, not NaN
        expect(sentences[0]?.position).toBe(0);
        expect(Number.isNaN(sentences[0]?.position)).toBe(false);
    });

    it("assigns correct globalIndex", () => {
        const blocks: Block[] = [
            { type: "p", text: "A. B.", index: 0, headingPath: [] }, // 2 sentences
            { type: "p", text: "C.", index: 1, headingPath: [] },   // 1 sentence
        ];

        const sentences = segmentBlocks(blocks);

        expect(sentences).toHaveLength(3);
        expect(sentences[0]?.globalIndex).toBe(0);
        expect(sentences[1]?.globalIndex).toBe(1);
        expect(sentences[2]?.globalIndex).toBe(2);
    });

    it("preserves heading path", () => {
        const blocks: Block[] = [
            { type: "h1", text: "Title", index: 0, headingPath: [] },
            { type: "p", text: "Content.", index: 1, headingPath: ["Title"] },
        ];

        const sentences = segmentBlocks(blocks);

        expect(sentences[0]?.headingPath).toEqual([]);
        expect(sentences[1]?.headingPath).toEqual(["Title"]);
    });

    it("tokenizes sentence text", () => {
        const blocks: Block[] = [
            { type: "p", text: "React hooks are great.", index: 0, headingPath: [] },
        ];

        const sentences = segmentBlocks(blocks);

        // Should have stemmed, stop-word-filtered tokens
        expect(sentences[0]?.tokens).toContain("react");
        expect(sentences[0]?.tokens).toContain("hook");
        expect(sentences[0]?.tokens).toContain("great");
        // "are" is a stop word and should be filtered
        expect(sentences[0]?.tokens).not.toContain("are");
    });

    it("cleans code block artifacts", () => {
        const blocks: Block[] = [
            { type: "pre", text: "const x = 1; Try", index: 0, headingPath: [] },
        ];

        const sentences = segmentBlocks(blocks);

        // "Try" button text should be cleaned
        expect(sentences[0]?.text).not.toContain("Try");
        expect(sentences[0]?.text).toContain("const x = 1;");
    });
});

describe("segmentHtml", () => {
    it("performs full segmentation pipeline", () => {
        const $ = cheerio.load(`
            <main>
                <h1>React Hooks</h1>
                <p>Hooks are functions. They let you use state.</p>
                <h2>useState</h2>
                <p>useState is the most common hook.</p>
            </main>
        `);

        const result = segmentHtml($, $("main"));

        expect(result.blocks.length).toBeGreaterThan(0);
        expect(result.sentences.length).toBeGreaterThan(0);

        // Check heading path is tracked
        const useStateHeading = result.sentences.find(s => s.text === "useState");
        expect(useStateHeading?.headingPath).toEqual(["React Hooks"]);

        const useStateParagraph = result.sentences.find(s =>
            s.text.includes("most common hook")
        );
        expect(useStateParagraph?.headingPath).toEqual(["React Hooks", "useState"]);
    });

    it("handles empty container", () => {
        const $ = cheerio.load(`<main></main>`);

        const result = segmentHtml($, $("main"));

        expect(result.blocks).toEqual([]);
        expect(result.sentences).toEqual([]);
    });

    it("respects tokenize options", () => {
        const $ = cheerio.load(`<main><p>React hooks.</p></main>`);

        const withStemming = segmentHtml($, $("main"));
        const withoutStemming = segmentHtml($, $("main"), {
            tokenizeOptions: { applyStemming: false },
        });

        // With stemming: "hooks" -> "hook"
        expect(withStemming.sentences[0]?.tokens).toContain("hook");
        // Without stemming: "hooks" stays "hooks"
        expect(withoutStemming.sentences[0]?.tokens).toContain("hooks");
    });
});
