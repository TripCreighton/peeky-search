import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createOracleAdapter } from "../adapters/oracle";
import type { CachedPage, CachedSerp, Corpus } from "../cache";
import type { Query } from "../types";
import { preprocessHtml } from "../../preprocessing/strip";
import { extractBlocks } from "../../preprocessing/segment";
import { parseHtml } from "../../v2/parse";

const FIXTURES_DIR = join(__dirname, "../../../test-fixtures");

function loadFixture(name: string): string {
    return readFileSync(join(FIXTURES_DIR, name), "utf-8");
}

function makeQuery(id = "q1", text = "test query"): Query {
    return { id, text, category: "conceptual", difficulty: 1 };
}

function cachedPage(url: string, html: string, overrides: Partial<CachedPage> = {}): CachedPage {
    return {
        url,
        fetchedAt: new Date().toISOString(),
        status: 200,
        contentType: "text/html",
        html,
        ...overrides,
    };
}

/**
 * In-memory stand-in for Corpus. The oracle adapter calls `getSerp`, `getPage`
 * and `readDoc`; a page missing from `pages` behaves like a corpus miss
 * (throws), matching `CorpusMissError`'s effect on the caller.
 *
 * `readDoc` always returns null here: these cases are about reading HTML, and a
 * corpus recorded without structured adapters has no docs. Preference for a
 * recorded doc is covered in `structured-docs.test.ts` against a real Corpus.
 */
function fakeCorpus(serp: CachedSerp, pages: Map<string, CachedPage>): Corpus {
    return {
        getSerp: async () => serp,
        getPage: async (url: string) => {
            const page = pages.get(url);
            if (page === undefined) {
                throw new Error(`corpus miss: ${url}`);
            }
            return page;
        },
        readDoc: () => null,
    } as unknown as Corpus;
}

function serpFor(urls: string[]): CachedSerp {
    return {
        query: "test query",
        fetchedAt: new Date().toISOString(),
        results: urls.map((url) => ({ url, title: url, content: "", score: 1, engine: "test" })),
    };
}

describe("createOracleAdapter", () => {
    it("emits excerpts that cover the full extracted text of a fixture page", async () => {
        // Arrange: compute the ground-truth nodes with the v2 parser, the
        // same way the adapter's own source does, independent of the
        // adapter under test.
        const html = loadFixture("nested-headings.html");
        const url = "https://example.com/nested";
        const nodes = parseHtml(html, url).nodes;
        expect(nodes.length).toBeGreaterThan(0);

        const corpus = fakeCorpus(serpFor([url]), new Map([[url, cachedPage(url, html)]]));
        const adapter = createOracleAdapter();

        // Act
        const result = await adapter.runQuery(makeQuery(), corpus);

        // Assert
        expect(result.pages).toHaveLength(1);
        const page = result.pages[0]!;

        // At least one section excerpt plus the trailing whole-page excerpt.
        expect(page.excerpts.length).toBeGreaterThan(1);

        // Every node's raw text must survive somewhere in the union of
        // excerpts - the whole point of appending the full-page excerpt is
        // that this holds even if the section split is imperfect.
        const unionText = page.excerpts.map((e) => e.text).join("\n");
        for (const node of nodes) {
            expect(unionText).toContain(node.text);
        }

        // The FINAL excerpt alone (the whole-page safety net) must also
        // cover everything, independent of how the sections were split.
        const lastExcerpt = page.excerpts[page.excerpts.length - 1]!;
        for (const node of nodes) {
            expect(lastExcerpt.text).toContain(node.text);
        }

        // charCount reflects the extracted text once, not the sum of
        // (deliberately duplicated) excerpt lengths.
        const sumOfExcerptLengths = page.excerpts.reduce((n, e) => n + e.text.length, 0);
        expect(page.charCount).toBeLessThan(sumOfExcerptLengths);
        expect(page.charCount).toBe(lastExcerpt.text.length);
    });

    it("recovers a page v1's parser deletes entirely", async () => {
        // Arrange: the w3schools shape. The whole article lives inside
        // `id="belowtopnav"`, which v1's /nav/ boilerplate pattern matches,
        // so v1 removes the document and extracts nothing at all. 91 of the
        // corpus's 962 successfully-fetched pages fail this way; the ceiling
        // must not be measured through a parser that cannot see them.
        const html = `<!DOCTYPE html><html><head><title>SQL LIMIT Clause</title></head>
            <body>
                <div id="topnav"><a href="/sql">SQL</a><a href="/css">CSS</a></div>
                <div id="belowtopnav">
                    <h1>SQL LIMIT Clause</h1>
                    <p>The LIMIT clause restricts the number of rows a SELECT statement returns.
                       It is supported by MySQL, PostgreSQL and SQLite.</p>
                    <h2>Syntax</h2>
                    <pre>SELECT column_name FROM table_name LIMIT number;</pre>
                    <table>
                        <tr><th>Database</th><th>Keyword</th></tr>
                        <tr><td>MySQL</td><td>LIMIT</td></tr>
                        <tr><td>SQL Server</td><td>TOP</td></tr>
                        <tr><td>Oracle</td><td>FETCH FIRST</td></tr>
                    </table>
                </div>
            </body></html>`;
        const url = "https://example.com/sql/sql_top.asp";

        // v1's own parser, run directly: nothing survives. This is the
        // premise of the test, so it is asserted rather than assumed.
        const { $, mainContent } = preprocessHtml(html);
        const v1Blocks = mainContent === null ? [] : extractBlocks($, mainContent);
        expect(v1Blocks).toHaveLength(0);

        const corpus = fakeCorpus(serpFor([url]), new Map([[url, cachedPage(url, html)]]));

        // Act
        const result = await createOracleAdapter().runQuery(makeQuery(), corpus);

        // Assert: the oracle keeps the page and its content, including the
        // table v1 could not represent at all.
        expect(result.pages).toHaveLength(1);
        const page = result.pages[0]!;
        const fullText = page.excerpts[page.excerpts.length - 1]!.text;

        expect(fullText).toContain("LIMIT clause restricts the number of rows");
        expect(fullText).toContain("SELECT column_name FROM table_name LIMIT number;");
        expect(fullText).toContain("FETCH FIRST");
        expect(page.charCount).toBeGreaterThan(0);
    });

    it("skips pages that failed to fetch, and pages missing from the corpus", async () => {
        // Arrange
        const okUrl = "https://example.com/ok";
        const transportErrorUrl = "https://example.com/transport-error";
        const notFoundUrl = "https://example.com/404";
        const emptyHtmlUrl = "https://example.com/empty";
        const missingUrl = "https://example.com/never-recorded";

        const html = loadFixture("basic-article.html");
        const urls = [okUrl, transportErrorUrl, notFoundUrl, emptyHtmlUrl, missingUrl];

        const pages = new Map<string, CachedPage>([
            [okUrl, cachedPage(okUrl, html)],
            [transportErrorUrl, cachedPage(transportErrorUrl, "", { status: 0, error: "fetch failed" })],
            [notFoundUrl, cachedPage(notFoundUrl, "<html>gone</html>", { status: 404, error: "HTTP 404" })],
            [emptyHtmlUrl, cachedPage(emptyHtmlUrl, "   ")],
            // missingUrl deliberately absent from `pages` - simulates a
            // corpus miss (never recorded).
        ]);

        const corpus = fakeCorpus(serpFor(urls), pages);
        const adapter = createOracleAdapter();

        // Act
        const result = await adapter.runQuery(makeQuery(), corpus);

        // Assert: the query itself does not fail just because most of its
        // pages are unfetchable.
        expect(result.error).toBeUndefined();
        expect(result.pages).toHaveLength(1);
        expect(result.pages[0]?.url).toBe(okUrl);

        // consideredUrls / serpUrls still report every URL the SERP ever
        // held, regardless of what survived fetching.
        expect(result.consideredUrls).toEqual(urls);
        expect(result.serpUrls).toEqual(urls);
    });

    it("fails the query when the SERP itself is a corpus miss", async () => {
        // Arrange: a corpus whose getSerp throws, exactly like a real
        // CorpusMissError would for an unrecorded query.
        const corpus = {
            getSerp: async () => {
                throw new Error("corpus miss: no such serp");
            },
            getPage: async () => {
                throw new Error("should never be called");
            },
        } as unknown as Corpus;
        const adapter = createOracleAdapter();

        // Act / Assert: the adapter does not swallow this - it propagates,
        // exactly like v1 does, so runner.ts can record it as a failed query.
        await expect(adapter.runQuery(makeQuery(), corpus)).rejects.toThrow(/corpus miss/);
    });
});
