import type { Chunk, Excerpt, ExtractionResult } from "../types";

export interface ExcerptConfig {
    maxExcerpts?: number;
    charBudget?: number;
    minExcerptChars?: number;
}

const DEFAULT_CONFIG: Required<ExcerptConfig> = {
    maxExcerpts: 3,
    charBudget: 2000,
    minExcerptChars: 50,
};

/**
 * Convert a chunk to an excerpt
 */
function chunkToExcerpt(chunk: Chunk): Excerpt {
    return {
        text: chunk.text,
        headingPath: chunk.headingPath,
        score: chunk.score,
        charCount: chunk.charCount,
    };
}

/**
 * Assemble final excerpts from deduplicated chunks
 * Uses greedy selection to maximize coverage within budget
 */
export function assembleExcerpts(
    chunks: Chunk[],
    query: string,
    config: ExcerptConfig = {}
): ExtractionResult {
    const {
        maxExcerpts = DEFAULT_CONFIG.maxExcerpts,
        charBudget = DEFAULT_CONFIG.charBudget,
        minExcerptChars = DEFAULT_CONFIG.minExcerptChars,
    } = config;

    // Chunks should already be sorted by score; tie-break by anchorIndex for determinism
    const sorted = [...chunks].sort((a, b) => {
        const d = b.score - a.score;
        if (d !== 0) return d;
        return a.anchorIndex - b.anchorIndex;
    });

    const excerpts: Excerpt[] = [];
    let totalChars = 0;

    for (const chunk of sorted) {
        // Skip tiny chunks
        if (chunk.charCount < minExcerptChars) {
            continue;
        }

        // Check if we can fit this chunk
        if (totalChars + chunk.charCount > charBudget) {
            continue;
        }

        // Check max excerpts
        if (excerpts.length >= maxExcerpts) {
            break;
        }

        excerpts.push(chunkToExcerpt(chunk));
        totalChars += chunk.charCount;
    }

    return {
        excerpts,
        totalChars,
        query,
    };
}

/**
 * Format excerpts for display
 */
export function formatExcerpts(result: ExtractionResult): string {
    const lines: string[] = [];

    lines.push(`Query: "${result.query}"`);
    lines.push(`Total characters: ${result.totalChars}`);
    lines.push("");

    for (let i = 0; i < result.excerpts.length; i++) {
        const excerpt = result.excerpts[i];
        if (excerpt === undefined) continue;

        lines.push(`--- Excerpt ${i + 1} (score: ${excerpt.score.toFixed(3)}, ${excerpt.charCount} chars) ---`);

        if (excerpt.headingPath.length > 0) {
            lines.push(`[${excerpt.headingPath.join(" > ")}]`);
        }

        lines.push(excerpt.text);
        lines.push("");
    }

    return lines.join("\n");
}
