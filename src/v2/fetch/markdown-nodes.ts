/**
 * Small, local markdown-to-DocNode[] converter.
 *
 * Used by the markdown adapter (doc sites that serve a clean `.md` sibling)
 * and by the GitHub adapter (README files, and issue/comment bodies, which
 * GitHub's API returns as raw GFM markdown text rather than HTML). A
 * line-based parser is enough for the CommonMark subset doc sites and GitHub
 * actually use: headings, fenced code, block quotes, list items, GFM tables,
 * and paragraphs.
 */

import type { DocNode, NodeKind } from "../types";

export interface MarkdownNodesOptions {
    baseHeadingPath?: string[];
    startOrder?: number;
}

function isTableRow(line: string): boolean {
    return line.trim().startsWith("|") || (line.includes("|") && /^[\s|:-]+$/.test(line) === false && line.split("|").length > 2);
}

function isTableSeparator(line: string): boolean {
    return /^\s*\|?[\s:-]+\|[\s:|:-]*\|?\s*$/.test(line) && line.includes("-");
}

function pushNode(
    nodes: DocNode[],
    orderRef: { current: number },
    kind: NodeKind,
    text: string,
    path: string[],
    extra: Partial<Omit<DocNode, "kind" | "text" | "order" | "headingPath">> = {}
): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    nodes.push({
        kind,
        text: trimmed,
        order: orderRef.current++,
        headingPath: [...path],
        ...extra,
    });
}

export function markdownToNodes(markdown: string, options: MarkdownNodesOptions = {}): DocNode[] {
    const nodes: DocNode[] = [];
    const path: string[] = options.baseHeadingPath !== undefined ? [...options.baseHeadingPath] : [];
    const orderRef = { current: options.startOrder ?? 0 };

    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    let i = 0;
    let paragraphBuf: string[] = [];
    let quoteBuf: string[] = [];

    const flushParagraph = (): void => {
        if (paragraphBuf.length === 0) return;
        pushNode(nodes, orderRef, "prose", paragraphBuf.join(" "), path);
        paragraphBuf = [];
    };
    const flushQuote = (): void => {
        if (quoteBuf.length === 0) return;
        pushNode(nodes, orderRef, "quote", quoteBuf.join(" "), path);
        quoteBuf = [];
    };

    while (i < lines.length) {
        const rawLine = lines[i] ?? "";
        const line = rawLine;

        // Fenced code block
        const fenceMatch = /^\s*(```|~~~)(\S*)\s*$/.exec(line);
        if (fenceMatch !== null) {
            flushParagraph();
            flushQuote();
            const fence = fenceMatch[1] as string;
            const lang = fenceMatch[2] !== undefined && fenceMatch[2].length > 0 ? fenceMatch[2] : undefined;
            const codeLines: string[] = [];
            i++;
            while (i < lines.length) {
                const l = lines[i] ?? "";
                if (new RegExp(`^\\s*${fence}\\s*$`).test(l)) {
                    i++;
                    break;
                }
                codeLines.push(l);
                i++;
            }
            pushNode(nodes, orderRef, "code", codeLines.join("\n"), path, lang !== undefined ? { lang } : {});
            continue;
        }

        // Heading
        const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (headingMatch !== null) {
            flushParagraph();
            flushQuote();
            const level = (headingMatch[1] as string).length;
            const text = (headingMatch[2] as string).trim();
            const targetLength = level - 1;
            if (targetLength < path.length) path.length = targetLength;
            pushNode(nodes, orderRef, "heading", text, path, { level });
            if (text.length > 0) path.push(text);
            i++;
            continue;
        }

        // Block quote (accumulate consecutive '>' lines)
        if (/^\s*>\s?/.test(line)) {
            flushParagraph();
            quoteBuf.push(line.replace(/^\s*>\s?/, ""));
            i++;
            continue;
        }
        flushQuote();

        // GFM table: a header row, a separator row, then data rows
        if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? "")) {
            flushParagraph();
            const tableLines: string[] = [line];
            i += 2; // skip header + separator in output, but keep header text
            while (i < lines.length && isTableRow(lines[i] ?? "")) {
                tableLines.push(lines[i] as string);
                i++;
            }
            const text = tableLines
                .map((l) =>
                    l
                        .split("|")
                        .map((cell) => cell.trim())
                        .filter((cell) => cell.length > 0)
                        .join(" | ")
                )
                .join("\n");
            pushNode(nodes, orderRef, "table", text, path);
            continue;
        }

        // List item (single-line bullet or ordered item)
        const listMatch = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
        if (listMatch !== null) {
            flushParagraph();
            pushNode(nodes, orderRef, "list-item", (listMatch[1] as string).trim(), path);
            i++;
            continue;
        }

        // Blank line: paragraph boundary
        if (line.trim().length === 0) {
            flushParagraph();
            i++;
            continue;
        }

        // Plain text line: accumulate into current paragraph
        paragraphBuf.push(line.trim());
        i++;
    }

    flushParagraph();
    flushQuote();

    return nodes;
}
