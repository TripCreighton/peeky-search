import { describe, it, expect } from "vitest";
import { markdownToNodes } from "../../fetch/markdown-nodes";

describe("markdownToNodes", () => {
    it("extracts headings with level and tracks heading path", () => {
        const nodes = markdownToNodes("# Top\n\nIntro text.\n\n## Sub\n\nDetail text.\n");

        const top = nodes.find((n) => n.text === "Top");
        const sub = nodes.find((n) => n.text === "Sub");
        const detail = nodes.find((n) => n.text === "Detail text.");

        expect(top?.kind).toBe("heading");
        expect(top?.level).toBe(1);
        expect(sub?.headingPath).toEqual(["Top"]);
        expect(detail?.headingPath).toEqual(["Top", "Sub"]);
    });

    it("extracts a fenced code block with language", () => {
        const nodes = markdownToNodes("```ts\nconst x = 1;\n```\n");

        const code = nodes.find((n) => n.kind === "code");
        expect(code?.lang).toBe("ts");
        expect(code?.text).toBe("const x = 1;");
    });

    it("extracts a fenced code block with no language", () => {
        const nodes = markdownToNodes("```\nplain\n```\n");

        const code = nodes.find((n) => n.kind === "code");
        expect(code?.lang).toBeUndefined();
        expect(code?.text).toBe("plain");
    });

    it("extracts list items", () => {
        const nodes = markdownToNodes("- First\n- Second\n1. Third\n");

        const items = nodes.filter((n) => n.kind === "list-item");
        expect(items.map((n) => n.text)).toEqual(["First", "Second", "Third"]);
    });

    it("extracts a block quote", () => {
        const nodes = markdownToNodes("> Quoted line one.\n> Quoted line two.\n");

        const quote = nodes.find((n) => n.kind === "quote");
        expect(quote?.text).toContain("Quoted line one.");
        expect(quote?.text).toContain("Quoted line two.");
    });

    it("extracts a GFM table", () => {
        const nodes = markdownToNodes("| A | B |\n| --- | --- |\n| 1 | 2 |\n");

        const table = nodes.find((n) => n.kind === "table");
        expect(table?.text).toContain("A | B");
        expect(table?.text).toContain("1 | 2");
    });

    it("groups consecutive plain lines into one prose node", () => {
        const nodes = markdownToNodes("Line one.\nLine two continues.\n\nNew paragraph.\n");

        const prose = nodes.filter((n) => n.kind === "prose");
        expect(prose.length).toBe(2);
        expect(prose[0]?.text).toBe("Line one. Line two continues.");
        expect(prose[1]?.text).toBe("New paragraph.");
    });

    it("does not treat a code fence's contents as markdown structure", () => {
        const nodes = markdownToNodes("```\n# not a heading\n- not a list item\n```\n");

        expect(nodes.some((n) => n.kind === "heading")).toBe(false);
        expect(nodes.some((n) => n.kind === "list-item")).toBe(false);
        expect(nodes[0]?.kind).toBe("code");
    });

    it("orders nodes densely from a given startOrder", () => {
        const nodes = markdownToNodes("# A\n\nB\n\nC\n", { startOrder: 5 });

        expect(nodes.map((n) => n.order)).toEqual([5, 6, 7]);
    });

    it("returns an empty array for empty input", () => {
        expect(markdownToNodes("")).toEqual([]);
    });
});
