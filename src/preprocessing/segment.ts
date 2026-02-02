import type * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type { Block, BlockType, Sentence } from "../types";
import { tokenize } from "./tokenize";
import { isHeadingTag, getHeadingLevel } from "../utils/shared";

/**
 * Check if a tag name is a block-level element we care about
 */
function isBlockTag(tagName: string): tagName is BlockType {
    return isHeadingTag(tagName) || tagName === "p" || tagName === "li" || tagName === "pre";
}

/**
 * Extract text from a code block, preserving line breaks
 * Handles various structures: plain pre, div.line per line, br tags, etc.
 */
function extractCodeText(
    $: cheerio.CheerioAPI,
    $pre: cheerio.Cheerio<AnyNode>
): string {
    // Check for line-based structure (e.g., TypeScript docs use div.line)
    const $lines = $pre.find(".line, .code-line, [class*='line']");

    if ($lines.length > 0) {
        // Extract text from each line element and join with newlines
        const lines: string[] = [];
        $lines.each((_, el) => {
            const lineText = $(el).text().trim();
            if (lineText.length > 0) {
                lines.push(lineText);
            }
        });
        return lines.join("\n").trim();
    }

    // Check for <br> tags (some sites use these for line breaks)
    const html = $pre.html() ?? "";
    if (html.includes("<br")) {
        // Replace br tags with newlines, then extract text
        const withNewlines = html.replace(/<br\s*\/?>/gi, "\n");
        const $temp = $.load(`<div>${withNewlines}</div>`);
        return $temp("div").text().trim();
    }

    // Fallback: just get the text and preserve existing whitespace
    const rawText = $pre.text() ?? "";
    return rawText.trim();
}

/**
 * Walk the DOM tree and extract blocks with heading path tracking
 */
function walk(
    $: cheerio.CheerioAPI,
    $node: cheerio.Cheerio<AnyNode>,
    path: string[],
    blocks: Block[],
    indexRef: { current: number },
    skipNav: boolean,
): void {
    if (skipNav && $node.is("nav")) return;

    const rawTag = $node.prop("tagName");
    const tagName = typeof rawTag === "string" ? rawTag.toLowerCase() : "";

    if (tagName !== "" && isBlockTag(tagName)) {
        let text: string;

        if (tagName === "pre") {
            // For code blocks, extract text with line breaks preserved
            // Many sites use <div class="line"> or similar for each code line
            text = extractCodeText($, $node);
        } else {
            const rawText = $node.text() ?? "";
            text = rawText.replace(/\s+/g, " ").trim();
        }

        // Skip empty blocks
        if (text.length === 0) return;

        // For headings, truncate path to parent level BEFORE capturing headingPath
        // This ensures a heading only has its ancestors in the path, not siblings
        if (isHeadingTag(tagName)) {
            const level = getHeadingLevel(tagName) ?? 1;
            const targetLength = level - 1;
            if (targetLength < path.length) {
                path.length = targetLength;
            }
        }

        blocks.push({
            type: tagName,
            text,
            index: indexRef.current++,
            headingPath: [...path],
        });

        // Add heading text to path for subsequent blocks
        if (isHeadingTag(tagName)) {
            path.push(text);
        }
        return;
    }

    $node.children().each((_, child) => {
        if (child.type === "tag") {
            walk($, $(child), path, blocks, indexRef, skipNav);
        }
    });
}

/**
 * Extract blocks from a container element
 */
export function extractBlocks(
    $: cheerio.CheerioAPI,
    container: cheerio.Cheerio<AnyNode>,
    options: { skipNav?: boolean } = {},
): Block[] {
    const { skipNav = true } = options;
    const blocks: Block[] = [];
    const path: string[] = [];
    const indexRef = { current: 0 };
    walk($, container, path, blocks, indexRef, skipNav);
    return blocks;
}

// Sentence boundary patterns
// Match: period/exclamation/question followed by space and capital letter (or end)
// Handle common abbreviations
const ABBREVIATIONS = new Set([
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "vs", "etc", "inc", "ltd",
    "st", "ave", "blvd", "rd", "e.g", "i.e", "cf", "al", "fig", "vol", "no",
]);

/**
 * Patterns to clean from code blocks (playground links, copy buttons, etc.)
 */
const CODE_BLOCK_CLEANUP_PATTERNS = [
    /\s*(Try|Run|Copy)\s*$/,         // Button text with optional whitespace
    /Open in (Playground|CodeSandbox|StackBlitz)$/i,
    /(Edit|View) on GitHub$/i,
];

/**
 * Clean artifacts from code block text
 */
function cleanCodeBlock(text: string): string {
    let cleaned = text;
    for (const pattern of CODE_BLOCK_CLEANUP_PATTERNS) {
        cleaned = cleaned.replace(pattern, "");
    }
    return cleaned.trim();
}

/**
 * Split text into sentences using regex heuristics
 */
export function splitIntoSentences(text: string): string[] {
    if (text.length === 0) return [];

    // Normalize whitespace
    const normalized = text.replace(/\s+/g, " ").trim();

    // Split on sentence boundaries
    // Pattern: sentence-ending punctuation followed by space and uppercase
    const sentences: string[] = [];
    let current = "";
    let i = 0;

    while (i < normalized.length) {
        const char = normalized[i];
        current += char;

        // Check for sentence boundary
        if (char === "." || char === "!" || char === "?") {
            // Look ahead for space + uppercase or end of string
            const nextChar = normalized[i + 1];
            const afterNext = normalized[i + 2];

            if (nextChar === undefined) {
                // End of string - this is a sentence
                const trimmed = current.trim();
                if (trimmed.length > 0) {
                    sentences.push(trimmed);
                }
                current = "";
            } else if (nextChar === " " && afterNext !== undefined && /[A-Z]/.test(afterNext)) {
                // Check if this is an abbreviation
                const wordMatch = current.match(/(\w+)\.$/);
                const word = wordMatch?.[1]?.toLowerCase() ?? "";

                if (!ABBREVIATIONS.has(word)) {
                    // This is a sentence boundary
                    const trimmed = current.trim();
                    if (trimmed.length > 0) {
                        sentences.push(trimmed);
                    }
                    current = "";
                    i++; // Skip the space
                }
            }
        }

        i++;
    }

    // Don't forget the last part
    const trimmed = current.trim();
    if (trimmed.length > 0) {
        sentences.push(trimmed);
    }

    return sentences;
}

/**
 * Segment blocks into sentences with full metadata
 */
export function segmentBlocks(
    blocks: Block[],
    options: { tokenizeOptions?: Parameters<typeof tokenize>[1] } = {}
): Sentence[] {
    const { tokenizeOptions } = options;
    const sentences: Sentence[] = [];
    let globalIndex = 0;
    const totalBlocks = blocks.length;

    for (const block of blocks) {
        // For headings and code blocks, treat the whole block as one "sentence"
        const isHeading = isHeadingTag(block.type);
        const isCode = block.type === "pre";

        // Clean code blocks of playground artifacts
        const blockText = isCode ? cleanCodeBlock(block.text) : block.text;

        const blockSentences = (isHeading || isCode)
            ? [blockText]
            : splitIntoSentences(blockText);

        for (let sentenceIndex = 0; sentenceIndex < blockSentences.length; sentenceIndex++) {
            const text = blockSentences[sentenceIndex];
            if (text === undefined || text.length === 0) continue;

            const tokens = tokenize(text, tokenizeOptions);

            sentences.push({
                text,
                tokens,
                blockIndex: block.index,
                sentenceIndex,
                globalIndex,
                headingPath: block.headingPath,
                position: totalBlocks > 1 ? block.index / (totalBlocks - 1) : 0,
                blockType: block.type,
            });

            globalIndex++;
        }
    }

    return sentences;
}

/**
 * Full segmentation pipeline: extract blocks from HTML container, then segment into sentences
 */
export function segmentHtml(
    $: cheerio.CheerioAPI,
    container: cheerio.Cheerio<AnyNode>,
    options: {
        skipNav?: boolean;
        tokenizeOptions?: Parameters<typeof tokenize>[1];
    } = {}
): { blocks: Block[]; sentences: Sentence[] } {
    const { skipNav = true, tokenizeOptions } = options;

    const blocks = extractBlocks($, container, { skipNav });
    const sentences = segmentBlocks(blocks, { tokenizeOptions });

    return { blocks, sentences };
}
