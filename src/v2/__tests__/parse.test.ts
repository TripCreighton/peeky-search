import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHtml } from "../parse";
import { preprocessHtml } from "../../preprocessing/strip";
import { extractBlocks } from "../../preprocessing/segment";

const FIXTURES = join(process.cwd(), "test-fixtures");
const CORPUS = join(process.cwd(), "eval", "corpus", "pages");

/** A cached real-world page: `{url, status, contentType, html, error}`. */
interface CorpusPage {
    url: string;
    html: string;
}

function loadCorpusPage(id: string): CorpusPage {
    return JSON.parse(readFileSync(join(CORPUS, `${id}.json`), "utf-8")) as CorpusPage;
}

function loadFixture(name: string): string {
    return readFileSync(join(FIXTURES, name), "utf-8");
}

/** Real cached pages, chosen to cover the three shapes v1 handles worst. */
const CORPUS_IDS = {
    /** GitHub discussion: Q&A shape with an accepted answer and a Rust code block. */
    qa: "2328eb8c03f967d540ec711feb7b4720d2311a26",
    /** w3schools CSS property page: API reference with parameter tables. */
    reference: "ea40de9572d79e003ad2f2a58e8ae47aaa077b2d",
    /** Content-farm listicle with an `article:published_time`. */
    listicle: "fa9987ab48a2500a49b2eaea444d613416dd08b3",
    /** Article whose ten-comment discussion lives in `comments__list-item` elements. */
    discussion: "63a205eb79332949f0a0ff2afeb06c6106b52e05",
} as const;

describe("parseHtml: document metadata", () => {
    it("records the source, url and title", () => {
        const html = "<html lang='en-GB'><head><title>  Widget   Guide </title></head><body><p>Body text here.</p></body></html>";

        const doc = parseHtml(html, "https://example.com/widgets");

        expect(doc.source).toBe("html");
        expect(doc.url).toBe("https://example.com/widgets");
        expect(doc.title).toBe("Widget Guide");
        expect(doc.lang).toBe("en-gb");
    });

    it("falls back to og:title then h1 when there is no title tag", () => {
        const og = parseHtml('<html><head><meta property="og:title" content="From OG"></head><body><p>x</p></body></html>', "https://e.com/");
        const h1 = parseHtml("<html><body><h1>From H1</h1><p>x</p></body></html>", "https://e.com/");

        expect(og.title).toBe("From OG");
        expect(h1.title).toBe("From H1");
    });

    it("records finalUrl only when it differs from the requested url", () => {
        const same = parseHtml("<p>x</p>", "https://e.com/a", { finalUrl: "https://e.com/a" });
        const moved = parseHtml("<p>x</p>", "https://e.com/a", { finalUrl: "https://e.com/b" });

        expect(same.finalUrl).toBeUndefined();
        expect(moved.finalUrl).toBe("https://e.com/b");
    });

    it("reads publishedAt from article:published_time", () => {
        const html = '<html><head><meta property="article:published_time" content="2024-04-11T22:26:36+00:00"></head><body><p>x</p></body></html>';

        const doc = parseHtml(html, "https://e.com/");

        expect(doc.publishedAt).toBe("2024-04-11T22:26:36.000Z");
    });

    it("reads publishedAt from JSON-LD datePublished", () => {
        const html = `<html><head><script type="application/ld+json">
            {"@context":"https://schema.org","@type":"BlogPosting","datePublished":"2023-01-05"}
        </script></head><body><p>x</p></body></html>`;

        const doc = parseHtml(html, "https://e.com/");

        expect(doc.publishedAt?.slice(0, 10)).toBe("2023-01-05");
    });

    it("reads publishedAt from a <time datetime> element", () => {
        const html = "<html><body><time datetime='2022-09-30T12:00:00Z'>Sept 30</time><p>x</p></body></html>";

        const doc = parseHtml(html, "https://e.com/");

        expect(doc.publishedAt).toBe("2022-09-30T12:00:00.000Z");
    });

    it("ignores an unparseable date rather than inventing one", () => {
        const html = '<html><head><meta property="article:published_time" content="soon"></head><body><p>x</p></body></html>';

        expect(parseHtml(html, "https://e.com/").publishedAt).toBeUndefined();
    });
});

describe("parseHtml: heading paths", () => {
    let doc: ReturnType<typeof parseHtml>;

    beforeAll(() => {
        doc = parseHtml(loadFixture("nested-headings.html"), "https://example.com/db");
    });

    it("gives a heading only its ancestors, never its siblings", () => {
        const atomic = doc.nodes.find((n) => n.kind === "heading" && n.text === "Atomic Values");
        const primary = doc.nodes.find((n) => n.kind === "heading" && n.text === "Primary Keys");

        expect(atomic?.headingPath).toEqual(["Database Design Principles", "Normalization", "First Normal Form"]);
        expect(primary?.headingPath).toEqual(["Database Design Principles", "Normalization", "First Normal Form"]);
    });

    it("truncates the path when the heading level goes back up", () => {
        const indexing = doc.nodes.find((n) => n.kind === "heading" && n.text === "Indexing Strategies");
        const bTree = doc.nodes.find((n) => n.kind === "heading" && n.text === "B-Tree Indexes");

        expect(indexing?.headingPath).toEqual(["Database Design Principles"]);
        expect(bTree?.headingPath).toEqual(["Database Design Principles", "Indexing Strategies"]);
    });

    it("puts body content under the full path including its own heading", () => {
        const prose = doc.nodes.find((n) => n.text.startsWith("An atomic value is one that cannot"));

        expect(prose?.headingPath).toEqual([
            "Database Design Principles",
            "Normalization",
            "First Normal Form",
            "Atomic Values",
        ]);
    });

    it("records the heading level and dense document order", () => {
        const headings = doc.nodes.filter((n) => n.kind === "heading");
        expect(headings.every((h) => h.level !== undefined && h.level >= 1 && h.level <= 6)).toBe(true);
        expect(doc.nodes.map((n) => n.order)).toEqual(doc.nodes.map((_, i) => i));
    });

    it("strips the permalink glyph documentation generators append to headings", () => {
        const html = '<body><h1 id="x">Graceful Shutdown<a class="headerlink" href="#x" title="Permanent link">#</a></h1><p>Body.</p></body>';

        const parsed = parseHtml(html, "https://e.com/");

        expect(parsed.nodes[0]?.text).toBe("Graceful Shutdown");
    });
});

describe("parseHtml: code blocks", () => {
    it("preserves line breaks inside a pre", () => {
        const doc = parseHtml(loadFixture("basic-article.html"), "https://example.com/hooks");
        const code = doc.nodes.find((n) => n.kind === "code");

        expect(code).toBeDefined();
        expect(code?.text.split("\n").length).toBeGreaterThan(2);
        expect(code?.text).toContain("const [count, setCount] = useState(0);");
    });

    it("reassembles a div-per-line code block that has no <pre> at all", () => {
        const doc = parseHtml(loadFixture("code-documentation.html"), "https://example.com/tsconfig");
        const divCode = doc.nodes.find((n) => n.kind === "code" && n.text.includes("moduleResolution"));

        expect(divCode).toBeDefined();
        expect(divCode?.text.split("\n")).toEqual([
            '  "moduleResolution": "NodeNext",',
            '  "module": "NodeNext",',
            '  "target": "ESNext"',
        ]);
    });

    it("turns <br> separators into real line breaks", () => {
        const html = '<body><div class="w3-code">a = 1<br>b = 2<br>c = 3</div></body>';

        const doc = parseHtml(html, "https://e.com/");

        expect(doc.nodes[0]?.kind).toBe("code");
        expect(doc.nodes[0]?.text.split("\n").map((l) => l.trim())).toEqual(["a = 1", "b = 2", "c = 3"]);
    });

    it.each([
        ['<pre><code class="language-typescript">const a = 1;</code></pre>', "typescript"],
        ['<pre class="lang-rust">fn main() {}</pre>', "rust"],
        ['<pre data-language="python">x = 1</pre>', "python"],
        ['<pre><code class="hljs go">package main</code></pre>', "go"],
        ['<div class="highlight highlight-source-ruby"><pre>puts 1</pre></div>', "ruby"],
    ])("detects the declared language in %s", (markup, expected) => {
        const doc = parseHtml(`<body>${markup}</body>`, "https://e.com/");
        const code = doc.nodes.find((n) => n.kind === "code");

        expect(code?.lang).toBe(expected);
    });

    it("does not mistake a `code-block` wrapper class for a language", () => {
        const doc = parseHtml('<body><div class="code-block"><div class="line">x=1</div><div class="line">y=2</div></div></body>', "https://e.com/");

        expect(doc.nodes[0]?.kind).toBe("code");
        expect(doc.nodes[0]?.lang).toBeUndefined();
    });

    it("recovers code from a line-number table and drops the gutter", () => {
        const html = `<body><div class="language-go highlight"><table class="highlighttable"><tr>
            <td class="linenos"><div class="linenodiv"><pre>1
2</pre></div></td>
            <td class="code"><pre>package main

func main() {}</pre></td></tr></table></div></body>`;

        const doc = parseHtml(html, "https://e.com/");
        const code = doc.nodes.filter((n) => n.kind === "code");

        expect(code).toHaveLength(1);
        expect(code[0]?.lang).toBe("go");
        expect(code[0]?.text).toContain("package main");
        expect(code[0]?.text).not.toMatch(/^\s*1\s*$/m);
    });
});

describe("parseHtml: tables", () => {
    it("renders a table as readable text with its header row retained", () => {
        const html = `<body><table>
            <caption>Options</caption>
            <thead><tr><th>Parameter</th><th>Type</th><th>Default</th></tr></thead>
            <tbody>
              <tr><td>timeout</td><td>number</td><td>5000</td></tr>
              <tr><td>retries</td><td>number</td><td>3</td></tr>
            </tbody>
        </table></body>`;

        const doc = parseHtml(html, "https://e.com/");
        const table = doc.nodes.find((n) => n.kind === "table");

        expect(table).toBeDefined();
        const lines = table?.text.split("\n") ?? [];
        expect(lines[0]).toBe("Options");
        expect(lines[1]).toBe("Parameter | Type | Default");
        expect(lines[2]).toBe("timeout | number | 5000");
        expect(lines[3]).toBe("retries | number | 3");
    });

    it("descends into a layout table rather than emitting it as data", () => {
        const html = "<body><table><tr><td><h2>Section</h2><p>Real prose lives in this layout cell.</p></td></tr></table></body>";

        const doc = parseHtml(html, "https://e.com/");

        expect(doc.nodes.some((n) => n.kind === "table")).toBe(false);
        expect(doc.nodes.find((n) => n.kind === "heading")?.text).toBe("Section");
        expect(doc.nodes.some((n) => n.text.includes("Real prose lives"))).toBe(true);
    });
});

describe("parseHtml: quotes, callouts and definitions", () => {
    it("types blockquotes as quotes", () => {
        const doc = parseHtml("<body><blockquote>Premature optimization is the root of all evil.</blockquote></body>", "https://e.com/");

        expect(doc.nodes[0]?.kind).toBe("quote");
    });

    it.each([
        ["<aside>Heads up: this API is deprecated in v4.</aside>"],
        ['<div class="warning">Heads up: this API is deprecated in v4.</div>'],
        ['<div class="admonition note">Heads up: this API is deprecated in v4.</div>'],
        ['<div role="note">Heads up: this API is deprecated in v4.</div>'],
    ])("types an admonition as a callout: %s", (markup) => {
        const doc = parseHtml(`<body>${markup}</body>`, "https://e.com/");

        expect(doc.nodes[0]?.kind).toBe("callout");
    });

    it("keeps a code block inside a callout as code", () => {
        const html = '<body><div class="tip"><p>Try this instead:</p><pre><code class="language-sh">npm ci</code></pre></div></body>';

        const doc = parseHtml(html, "https://e.com/");

        expect(doc.nodes.map((n) => n.kind)).toEqual(["callout", "code"]);
        expect(doc.nodes[1]?.lang).toBe("sh");
    });

    it("pairs dt with dd into definition nodes", () => {
        const html = "<body><dl><dt>timeout</dt><dd>Milliseconds before giving up.</dd><dt>retries</dt><dd>How many times to try again.</dd></dl></body>";

        const doc = parseHtml(html, "https://e.com/");

        expect(doc.nodes.map((n) => n.kind)).toEqual(["definition", "definition"]);
        expect(doc.nodes[0]?.text).toBe("timeout: Milliseconds before giving up.");
    });

    it("types an API parameter list item as a definition", () => {
        const html = "<body><ul><li><code>signal</code>: an AbortSignal that cancels the request.</li><li>Plain narrative bullet with no leading symbol.</li></ul></body>";

        const doc = parseHtml(html, "https://e.com/");

        expect(doc.nodes[0]?.kind).toBe("definition");
        expect(doc.nodes[1]?.kind).toBe("list-item");
    });

    it("keeps a code block nested inside a list item", () => {
        const html = "<body><ol><li>Install the package:<pre><code>npm i left-pad</code></pre></li></ol></body>";

        const doc = parseHtml(html, "https://e.com/");

        expect(doc.nodes.map((n) => n.kind)).toEqual(["list-item", "code"]);
        expect(doc.nodes[0]?.text).toBe("Install the package:");
        expect(doc.nodes[1]?.text).toBe("npm i left-pad");
    });

    it("keeps a code block nested two wrappers deep in a list item (<li><div><pre>)", () => {
        const html = "<body><ol><li>Install the package:<div class=\"code-wrap\"><pre>npm i left-pad</pre></div></li></ol></body>";

        const doc = parseHtml(html, "https://e.com/");

        expect(doc.nodes.map((n) => n.kind)).toEqual(["list-item", "code"]);
        expect(doc.nodes[0]?.text).toBe("Install the package:");
        expect(doc.nodes[1]?.text).toBe("npm i left-pad");
    });

    it("keeps a code block nested three wrappers deep in a list item (Expressive Code's <li><div><figure><pre>)", () => {
        const html =
            '<body><ol><li>Install the package:<div class="expressive-code"><figure class="frame"><pre>npm i left-pad</pre></figure></div></li></ol></body>';

        const doc = parseHtml(html, "https://e.com/");

        expect(doc.nodes.map((n) => n.kind)).toEqual(["list-item", "code"]);
        expect(doc.nodes[0]?.text).toBe("Install the package:");
        expect(doc.nodes[1]?.text).toBe("npm i left-pad");
    });

    it("keeps a code block nested four wrappers deep in a list item, proving the descent isn't hard-coded to three", () => {
        const html =
            '<body><ol><li>Install the package:<div><div><figure><pre>npm i left-pad</pre></figure></div></div></li></ol></body>';

        const doc = parseHtml(html, "https://e.com/");

        expect(doc.nodes.map((n) => n.kind)).toEqual(["list-item", "code"]);
        expect(doc.nodes[1]?.text).toBe("npm i left-pad");
    });

    it("does not double-emit a wrapper's prose alongside its nested code block", () => {
        const html =
            '<body><ul><li><div class="expressive-code"><p>intro text inside the wrapper</p><figure><pre>const x = 1;</pre></figure></div></li></ul></body>';

        const doc = parseHtml(html, "https://e.com/");

        const introOccurrences = doc.nodes.filter((n) => n.text.includes("intro text inside the wrapper"));
        expect(introOccurrences).toHaveLength(1);
        expect(doc.nodes.map((n) => n.kind)).toEqual(["list-item", "code"]);
        expect(doc.nodes[1]?.text).toBe("const x = 1;");
    });

    it("does not hang or throw on pathologically deep list-item wrappers", () => {
        const depth = 40;
        const opens = "<div>".repeat(depth);
        const closes = "</div>".repeat(depth);
        const html = `<body><ul><li>${opens}<pre>deep code</pre>${closes}</li></ul></body>`;

        expect(() => parseHtml(html, "https://e.com/")).not.toThrow();
    });

    it("recovers Expressive-Code-wrapped samples that v1 drops from a real Docusaurus page", () => {
        const page = loadCorpusPage("e21bb5e839b363ee70c0373ff5f09740e1922bf1"); // expressjs.com/en/guide/migrating-5/
        expect(page.url).toBe("https://expressjs.com/en/guide/migrating-5/");

        const doc = parseHtml(page.html, page.url);
        const fullText = doc.nodes.map((n) => n.text).join("\n");

        expect(fullText).toContain("/discussion/:slug");
    });
});

describe("parseHtml: links", () => {
    it("keeps anchor text with a resolved absolute href", () => {
        const html = '<body><p>See the <a href="/docs/api">API reference</a> for details on this call.</p></body>';

        const doc = parseHtml(html, "https://example.com/guide/intro");

        expect(doc.nodes[0]?.links).toEqual([{ text: "API reference", href: "https://example.com/docs/api" }]);
    });

    it("drops javascript: and empty-text anchors", () => {
        const html = '<body><p>Text <a href="javascript:void(0)">go</a> <a href="/real"></a> here.</p></body>';

        const doc = parseHtml(html, "https://example.com/");

        expect(doc.nodes[0]?.links).toBeUndefined();
    });

    it("groups a paragraph of linked text into one node instead of one node per link", () => {
        const html = '<body><div>Read <a href="/a">one</a>, then <a href="/b">two</a>, then <a href="/c">three</a> in order to understand the sequencing rules.</div></body>';

        const doc = parseHtml(html, "https://example.com/");

        expect(doc.nodes).toHaveLength(1);
        expect(doc.nodes[0]?.links).toHaveLength(3);
    });
});

describe("parseHtml: boilerplate removal", () => {
    it("removes nav, footer and cookie banners", () => {
        const doc = parseHtml(loadFixture("boilerplate-heavy.html"), "https://example.com/api");
        const text = doc.nodes.map((n) => n.text).join("\n");

        expect(text).toContain("All API requests require authentication");
        expect(text).not.toMatch(/Subscribe to our newsletter/i);
        expect(text).not.toMatch(/Copyright 2024/i);
    });

    it("never deletes an element that holds most of the page, whatever its class says", () => {
        const body = "Real article prose. ".repeat(120);
        const html = `<body><div id="belowtopnav"><h1>Boiling Point</h1><p>${body}</p></div></body>`;

        const doc = parseHtml(html, "https://example.com/");

        expect(doc.nodes.some((n) => n.text.includes("Real article prose."))).toBe(true);
    });

    it("never deletes body or article, however they are classed", () => {
        const html = '<body class="cookies-not-set"><article class="newsletter-post"><p>The post body survives regardless.</p></article></body>';

        const doc = parseHtml(html, "https://example.com/");

        expect(doc.nodes.some((n) => n.text.includes("The post body survives"))).toBe(true);
    });

    it("still removes a small consent banner", () => {
        const html = '<body><div class="cookie-banner">We use cookies. Accept?</div><p>The actual article content is here.</p></body>';

        const doc = parseHtml(html, "https://example.com/");
        const text = doc.nodes.map((n) => n.text).join("\n");

        expect(text).not.toContain("We use cookies");
        expect(text).toContain("The actual article content is here.");
    });
});

describe("parseHtml: /comment/ conservatism", () => {
    // v1's boilerplate class list contains /comment/. On a discussion page that
    // deletes the answers. Removal is irreversible; ranking can down-weight
    // boilerplate but cannot recover deleted text.
    const ANSWER = "Another common question is how much more money is a heat-pump going cost";

    it("keeps discussion content that v1 deletes by class name", () => {
        const page = loadCorpusPage(CORPUS_IDS.discussion);

        const { $, mainContent } = preprocessHtml(page.html);
        const v1Text = mainContent === null ? "" : extractBlocks($, mainContent).map((b) => b.text).join("\n");
        const v2Text = parseHtml(page.html, page.url).nodes.map((n) => n.text).join("\n");

        // v1 extracts the article body fine, and even the "10 Comments" heading,
        // then deletes all ten comments because their class is `comments__list-item`.
        expect(v1Text).toContain("10 Comments");
        expect(v1Text).not.toContain(ANSWER);
        expect(v2Text).toContain(ANSWER);
        expect(v2Text.length).toBeGreaterThan(v1Text.length * 1.5);
    });

    it("keeps a comment thread on a synthetic discussion page", () => {
        const html = `<body>
            <div class="post"><h1>Why is my build slow?</h1><p>The webpack build takes nine minutes.</p></div>
            <div id="comments"><ol class="comment-list">
              <li class="comment"><p>Turn off source maps in development and it drops to forty seconds.</p></li>
              <li class="comment"><p>Also check that you are not resolving symlinks on every rebuild.</p></li>
            </ol></div>
        </body>`;

        const { $, mainContent } = preprocessHtml(html);
        const v1Text = mainContent === null ? "" : extractBlocks($, mainContent).map((b) => b.text).join("\n");
        const v2Text = parseHtml(html, "https://example.com/thread").nodes.map((n) => n.text).join("\n");

        expect(v1Text).not.toContain("Turn off source maps");
        expect(v2Text).toContain("Turn off source maps in development");
        expect(v2Text).toContain("resolving symlinks on every rebuild");
    });
});

describe("parseHtml: real corpus pages", () => {
    it("keeps the accepted answer and its endorsement on a Q&A page", () => {
        const page = loadCorpusPage(CORPUS_IDS.qa);

        const doc = parseHtml(page.html, page.url);
        const answer = doc.nodes.find(
            (n) => n.text.includes("You should simply be using tokio::spawn here.") && n.accepted === true,
        );

        expect(doc.kind).toBe("qa");
        expect(answer).toBeDefined();
        expect(answer?.kind).toBe("answer");
        expect(answer?.author).toBe("Darksonn");
        expect(doc.nodes.some((n) => n.kind === "code" && n.lang === "rust")).toBe(true);
    });

    it("extracts an API reference page that v1 reduces to nothing", () => {
        const page = loadCorpusPage(CORPUS_IDS.reference);

        const { $, mainContent } = preprocessHtml(page.html);
        const v1Blocks = mainContent === null ? [] : extractBlocks($, mainContent);
        const doc = parseHtml(page.html, page.url);
        const tables = doc.nodes.filter((n) => n.kind === "table");

        expect(v1Blocks).toHaveLength(0);
        expect(doc.kind).toBe("reference");
        expect(doc.nodes.length).toBeGreaterThan(20);
        expect(tables.length).toBeGreaterThanOrEqual(3);

        const values = tables.find((t) => t.text.startsWith("Value | Description"));
        expect(values).toBeDefined();
        expect(values?.text).toContain("none | Default value. No named grid areas");
    });

    it("reads the publication date off a content-farm listicle", () => {
        const page = loadCorpusPage(CORPUS_IDS.listicle);

        const doc = parseHtml(page.html, page.url);

        expect(doc.kind).toBe("listicle");
        expect(doc.publishedAt).toBe("2024-04-11T22:26:36.000Z");
        expect(doc.lang).toBe("en-us");
        expect(doc.nodes.some((n) => n.text.includes("Stress is a state of worry"))).toBe(true);
    });
});

describe("parseHtml: robustness", () => {
    it.each([
        ["empty string", ""],
        ["no body", "<html><head><title>t</title></head></html>"],
        ["plain text", "just some text with no tags at all"],
        ["broken markup", "<div><p>unclosed <span>tags</div>"],
    ])("returns a document for %s", (_label, html) => {
        const doc = parseHtml(html, "https://example.com/");

        expect(doc.source).toBe("html");
        expect(Array.isArray(doc.nodes)).toBe(true);
    });

    it("is deterministic across repeated parses", () => {
        const html = loadFixture("code-documentation.html");

        const a = parseHtml(html, "https://example.com/tsconfig");
        const b = parseHtml(html, "https://example.com/tsconfig");

        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
});
