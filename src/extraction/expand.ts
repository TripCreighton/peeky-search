import type { Chunk, Sentence, ScoredSentence } from "../types";
import { isHeadingTag, getHeadingLevel } from "../utils/shared";

/** Multiplier for allowing code blocks to exceed the char budget */
const CODE_BLOCK_OVERAGE_MULTIPLIER = 1.5;

/**
 * Build formatted text from a sequence of sentences
 * Applies proper formatting: headings get newlines, code gets fences, lists get bullets
 */
export function buildChunkText(sentences: Sentence[]): string {
    const textParts: string[] = [];
    let lastBlockType = "";

    for (const s of sentences) {
        // Add newlines before headings and code blocks for readability
        if (isHeadingTag(s.blockType) && textParts.length > 0) {
            textParts.push("\n\n" + s.text);
        } else if (s.blockType === "pre") {
            textParts.push("\n\n```\n" + s.text + "\n```");
        } else if (s.blockType === "li") {
            // Format list items
            if (lastBlockType !== "li") {
                textParts.push("\n");
            }
            textParts.push("\n- " + s.text);
        } else {
            if (lastBlockType === "pre" || isHeadingTag(lastBlockType)) {
                textParts.push("\n\n" + s.text);
            } else if (textParts.length > 0) {
                textParts.push(" " + s.text);
            } else {
                textParts.push(s.text);
            }
        }
        lastBlockType = s.blockType;
    }

    return textParts.join("").trim();
}

export interface ExpandConfig {
    contextBefore?: number;
    contextAfter?: number;
    respectBlockBoundaries?: boolean;
    maxChunkChars?: number;
    includeCodeBlocks?: boolean;
    expandToSection?: boolean;
}

const DEFAULT_CONFIG: Required<ExpandConfig> = {
    contextBefore: 5,
    contextAfter: 8,
    respectBlockBoundaries: false,
    maxChunkChars: 2000,
    includeCodeBlocks: true,
    expandToSection: true,
};

/**
 * Find the section boundaries for a sentence (from its heading to the next heading of same or higher level)
 */
function findSectionBoundaries(
    anchorIndex: number,
    allSentences: Sentence[],
    maxChars: number
): { start: number; end: number } {
    const anchor = allSentences[anchorIndex];
    if (anchor === undefined) {
        return { start: anchorIndex, end: anchorIndex };
    }

    // Find the heading level of the current section
    let sectionHeadingLevel = 6; // Default to lowest
    let sectionStart = anchorIndex;

    // Look backward to find the section heading
    for (let i = anchorIndex; i >= 0; i--) {
        const s = allSentences[i];
        if (s === undefined) continue;

        if (isHeadingTag(s.blockType)) {
            sectionHeadingLevel = getHeadingLevel(s.blockType) ?? 6;
            sectionStart = i;
            break;
        }
    }

    // Look forward to find where the section ends (next heading of same or higher level)
    let sectionEnd = allSentences.length - 1;
    for (let i = anchorIndex + 1; i < allSentences.length; i++) {
        const s = allSentences[i];
        if (s === undefined) continue;

        if (isHeadingTag(s.blockType)) {
            const level = getHeadingLevel(s.blockType) ?? 6;
            if (level <= sectionHeadingLevel) {
                sectionEnd = i - 1;
                break;
            }
        }
    }

    // Trim to character budget
    let charCount = 0;
    let actualStart = sectionStart;
    let actualEnd = sectionEnd;

    // First pass: count total chars
    for (let i = sectionStart; i <= sectionEnd; i++) {
        const s = allSentences[i];
        if (s !== undefined) {
            charCount += s.text.length + 1; // +1 for space/newline
        }
    }

    // If under budget, return full section
    if (charCount <= maxChars) {
        return { start: sectionStart, end: sectionEnd };
    }

    // Otherwise, center around anchor and trim
    charCount = allSentences[anchorIndex]?.text.length ?? 0;
    actualStart = anchorIndex;
    actualEnd = anchorIndex;

    // Expand outward alternating before/after
    let canExpandBefore = actualStart > sectionStart;
    let canExpandAfter = actualEnd < sectionEnd;

    while ((canExpandBefore || canExpandAfter) && charCount < maxChars) {
        // Try expanding before
        if (canExpandBefore) {
            const prev = allSentences[actualStart - 1];
            if (prev && charCount + prev.text.length < maxChars) {
                actualStart--;
                charCount += prev.text.length + 1;
                canExpandBefore = actualStart > sectionStart;
            } else {
                canExpandBefore = false;
            }
        }

        // Try expanding after
        if (canExpandAfter && charCount < maxChars) {
            const next = allSentences[actualEnd + 1];
            if (next && charCount + next.text.length < maxChars) {
                actualEnd++;
                charCount += next.text.length + 1;
                canExpandAfter = actualEnd < sectionEnd;
            } else {
                canExpandAfter = false;
            }
        }
    }

    return { start: actualStart, end: actualEnd };
}

/**
 * Expand forward to include any code blocks that immediately follow
 */
function expandToIncludeCode(
    endIndex: number,
    allSentences: Sentence[],
    maxChars: number,
    currentChars: number
): number {
    let newEnd = endIndex;
    let chars = currentChars;

    for (let i = endIndex + 1; i < allSentences.length; i++) {
        const s = allSentences[i];
        if (s === undefined) break;

        // Stop if we hit a heading
        if (isHeadingTag(s.blockType)) {
            break;
        }

        // Include code blocks even if they're larger
        if (s.blockType === "pre") {
            if (chars + s.text.length <= maxChars * CODE_BLOCK_OVERAGE_MULTIPLIER) {
                newEnd = i;
                chars += s.text.length;
            }
            break; // Stop after first code block
        }

        // Include list items and paragraphs if they fit
        if (chars + s.text.length <= maxChars) {
            newEnd = i;
            chars += s.text.length;
        } else {
            break;
        }
    }

    return newEnd;
}

/**
 * Expand an anchor sentence into a context chunk
 * Includes surrounding sentences, code blocks, and respects section boundaries
 */
export function expandAnchor(
    anchor: ScoredSentence,
    allSentences: Sentence[],
    config: ExpandConfig = {}
): Chunk {
    const {
        contextBefore = DEFAULT_CONFIG.contextBefore,
        contextAfter = DEFAULT_CONFIG.contextAfter,
        maxChunkChars = DEFAULT_CONFIG.maxChunkChars,
        includeCodeBlocks = DEFAULT_CONFIG.includeCodeBlocks,
        expandToSection = DEFAULT_CONFIG.expandToSection,
    } = config;

    const anchorIndex = anchor.globalIndex;

    let startIndex: number;
    let endIndex: number;

    if (expandToSection) {
        // Use section-aware expansion
        const bounds = findSectionBoundaries(anchorIndex, allSentences, maxChunkChars);
        startIndex = bounds.start;
        endIndex = bounds.end;
    } else {
        // Use simple sentence-count expansion
        startIndex = Math.max(0, anchorIndex - contextBefore);
        endIndex = Math.min(allSentences.length - 1, anchorIndex + contextAfter);

        // Trim to character budget
        let charCount = 0;
        for (let i = startIndex; i <= endIndex; i++) {
            const s = allSentences[i];
            if (s !== undefined) {
                charCount += s.text.length;
            }
        }

        while (charCount > maxChunkChars && startIndex < anchorIndex) {
            const s = allSentences[startIndex];
            if (s !== undefined) {
                charCount -= s.text.length;
            }
            startIndex++;
        }

        while (charCount > maxChunkChars && endIndex > anchorIndex) {
            const s = allSentences[endIndex];
            if (s !== undefined) {
                charCount -= s.text.length;
            }
            endIndex--;
        }
    }

    // Include following code blocks if configured
    if (includeCodeBlocks) {
        let currentChars = 0;
        for (let i = startIndex; i <= endIndex; i++) {
            const s = allSentences[i];
            if (s !== undefined) {
                currentChars += s.text.length;
            }
        }
        endIndex = expandToIncludeCode(endIndex, allSentences, maxChunkChars, currentChars);
    }

    // Collect sentences in the chunk
    const chunkSentences: Sentence[] = [];
    for (let i = startIndex; i <= endIndex; i++) {
        const s = allSentences[i];
        if (s !== undefined) {
            chunkSentences.push(s);
        }
    }

    // Build chunk text with proper formatting
    const text = buildChunkText(chunkSentences);
    const headingPath = anchor.headingPath;

    // Calculate raw content chars (excluding formatting) for budget purposes
    const rawCharCount = chunkSentences.reduce((sum, s) => sum + s.text.length, 0);

    return {
        sentences: chunkSentences,
        anchorIndex: anchor.globalIndex,
        score: anchor.combinedScore,
        text,
        charCount: rawCharCount,  // Use raw content for budget, not formatted text
        headingPath,
    };
}

/**
 * Expand multiple anchors into chunks
 */
export function expandAnchors(
    anchors: ScoredSentence[],
    allSentences: Sentence[],
    config: ExpandConfig = {}
): Chunk[] {
    return anchors.map(anchor => expandAnchor(anchor, allSentences, config));
}

/**
 * Expand anchor with adaptive context
 * Uses more context for short anchors, less for long ones
 */
export function expandAnchorAdaptive(
    anchor: ScoredSentence,
    allSentences: Sentence[],
    targetChunkSize: number = 1500
): Chunk {
    return expandAnchor(anchor, allSentences, {
        maxChunkChars: targetChunkSize,
        includeCodeBlocks: true,
        expandToSection: true,
    });
}
