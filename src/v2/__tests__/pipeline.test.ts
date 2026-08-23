import { describe, it, expect } from "vitest";
import { searchV2, coalescePassages, resolveConfig, DEFAULT_PAGE_ORDER, type DocFetcher } from "../pipeline";
import type { V2Result } from "../pipeline";
import type { Doc, DocNode, Passage } from "../types";

function node(text: string, order: number, overrides: Partial<DocNode> = {}): DocNode {
    return { kind: "prose", text, order, headingPath: [], ...overrides };
}

function section(heading: string, body: string[], start: number): DocNode[] {
    const nodes: DocNode[] = [node(heading, start, { kind: "heading", level: 2 })];
    body.forEach((text, i) => nodes.push(node(text, start + 1 + i, { headingPath: [heading] })));
    return nodes;
}

function doc(url: string, overrides: Partial<Doc> = {}): Doc {
    return {
        url,
        title: "Test document",
        kind: "guide",
        source: "html",
        nodes: [
            ...section("Introduction", ["A general introduction to the subject that does not answer anything specific."], 0),
            ...section("Configure the timeout", [
                "Set the timeout option to control how long a request may run before it is aborted.",
                "The default timeout is thirty seconds and applies to the whole request.",
            ], 2),
            ...section("Related posts", ["Another article about the timeout option you might enjoy reading."], 5),
        ],
        ...overrides,
    };
}

function fetcherFor(docs: Doc[]): DocFetcher {
    const byUrl = new Map(docs.map((d) => [d.url, d]));
    return async (url: string) => byUrl.get(url) ?? null;
}

function passage(id: string, startOrder: number, endOrder: number, text: string, overrides: Partial<Passage> = {}): Passage {
    return {
        id,
        docUrl: "https://a.example/1",
        headingPath: ["Section"],
        text,
        bodyText: text,
        charCount: text.length,
        startOrder,
        endOrder,
        kinds: ["prose"],
        hasCode: false,
        ...overrides,
    };
}

describe("coalescePassages", () => {
    it("merges adjacent passages up to the target size", () => {
        const passages = [
            passage("a", 0, 0, "first fragment"),
            passage("b", 1, 1, "second fragment"),
            passage("c", 2, 2, "third fragment"),
        ];

        const merged = coalescePassages(passages, 200, 400);

        expect(merged).toHaveLength(1);
        expect(merged[0]?.id).toBe("a");
        expect(merged[0]?.startOrder).toBe(0);
        expect(merged[0]?.endOrder).toBe(2);
        expect(merged[0]?.text).toContain("third fragment");
        expect(merged[0]?.charCount).toBe(merged[0]?.text.length);
    });

    it("never merges across a gap in document order", () => {
        const merged = coalescePassages(
            [passage("a", 0, 0, "first"), passage("b", 9, 9, "second")],
            200,
            400,
        );

        expect(merged).toHaveLength(2);
    });

    it("never merges across documents", () => {
        const merged = coalescePassages(
            [
                passage("a", 0, 0, "first"),
                passage("b", 1, 1, "second", { docUrl: "https://b.example/1" }),
            ],
            200,
            400,
        );

        expect(merged).toHaveLength(2);
    });

    it("never merges two different Q&A posts", () => {
        const merged = coalescePassages(
            [
                passage("a", 0, 0, "answer one", { votes: 10, accepted: true }),
                passage("b", 1, 1, "answer two", { votes: 3 }),
            ],
            200,
            400,
        );

        expect(merged).toHaveLength(2);
        expect(merged[0]?.accepted).toBe(true);
        expect(merged[1]?.votes).toBe(3);
    });

    it("respects the hard ceiling", () => {
        const long = "x".repeat(300);
        const merged = coalescePassages(
            [passage("a", 0, 0, long), passage("b", 1, 1, long), passage("c", 2, 2, long)],
            900,
            700,
        );

        for (const unit of merged) {
            expect(unit.charCount).toBeLessThanOrEqual(700);
        }
    });

    it("keeps bodyText in step with text", () => {
        const merged = coalescePassages(
            [passage("a", 0, 0, "Heading\nfirst body"), passage("b", 1, 1, "Heading\nsecond body")],
            500,
            900,
        );

        expect(merged).toHaveLength(1);
        expect(merged[0]?.bodyText).toContain("first body");
        expect(merged[0]?.bodyText).toContain("second body");
    });

    it("returns an empty list unchanged", () => {
        expect(coalescePassages([], 900, 1900)).toEqual([]);
    });
});

describe("searchV2", () => {
    const urls = ["https://docs.example.com/guide/timeouts", "https://blog.example.net/posts/timeouts"];

    it("returns passages that answer the query, ranked", async () => {
        const docs = [doc(urls[0] ?? ""), doc(urls[1] ?? "")];
        const result = await searchV2("timeout option default", urls, fetcherFor(docs));

        expect(result.pages.length).toBeGreaterThan(0);
        expect(result.totalChars).toBeGreaterThan(0);
        expect(result.pages[0]?.rank).toBe(1);

        const text = result.pages.flatMap((p) => p.excerpts).map((e) => e.text).join(" ");
        expect(text).toContain("timeout option");
    });

    it("records diagnostics, including pages it could not read", async () => {
        const docs = [doc(urls[0] ?? "")];
        const result = await searchV2("timeout option", urls, fetcherFor(docs));

        expect(result.diagnostics.consideredUrls).toEqual(urls);
        expect(result.diagnostics.unavailableUrls).toEqual([urls[1]]);
        expect(result.diagnostics.docsFetched).toBe(1);
        expect(result.diagnostics.passagesBuilt).toBeGreaterThan(0);
        expect(result.diagnostics.passagesSelected).toBeGreaterThan(0);
    });

    it("treats a fetcher that throws as one unavailable page, not a failed query", async () => {
        const good = doc(urls[0] ?? "");
        const fetcher: DocFetcher = async (url) => {
            if (url === urls[1]) throw new Error("boom");
            return url === good.url ? good : null;
        };

        const result = await searchV2("timeout option", urls, fetcher);

        expect(result.pages.length).toBeGreaterThan(0);
        expect(result.diagnostics.unavailableUrls).toEqual([urls[1]]);
    });

    it("stays within the assembly budget", async () => {
        const docs = [doc(urls[0] ?? ""), doc(urls[1] ?? "")];
        const result = await searchV2("timeout option", urls, docs.length > 0 ? fetcherFor(docs) : fetcherFor([]), {
            budget: { totalChars: 400 },
        });

        expect(result.totalChars).toBeLessThanOrEqual(400);
    });

    it("honours maxCandidates", async () => {
        const many = Array.from({ length: 6 }, (_, i) => `https://d${i}.example.com/guide/timeouts`);
        const docs = many.map((u) => doc(u));

        const result = await searchV2("timeout option", many, fetcherFor(docs), { maxCandidates: 2 });

        expect(result.diagnostics.consideredUrls).toHaveLength(2);
        expect(result.diagnostics.docsFetched).toBe(2);
    });

    it("detects page kind when the fetcher left it unknown", async () => {
        const unknown = doc("https://example.com/questions/12345/why-does-this-fail", { kind: "unknown" });
        const result = await searchV2("why does this fail", [unknown.url], fetcherFor([unknown]));

        expect(result.diagnostics.kindByUrl[unknown.url]).toBe("qa");
    });

    it("produces no pages and no chars when nothing can be fetched", async () => {
        const result = await searchV2("anything", urls, async () => null);

        expect(result.pages).toEqual([]);
        expect(result.totalChars).toBe(0);
        expect(result.diagnostics.unavailableUrls).toEqual(urls);
    });

    it("is deterministic across repeated runs", async () => {
        const docs = [doc(urls[0] ?? ""), doc(urls[1] ?? "")];
        const first = await searchV2("timeout option default", urls, fetcherFor(docs));
        const second = await searchV2("timeout option default", urls, fetcherFor(docs));

        expect(JSON.stringify(second.pages)).toBe(JSON.stringify(first.pages));
    });

    it("resolves a fully serializable config", () => {
        const resolved = resolveConfig({ budget: { totalChars: 1234 } });

        expect(resolved.budget.totalChars).toBe(1234);
        expect(JSON.parse(JSON.stringify(resolved))).toEqual(resolved);
    });

    it("reads deeper into the SERP by default than one screen of results", () => {
        // The measured reason for the default: at depth 8 the pipeline cannot
        // reach the pages carrying the remaining facts.
        expect(resolveConfig().maxCandidates).toBeGreaterThanOrEqual(16);
    });
});

describe("searchV2: authority in page ordering", () => {
    /**
     * A document with a body substantial enough that the body-shape signals in
     * `authority.ts` stay quiet — the `doc` fixture above is deliberately tiny,
     * which is itself the shape those signals fire on.
     */
    function article(url: string, subject: string, overrides: Partial<Doc> = {}): Doc {
        const body = (n: number): string =>
            `Paragraph ${n} about ${subject}. The timeout option controls how long a request may run ` +
            "before it is aborted, and the default is thirty seconds measured across the whole " +
            "exchange rather than per socket read. Setting it lower makes a slow dependency fail " +
            `fast instead of holding the caller open indefinitely, which is the point of ${subject}.`;
        return {
            url,
            title: `Timeouts and ${subject}`,
            kind: "guide",
            source: "html",
            nodes: [
                node("Configure the timeout", 0, { kind: "heading", level: 2 }),
                node(body(1), 1, { headingPath: ["Configure the timeout"] }),
                node(body(2), 2, { headingPath: ["Configure the timeout"] }),
                node(body(3), 3, { headingPath: ["Configure the timeout"] }),
                node(body(4), 4, { headingPath: ["Configure the timeout"] }),
                node(body(5), 5, { headingPath: ["Configure the timeout"] }),
            ],
            ...overrides,
        };
    }

    it("puts the query's own source of truth first among returned pages", async () => {
        const official = article("https://timeoutlib.example/docs/timeouts", "the official manual");
        const commentary = article("https://someblog.example/posts/timeouts", "one blogger's reading");

        const result = await searchV2(
            "timeoutlib timeout option default",
            [commentary.url, official.url],
            fetcherFor([commentary, official]),
            { canonicalHosts: ["timeoutlib.example"] },
        );

        expect(result.pages[0]?.url).toBe(official.url);
        expect(result.pages[0]?.authority.canonical).toBe(true);
    });

    describe("canonicalFirst", () => {
        /**
         * The survey's own assembly budget. Testing the partition under search's
         * default would test nothing: at `relevanceFloor: 0.35` the outmatched
         * canonical page below is floored out of assembly entirely, and a
         * partition cannot promote a page that was never selected. The two
         * survey knobs are coupled, and this is where that shows.
         */
        const SURVEY = { maxPassagesPerDoc: 1, maxCharsPerDoc: 400, totalChars: 4500, relevanceFloor: 0.15 };

        /** Canonical, substantive, and beaten on the score key by a blog that names the library repeatedly. */
        const outmatchedOfficial = (): Doc => ({
            url: "https://timeoutlib.example/docs/timeouts",
            title: "Timeouts",
            kind: "reference",
            source: "html",
            nodes: [
                node("Timeouts", 0, { kind: "heading", level: 2 }),
                ...[1, 2, 3, 4, 5].map((i) =>
                    node(
                        `Section ${i}. The timeout option is configurable and is measured across the whole ` +
                            "exchange rather than per socket read. The configuration reference lists every " +
                            "accepted value and unit, and explains how the abort is propagated to callers.",
                        i,
                        { headingPath: ["Timeouts"] },
                    ),
                ),
            ],
        });

        const strongCommentary = (): Doc => ({
            url: "https://someblog.example/posts/timeouts",
            title: "Timeouts and one blogger's reading",
            kind: "guide",
            source: "html",
            nodes: [
                node("Configure the timeout", 0, { kind: "heading", level: 2 }),
                ...[1, 2, 3, 4, 5].map((i) =>
                    node(
                        `Paragraph ${i} about timeoutlib. The timeoutlib timeout option default controls how ` +
                            "long a timeoutlib request may run before it is aborted, and the default is thirty " +
                            "seconds measured across the whole exchange rather than per socket read.",
                        i,
                        { headingPath: ["Configure the timeout"] },
                    ),
                ),
            ],
        });

        it("is off by default, so search's measured ordering is unchanged", async () => {
            const official = outmatchedOfficial();
            const blog = strongCommentary();

            const result = await searchV2(
                "timeoutlib timeout option default",
                [blog.url, official.url],
                fetcherFor([blog, official]),
                { canonicalHosts: ["timeoutlib.example"], budget: SURVEY },
            );

            expect(resolveConfig({}).pageOrder.canonicalFirst).toBe(false);
            // The blog wins the score key outright, and nothing overrides it.
            expect(result.pages[0]?.url).toBe(blog.url);
            expect(result.pages[1]?.authority.canonical).toBe(true);
        });

        it("puts the canonical page first even when it loses the score key", async () => {
            const official = outmatchedOfficial();
            const blog = strongCommentary();

            const result = await searchV2(
                "timeoutlib timeout option default",
                [blog.url, official.url],
                fetcherFor([blog, official]),
                {
                    canonicalHosts: ["timeoutlib.example"],
                    budget: SURVEY,
                    pageOrder: { canonicalFirst: true },
                },
            );

            expect(result.pages[0]?.url).toBe(official.url);
            expect(result.pages[0]?.authority.canonical).toBe(true);
            expect(result.pages[0]?.rank).toBe(1);
            // Everything else keeps its place behind the partition.
            expect(result.pages[1]?.url).toBe(blog.url);
        });

        it("orders canonical pages among themselves by the usual key", async () => {
            const weak = outmatchedOfficial();
            // Distinct wording, not a copy: assembly's novelty check drops a
            // near-duplicate outright, which would remove the page under test.
            const strong: Doc = {
                url: "https://timeoutlib.example/docs/configuration",
                title: "Configuration",
                kind: "reference",
                source: "html",
                nodes: [
                    node("Configuration", 0, { kind: "heading", level: 2 }),
                    ...[1, 2, 3, 4, 5].map((i) =>
                        node(
                            `Entry ${i}. timeoutlib reads the timeout option from its configuration file, and ` +
                                "the default applies when no explicit timeout is given. Values are parsed as " +
                                "milliseconds unless a unit suffix names something else.",
                            i,
                            { headingPath: ["Configuration"] },
                        ),
                    ),
                ],
            };
            const blog = strongCommentary();

            const result = await searchV2(
                "timeoutlib timeout option default",
                [blog.url, weak.url, strong.url],
                fetcherFor([blog, weak, strong]),
                {
                    canonicalHosts: ["timeoutlib.example"],
                    budget: SURVEY,
                    pageOrder: { canonicalFirst: true },
                },
            );

            // Both canonical pages precede the blog...
            expect(result.pages.slice(0, 2).every((p) => p.authority.canonical)).toBe(true);
            expect(result.pages[2]?.url).toBe(blog.url);
            // ...and the better-matching of the two still leads.
            expect(result.pages[0]?.url).toBe(strong.url);
        });

        it("changes nothing when no page is canonical", async () => {
            const docs = [
                article("https://a.example/guide/timeouts", "subject a"),
                article("https://b.example/guide/timeouts", "subject b"),
            ];
            const urls = docs.map((d) => d.url);

            const plain = await searchV2("timeout option default", urls, fetcherFor(docs), { budget: SURVEY });
            const partitioned = await searchV2("timeout option default", urls, fetcherFor(docs), {
                budget: SURVEY,
                pageOrder: { canonicalFirst: true },
            });

            expect(partitioned.pages.map((p) => p.url)).toEqual(plain.pages.map((p) => p.url));
        });
    });

    it("folds the search engine's ordering into authority, not into relevance", async () => {
        const target = article("https://target.example/guide/timeouts", "the page under test");
        const filler = Array.from({ length: 15 }, (_, i) =>
            article(`https://filler${i}.example/guide/timeouts`, `filler subject number ${i}`),
        );
        const all = [target, ...filler];
        const authorityOf = (result: V2Result): number =>
            result.pages.find((page) => page.url === target.url)?.authority.score ?? 0;

        // The SAME document, once at the top of the SERP and once at the bottom.
        const atTop = await searchV2("timeout option default", all.map((d) => d.url), fetcherFor(all));
        const atBottom = await searchV2(
            "timeout option default",
            [...filler.map((d) => d.url), target.url],
            fetcherFor(all),
        );

        expect(authorityOf(atTop)).toBeGreaterThan(0);
        expect(authorityOf(atTop)).toBeGreaterThan(authorityOf(atBottom));
        // The prior never claims a page is the source of truth.
        expect(atTop.pages.every((page) => page.authority.canonical === false)).toBe(true);
        expect(atTop.pages[0]?.authority.reasons.some((r) => r.includes("SERP prior"))).toBe(true);
    });

    it("leaves authority untouched when the SERP prior is switched off", async () => {
        const docs = Array.from({ length: 4 }, (_, i) =>
            article(`https://d${i}.example/guide/timeouts`, `subject number ${i}`),
        );

        const result = await searchV2("timeout option default", docs.map((d) => d.url), fetcherFor(docs), {
            pageOrder: { ...DEFAULT_PAGE_ORDER, serpPrior: 0 },
        });

        expect(result.pages.length).toBeGreaterThan(0);
        for (const page of result.pages) {
            expect(page.authority.reasons.some((r) => r.includes("SERP prior"))).toBe(false);
        }
    });

    it("drops a document whose authority bottomed out, and records why", async () => {
        const real = article("https://real.example/guide/timeouts", "the real article");
        // HTTP 200, perfect title, and a body made entirely of teaser links.
        const teaserGrid: Doc = {
            url: "https://farm.example/timeout-option-default",
            title: "Timeout option default",
            kind: "blog",
            source: "html",
            nodes: Array.from({ length: 8 }, (_, i) =>
                node(`The timeout option explained, part ${i}`, i, {
                    links: [{ text: `The timeout option explained, part ${i}`, href: `/p/${i}` }],
                }),
            ),
        };

        const result = await searchV2(
            "timeout option default",
            [teaserGrid.url, real.url],
            fetcherFor([real, teaserGrid]),
        );

        expect(result.diagnostics.excludedUrls).toContain(teaserGrid.url);
        expect(result.pages.map((p) => p.url)).not.toContain(teaserGrid.url);
    });
});
