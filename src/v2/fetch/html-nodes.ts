/**
 * Small, local HTML-fragment-to-DocNode[] converter.
 *
 * v1's segmentation (`src/preprocessing/segment.ts`) flattens blocks into flat
 * sentence lists; it does not preserve table/quote/definition/callout
 * structure and it isn't a fragment converter (it wants a whole preprocessed
 * page). This is a standalone helper for source adapters that only ever hand
 * it a body fragment (a Stack Exchange answer, a GitHub issue comment, a raw
 * page's main content). It intentionally does NOT import `src/v2/parse.ts`,
 * which another agent owns concurrently.
 */

import * as cheerio from "cheerio";
import type { AnyNode, Element as CheerioElement } from "domhandler";
import type { DocLink, DocNode, NodeKind } from "../types";

function isElement(node: AnyNode): node is CheerioElement {
    return node.type === "tag";
}

const HEADING_RE = /^h([1-6])$/;
const CALLOUT_PATTERN = /\b(note|warning|tip|caution|important|info|admonition|callout|alert)\b/i;

export interface HtmlNodesOptions {
    /** Ancestor heading path to seed with (nearest last). Defaults to empty. */
    baseHeadingPath?: string[];
    /** Starting `order` value; nodes are numbered densely from here. Defaults to 0. */
    startOrder?: number;
}

interface WalkState {
    order: number;
}

function textOf($: cheerio.CheerioAPI, $el: cheerio.Cheerio<AnyNode>): string {
    return ($el.text() ?? "").replace(/\s+/g, " ").trim();
}

function collectLinks($: cheerio.CheerioAPI, $el: cheerio.Cheerio<AnyNode>): DocLink[] {
    const links: DocLink[] = [];
    $el.find("a[href]").each((_, a) => {
        const href = $(a).attr("href");
        const text = textOf($, $(a));
        if (href !== undefined && href.length > 0 && text.length > 0) {
            links.push({ text, href });
        }
    });
    return links;
}

function extractCodeInfo(
    $: cheerio.CheerioAPI,
    $pre: cheerio.Cheerio<AnyNode>
): { text: string; lang?: string } {
    const $code = $pre.find("code").first();
    const target = $code.length > 0 ? $code : $pre;
    const cls = target.attr("class") ?? "";
    const langMatch = /language-([\w+-]+)/i.exec(cls) ?? /lang-([\w+-]+)/i.exec(cls);
    const lang = langMatch?.[1];

    const html = $pre.html() ?? "";
    let text: string;
    if (html.includes("<br")) {
        const withNewlines = html.replace(/<br\s*\/?>/gi, "\n");
        const $temp = cheerio.load(`<div>${withNewlines}</div>`);
        text = $temp("div").text().trim();
    } else {
        text = ($pre.text() ?? "").trim();
    }

    return lang !== undefined ? { text, lang } : { text };
}

function tableToText($: cheerio.CheerioAPI, $table: cheerio.Cheerio<AnyNode>): string {
    const rows: string[] = [];
    $table.find("tr").each((_, tr) => {
        const cells: string[] = [];
        $(tr)
            .find("th, td")
            .each((_, cell) => {
                cells.push(textOf($, $(cell)));
            });
        if (cells.length > 0) rows.push(cells.join(" | "));
    });
    return rows.join("\n");
}

function isCalloutElement(el: CheerioElement): boolean {
    if (el.tagName?.toLowerCase() === "aside") return true;
    const identifiers = `${el.attribs?.class ?? ""} ${el.attribs?.role ?? ""}`;
    return CALLOUT_PATTERN.test(identifiers);
}

function pushNode(
    nodes: DocNode[],
    state: WalkState,
    kind: NodeKind,
    text: string,
    path: string[],
    extra: Partial<Omit<DocNode, "kind" | "text" | "order" | "headingPath">> = {}
): void {
    if (text.length === 0) return;
    nodes.push({
        kind,
        text,
        order: state.order++,
        headingPath: [...path],
        ...extra,
    });
}

function walk(
    $: cheerio.CheerioAPI,
    $node: cheerio.Cheerio<AnyNode>,
    path: string[],
    nodes: DocNode[],
    state: WalkState
): void {
    const el = $node.get(0);
    if (el === undefined || !isElement(el)) {
        // Text/comment node at the top level: recurse is a no-op, nothing to do.
        return;
    }

    const tagName = el.tagName.toLowerCase();

    const headingMatch = HEADING_RE.exec(tagName);
    if (headingMatch !== null) {
        const level = Number(headingMatch[1]);
        const text = textOf($, $node);
        if (text.length > 0) {
            const targetLength = level - 1;
            if (targetLength < path.length) path.length = targetLength;
            const links = collectLinks($, $node);
            pushNode(nodes, state, "heading", text, path, {
                level,
                ...(links.length > 0 ? { links } : {}),
            });
            path.push(text);
        }
        return;
    }

    if (tagName === "pre") {
        const { text, lang } = extractCodeInfo($, $node);
        if (text.length > 0) {
            pushNode(nodes, state, "code", text, path, lang !== undefined ? { lang } : {});
        }
        return;
    }

    if (tagName === "blockquote") {
        const text = textOf($, $node);
        pushNode(nodes, state, "quote", text, path);
        return;
    }

    if (tagName === "table") {
        const text = tableToText($, $node);
        pushNode(nodes, state, "table", text, path);
        return;
    }

    if (tagName === "dl") {
        $node.children("dt").each((_, dt) => {
            const $dt = $(dt);
            const $dd = $dt.next("dd");
            const term = textOf($, $dt);
            const desc = $dd.length > 0 ? textOf($, $dd) : "";
            const text = desc.length > 0 ? `${term}: ${desc}` : term;
            pushNode(nodes, state, "definition", text, path);
        });
        return;
    }

    if (tagName === "li") {
        const text = textOf($, $node);
        const links = collectLinks($, $node);
        pushNode(nodes, state, "list-item", text, path, links.length > 0 ? { links } : {});
        return;
    }

    if (isCalloutElement(el)) {
        const text = textOf($, $node);
        if (text.length > 0) {
            pushNode(nodes, state, "callout", text, path);
            return;
        }
    }

    if (tagName === "p") {
        const text = textOf($, $node);
        const links = collectLinks($, $node);
        pushNode(nodes, state, "prose", text, path, links.length > 0 ? { links } : {});
        return;
    }

    // Container: recurse into element children only.
    $node.children().each((_, child) => {
        if (child.type === "tag") {
            walk($, $(child), path, nodes, state);
        }
    });
}

/**
 * Convert an HTML fragment's DOM subtree into a flat, ordered DocNode list.
 */
export function htmlToNodes(
    $: cheerio.CheerioAPI,
    container: cheerio.Cheerio<AnyNode>,
    options: HtmlNodesOptions = {}
): DocNode[] {
    const nodes: DocNode[] = [];
    const path: string[] = options.baseHeadingPath !== undefined ? [...options.baseHeadingPath] : [];
    const state: WalkState = { order: options.startOrder ?? 0 };

    container.children().each((_, child) => {
        if (child.type === "tag") {
            walk($, $(child), path, nodes, state);
        }
    });

    return nodes;
}

/**
 * Convenience wrapper: load a standalone HTML string as a fragment and convert it.
 */
export function htmlFragmentToNodes(html: string, options: HtmlNodesOptions = {}): DocNode[] {
    const $ = cheerio.load(`<div id="peeky-root">${html}</div>`);
    return htmlToNodes($, $("#peeky-root"), options);
}

/** Strip all tags from an HTML string, collapsing whitespace. Fallback when structural conversion yields nothing. */
export function htmlToPlainText(html: string): string {
    const $ = cheerio.load(`<div id="peeky-root">${html}</div>`);
    return ($("#peeky-root").text() ?? "").replace(/\s+/g, " ").trim();
}
