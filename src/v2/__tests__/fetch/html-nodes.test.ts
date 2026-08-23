import { describe, it, expect } from "vitest";
import { htmlFragmentToNodes, htmlToPlainText } from "../../fetch/html-nodes";

describe("htmlFragmentToNodes", () => {
    it("converts headings with correct level and heading path tracking", () => {
        const nodes = htmlFragmentToNodes("<h1>Top</h1><p>Intro</p><h2>Sub</h2><p>Detail</p>");

        const heading1 = nodes.find((n) => n.text === "Top");
        const heading2 = nodes.find((n) => n.text === "Sub");
        const detail = nodes.find((n) => n.text === "Detail");

        expect(heading1?.kind).toBe("heading");
        expect(heading1?.level).toBe(1);
        expect(heading2?.headingPath).toEqual(["Top"]);
        expect(detail?.headingPath).toEqual(["Top", "Sub"]);
    });

    it("extracts a code block with its language", () => {
        const nodes = htmlFragmentToNodes('<pre><code class="language-python">print(1)</code></pre>');

        const code = nodes.find((n) => n.kind === "code");
        expect(code?.lang).toBe("python");
        expect(code?.text).toContain("print(1)");
    });

    it("extracts list items", () => {
        const nodes = htmlFragmentToNodes("<ul><li>First</li><li>Second</li></ul>");

        const items = nodes.filter((n) => n.kind === "list-item");
        expect(items.map((n) => n.text)).toEqual(["First", "Second"]);
    });

    it("extracts a table as row-joined text", () => {
        const nodes = htmlFragmentToNodes("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>");

        const table = nodes.find((n) => n.kind === "table");
        expect(table?.text).toContain("A | B");
        expect(table?.text).toContain("1 | 2");
    });

    it("extracts a blockquote", () => {
        const nodes = htmlFragmentToNodes("<blockquote>Quoted text.</blockquote>");

        expect(nodes[0]?.kind).toBe("quote");
        expect(nodes[0]?.text).toBe("Quoted text.");
    });

    it("extracts a definition list as term: description", () => {
        const nodes = htmlFragmentToNodes("<dl><dt>Term</dt><dd>Description.</dd></dl>");

        expect(nodes[0]?.kind).toBe("definition");
        expect(nodes[0]?.text).toBe("Term: Description.");
    });

    it("detects a callout by class name", () => {
        const nodes = htmlFragmentToNodes('<div class="callout-warning">Be careful.</div>');

        expect(nodes[0]?.kind).toBe("callout");
    });

    it("treats <aside> as a callout", () => {
        const nodes = htmlFragmentToNodes("<aside>Side note.</aside>");

        expect(nodes[0]?.kind).toBe("callout");
    });

    it("orders nodes densely from 0", () => {
        const nodes = htmlFragmentToNodes("<h1>A</h1><p>B</p><p>C</p>");

        expect(nodes.map((n) => n.order)).toEqual([0, 1, 2]);
    });

    it("collects links on paragraph nodes", () => {
        const nodes = htmlFragmentToNodes('<p>See <a href="https://example.com">the docs</a>.</p>');

        expect(nodes[0]?.links).toEqual([{ text: "the docs", href: "https://example.com" }]);
    });
});

describe("htmlToPlainText", () => {
    it("strips tags and collapses whitespace", () => {
        expect(htmlToPlainText("<p>Hello   <b>world</b>.</p>")).toBe("Hello world.");
    });
});
