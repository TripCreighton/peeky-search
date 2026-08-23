import { describe, it, expect } from "vitest";
import { scoreAuthority, computePeerCitations, DEFAULT_AUTHORITY_CONFIG } from "../authority";
import { parseQuery } from "../query";
import type { Doc, DocLink, DocNode, PageKind } from "../types";

function node(text: string, overrides: Partial<DocNode> = {}): DocNode {
    return { kind: "prose", text, order: 0, headingPath: [], ...overrides };
}

/**
 * A paragraph long enough to count as substantive prose (>= 200 chars), so a
 * fixture testing one signal does not accidentally trip the body-shape ones.
 */
function paragraph(seed: string): string {
    return (
        `${seed} ` +
        "The mechanism matters more than the summary: the call returns immediately, the work is " +
        "handed to a separate pool, and the caller is free to continue. That distinction is what " +
        "the rest of this section explains in detail, with the ordering guarantees spelled out."
    );
}

/** A document with a believable article body: several substantive paragraphs, no link soup. */
function doc(url: string, overrides: Partial<Doc> = {}): Doc {
    const nodes: DocNode[] = [
        node("Overview", { kind: "heading", order: 0, level: 2 }),
        node(paragraph("First."), { order: 1 }),
        node(paragraph("Second."), { order: 2 }),
        node(paragraph("Third."), { order: 3 }),
        node("const result = await run();", { kind: "code", order: 4, lang: "ts" }),
        node(paragraph("Fourth."), { order: 5 }),
        node(paragraph("Fifth."), { order: 6 }),
        node(paragraph("Sixth."), { order: 7 }),
    ];
    return {
        url,
        title: "A page",
        kind: "guide" as PageKind,
        source: "html",
        nodes,
        ...overrides,
    };
}

function reasonMatching(result: { reasons: string[] }, needle: string): boolean {
    return result.reasons.some((reason) => reason.includes(needle));
}

// =============================================================================
// The headline behaviours
// =============================================================================

describe("scoreAuthority: source of truth vs everything else", () => {
    it("ranks official project documentation above a content farm for the same query", () => {
        const query = parseQuery("tailwind v4 css-first config migration");

        const official = scoreAuthority(
            doc("https://tailwindcss.com/docs/upgrade-guide", { title: "Upgrade guide - Tailwind CSS" }),
            query,
        );
        const farm = scoreAuthority(
            doc("https://tech-insider.org/tailwind-v4-migration-2026", {
                title: "10 Best Tailwind v4 Migration Tips - The Ultimate Guide",
                kind: "listicle",
            }),
            query,
        );

        expect(official.score).toBeGreaterThan(farm.score);
        expect(official.canonical).toBe(true);
        expect(farm.canonical).toBe(false);
    });

    it("ranks official documentation above a mirror republishing the same content", () => {
        const query = parseQuery("python asyncio gather return_exceptions");
        // Byte-identical bodies: the ONLY thing separating these two pages is
        // whose domain is publishing them.
        const body = doc("about:blank").nodes;

        const official = scoreAuthority(
            doc("https://docs.python.org/3/library/asyncio-task.html", {
                title: "Coroutines and Tasks",
                kind: "reference",
                nodes: body,
            }),
            query,
        );
        const mirror = scoreAuthority(
            doc("https://runebook.dev/en/docs/python/library/asyncio-task/asyncio.gather", {
                title: "Coroutines and Tasks",
                kind: "reference",
                nodes: body,
            }),
            query,
        );

        expect(official.score).toBeGreaterThan(mirror.score);
        expect(official.canonical).toBe(true);
        expect(mirror.canonical).toBe(false);
        // The mirror's /docs/ path must NOT earn it the documentation bonus:
        // the documentation is not its own.
        expect(reasonMatching(mirror, "documentation URL shape ignored")).toBe(true);
    });

    it("marks a standards body canonical", () => {
        const result = scoreAuthority(
            doc("https://www.rfc-editor.org/rfc/rfc9110", { title: "RFC 9110: HTTP Semantics", kind: "spec" }),
            parseQuery("http semantics idempotent methods"),
        );

        expect(result.canonical).toBe(true);
        expect(reasonMatching(result, "standards body")).toBe(true);
    });

    it("marks a .gov primary source canonical on a general-category query", () => {
        const result = scoreAuthority(
            doc("https://www.irs.gov/retirement-plans/401k-limits", { title: "401(k) limits" }),
            parseQuery("401k contribution limit this year"),
        );

        expect(result.canonical).toBe(true);
        expect(result.score).toBeGreaterThan(DEFAULT_AUTHORITY_CONFIG.base);
        expect(reasonMatching(result, "primary source")).toBe(true);
    });

    it("treats a declared homepage host as canonical", () => {
        const query = parseQuery("someobscurelib retry options");
        const withHosts = scoreAuthority(doc("https://someobscurelib.io/api/retry"), query, {
            canonicalHosts: new Set(["someobscurelib.io"]),
        });
        const withoutHosts = scoreAuthority(doc("https://someobscurelib.io/api/retry"), query, {});

        expect(withHosts.canonical).toBe(true);
        expect(withHosts.score).toBeGreaterThan(withoutHosts.score);
    });
});

// =============================================================================
// The measured constraint: reorder hard, suppress only at the extreme
// =============================================================================

describe("scoreAuthority: suppression is reserved for the extreme", () => {
    it("reorders a factually accurate content farm down without suppressing it", () => {
        const query = parseQuery("podman vs docker rootless");
        // Real prose, real mechanism, accurate as far as it goes — the thing
        // that makes it a farm is the packaging, not the sentences.
        const farm = scoreAuthority(
            doc("https://tech-insider.org/podman-vs-docker-2026", {
                title: "7 Best Reasons to Switch - Ultimate Guide",
                kind: "listicle",
            }),
            query,
        );
        const neutral = scoreAuthority(doc("https://someblog.example/podman-and-docker"), query);

        expect(farm.score).toBeLessThan(neutral.score);
        // Not annihilated: suppressing a page that states a correct mechanism
        // trades nugget recall for source precision.
        expect(farm.score).toBeGreaterThan(DEFAULT_AUTHORITY_CONFIG.floor);
        expect(farm.score).toBeGreaterThan(0.25);
    });

    it("bottoms out a page that fetched fine and published no article", () => {
        // The largest single group of `bad`-graded pages in the corpus: HTTP
        // 200, a perfect title, and a body made of teaser links.
        const nodes: DocNode[] = [];
        for (let i = 0; i < 10; i++) {
            const link: DocLink = { text: `Read next: article number ${i}`, href: `https://farm.example/p/${i}` };
            nodes.push(node(`Read next: article number ${i}`, { order: i, links: [link] }));
        }

        const result = scoreAuthority(
            doc("https://farm.example/react-useeffect-cleanup", { nodes, title: "React useEffect cleanup" }),
            parseQuery("react useEffect cleanup"),
        );

        expect(result.score).toBe(DEFAULT_AUTHORITY_CONFIG.floor);
        expect(reasonMatching(result, "link index")).toBe(true);
    });
});

// =============================================================================
// One test per signal
// =============================================================================

describe("scoreAuthority: individual signals", () => {
    it("linkIndex fires when most of the body is anchor text", () => {
        const nodes = [
            node("Ten things about caching", { links: [{ text: "Ten things about caching", href: "/a" }] }),
            node("Why your build is slow", { links: [{ text: "Why your build is slow", href: "/b" }] }),
            node("Subscribe to the newsletter", { links: [{ text: "Subscribe to the newsletter", href: "/c" }] }),
        ];

        const result = scoreAuthority(doc("https://blog.example/post", { nodes }), parseQuery("caching"));

        expect(reasonMatching(result, "link index")).toBe(true);
    });

    it("linkIndex does not fire on an article that merely cites its sources", () => {
        const nodes = doc("about:blank").nodes.map((n, i) =>
            i === 1 ? { ...n, links: [{ text: "the spec", href: "https://w3.org/x" }] } : n,
        );

        const result = scoreAuthority(doc("https://blog.example/post", { nodes }), parseQuery("caching"));

        expect(reasonMatching(result, "link index")).toBe(false);
    });

    it("noSubstance fires when no paragraph is long enough to state a fact", () => {
        const nodes = [
            node("spawn", { kind: "heading", order: 0, level: 1 }),
            node("Spawns a task.", { order: 1 }),
            node("See also: spawn_blocking.", { order: 2 }),
        ];

        const result = scoreAuthority(
            doc("https://rustify.example/glossary/spawn", { nodes }),
            parseQuery("tokio spawn_blocking"),
        );

        expect(reasonMatching(result, "no substantive prose")).toBe(true);
    });

    it("thinBody fires on a stub and not on a real article", () => {
        const stub = scoreAuthority(
            doc("https://example.com/stub", { nodes: [node("One short line about the topic.")] }),
            parseQuery("topic"),
        );
        const article = scoreAuthority(doc("https://example.com/article"), parseQuery("topic"));

        expect(reasonMatching(stub, "thin body")).toBe(true);
        expect(reasonMatching(article, "thin body")).toBe(false);
    });

    it("selfPromotion fires when a vendor keeps naming its own product", () => {
        const nodes: DocNode[] = [];
        for (let i = 0; i < 8; i++) {
            nodes.push(
                node(
                    `${paragraph("Comparing the two runtimes.")} Graftcode benchmarks show Graftcode ` +
                        "outperforming both, which is why Graftcode customers migrate.",
                    { order: i },
                ),
            );
        }

        const promo = scoreAuthority(
            doc("https://graftcode.example/blog/grpc-vs-rest", { nodes }),
            parseQuery("rest vs grpc for internal services"),
        );
        const neutralHost = scoreAuthority(
            doc("https://someblog.example/blog/grpc-vs-rest", { nodes }),
            parseQuery("rest vs grpc for internal services"),
        );

        expect(reasonMatching(promo, "self-promotion")).toBe(true);
        // Same body on a host whose name the page never repeats: no penalty.
        expect(reasonMatching(neutralHost, "self-promotion")).toBe(false);
    });

    it("selfPromotion does not fire when the query asked about that very product", () => {
        const nodes: DocNode[] = [];
        for (let i = 0; i < 8; i++) {
            nodes.push(node(`${paragraph("Configuring it.")} Vitest reads vitest.config.ts at startup.`, { order: i }));
        }

        const result = scoreAuthority(
            doc("https://vitest.example/guide/config", { nodes }),
            parseQuery("vitest coverage thresholds config"),
        );

        expect(reasonMatching(result, "self-promotion")).toBe(false);
    });

    it("noCodeOnTechnical fires only on a query that names an identifier", () => {
        const proseOnly = doc("https://example.com/x", {
            nodes: doc("about:blank").nodes.filter((n) => n.kind !== "code"),
        });

        const codeQuery = scoreAuthority(proseOnly, parseQuery("tokio spawn_blocking when to use"));
        const wordQuery = scoreAuthority(proseOnly, parseQuery("why does bread stale faster in the fridge"));

        expect(reasonMatching(codeQuery, "no code block")).toBe(true);
        expect(reasonMatching(wordQuery, "no code block")).toBe(false);
    });

    it("a listicle scores below a plain article on the same body", () => {
        const query = parseQuery("package manager workspaces");
        const listicle = scoreAuthority(
            doc("https://example.com/roundup", { kind: "listicle", title: "10 Best Package Managers" }),
            query,
        );
        const article = scoreAuthority(doc("https://example.com/article"), query);

        expect(listicle.score).toBeLessThan(article.score);
        expect(reasonMatching(listicle, "page kind is listicle")).toBe(true);
    });

    it("penalizes a general social host but not endorsed Q&A", () => {
        const query = parseQuery("docker container exits immediately");

        const reddit = scoreAuthority(doc("https://www.reddit.com/r/docker/comments/abc/why"), query);
        const stack = scoreAuthority(
            doc("https://stackoverflow.com/questions/63305411/docker-container-exits", { kind: "qa" }),
            query,
        );

        expect(reddit.score).toBeLessThan(DEFAULT_AUTHORITY_CONFIG.base);
        expect(stack.score).toBeGreaterThanOrEqual(DEFAULT_AUTHORITY_CONFIG.base);
    });

    it("penalizes a discourse-style forum subdomain", () => {
        const result = scoreAuthority(
            doc("https://users.rust-lang.org/t/tokio-spawn-blocking/83438"),
            parseQuery("tokio spawn_blocking when to use"),
        );

        expect(reasonMatching(result, "forum subdomain")).toBe(true);
    });

    it("seoYearSlug fires on a trailing year but not on a dated blog permalink", () => {
        const query = parseQuery("pnpm vs npm workspaces");
        const seo = scoreAuthority(doc("https://example.org/pnpm-vs-npm-2026"), query);
        const permalink = scoreAuthority(doc("https://example.org/2019/03/pnpm-vs-npm"), query);

        expect(reasonMatching(seo, "year welded onto the end")).toBe(true);
        // Dated permalinks are how ordinary blogs are published, and they grade
        // well; a general "year anywhere in the path" rule penalises them.
        expect(reasonMatching(permalink, "year welded onto the end")).toBe(false);
    });

    it("penalizes explicit affiliate links but not ordinary outbound links", () => {
        const affiliate = scoreAuthority(
            doc("https://example.com/roundup", {
                nodes: [
                    ...doc("about:blank").nodes,
                    node("Buy A.", { order: 6, links: [{ text: "deal", href: "https://shop.example/x?aff=123" }] }),
                    node("Buy B.", { order: 7, links: [{ text: "deal", href: "https://shop.example/y?affiliate=9" }] }),
                    node("Buy C.", { order: 8, links: [{ text: "deal", href: "https://shop.example/recommends/z" }] }),
                ],
            }),
            parseQuery("best tool"),
        );
        const ordinary = scoreAuthority(
            doc("https://example.com/article", {
                nodes: doc("about:blank").nodes.map((n, i) =>
                    i === 1
                        ? { ...n, links: [{ text: "docs", href: "https://other.example/docs?ref=nav&tag=v2" }] }
                        : n,
                ),
            }),
            parseQuery("best tool"),
        );

        expect(reasonMatching(affiliate, "affiliate-shaped links")).toBe(true);
        expect(reasonMatching(ordinary, "affiliate-shaped links")).toBe(false);
    });

    it("exempts the query's own source of truth from link-density penalties", () => {
        // A manual's index links are navigation, not a link farm.
        const nodes = doc("about:blank").nodes.map((n, index) => ({
            ...n,
            links: [
                { text: "see also", href: "https://pkg.go.dev/context" },
                { text: "next", href: `https://pkg.go.dev/context#${index}` },
            ],
        }));

        const result = scoreAuthority(
            doc("https://pkg.go.dev/context", { nodes, kind: "reference" }),
            parseQuery("go context WithTimeout"),
            { canonicalHosts: new Set(["pkg.go.dev"]) },
        );

        expect(reasonMatching(result, "self-referential link density")).toBe(false);
        expect(reasonMatching(result, "link-density penalties skipped")).toBe(true);
    });

    it("penalizes a non-English page", () => {
        const result = scoreAuthority(doc("https://example.com/x", { lang: "de" }), parseQuery("anything"));

        expect(reasonMatching(result, "non-English")).toBe(true);
    });
});

// =============================================================================
// Contract
// =============================================================================

describe("scoreAuthority: contract", () => {
    it("always explains itself, including when nothing fired", () => {
        const result = scoreAuthority(doc("https://neutral-example.com/some/article"), parseQuery("unrelated topic"));

        expect(result.score).toBe(DEFAULT_AUTHORITY_CONFIG.base);
        expect(result.reasons.length).toBeGreaterThan(0);
        expect(result.reasons[0]).toContain("no authority signal fired");
    });

    it("attaches a reason to every score that moved off base", () => {
        const cases: Doc[] = [
            doc("https://www.rfc-editor.org/rfc/rfc9110"),
            doc("https://www.irs.gov/x"),
            doc("https://www.reddit.com/r/x/comments/y/z"),
            doc("https://example.com/stub", { nodes: [node("Tiny.")] }),
            doc("https://example.org/thing-2026"),
        ];

        for (const candidate of cases) {
            const result = scoreAuthority(candidate, parseQuery("react useEffect cleanup"));
            expect(result.score).not.toBe(DEFAULT_AUTHORITY_CONFIG.base);
            expect(result.reasons.some((r) => /^[+-]?\d/.test(r))).toBe(true);
        }
    });

    it("keeps the score inside the configured floor and 1", () => {
        const stacked = scoreAuthority(
            doc("https://www.w3.org/TR/css-grid-1/", { source: "markdown", kind: "spec" }),
            parseQuery("w3 css grid spec"),
        );
        expect(stacked.score).toBeLessThanOrEqual(1);
        expect(stacked.score).toBeGreaterThanOrEqual(DEFAULT_AUTHORITY_CONFIG.floor);

        const bottomed = scoreAuthority(
            doc("https://www.reddit.com/r/x/comments/y/z", {
                nodes: [node("Tiny.", { links: [{ text: "Tiny.", href: "/a" }] })],
                kind: "listicle",
                lang: "de",
            }),
            parseQuery("tokio spawn_blocking"),
        );
        expect(bottomed.score).toBe(DEFAULT_AUTHORITY_CONFIG.floor);
    });

    it("is deterministic: the same document and query always score identically", () => {
        const candidate = doc("https://tailwindcss.com/docs/upgrade-guide");
        const query = parseQuery("tailwind v4 migration");

        const first = scoreAuthority(candidate, query);
        const second = scoreAuthority(candidate, query);

        expect(second.score).toBe(first.score);
        expect(second.canonical).toBe(first.canonical);
        expect(second.reasons).toEqual(first.reasons);
    });
});

// =============================================================================
// Peer citation
// =============================================================================

describe("computePeerCitations", () => {
    function linked(url: string, hrefs: string[]): Doc {
        const links: DocLink[] = hrefs.map((href) => ({ text: "see", href }));
        return doc(url, { nodes: [node(paragraph("Body."), { order: 0, links })] });
    }

    it("counts how many other documents link to a document's publisher", () => {
        const docs = [
            linked("https://example.com/a", ["https://target.dev/docs"]),
            linked("https://other.com/b", ["https://target.dev/guide"]),
            linked("https://third.com/c", []),
            doc("https://target.dev/docs"),
        ];

        const citations = computePeerCitations(docs);

        expect(citations.get("https://target.dev/docs")).toBe(2);
        expect(citations.get("https://third.com/c")).toBe(0);
    });

    it("counts each citing document once however many links it carries", () => {
        const docs = [
            linked("https://example.com/a", [
                "https://target.dev/one",
                "https://target.dev/two",
                "https://target.dev/three",
            ]),
            doc("https://target.dev/one"),
        ];

        expect(computePeerCitations(docs).get("https://target.dev/one")).toBe(1);
    });

    it("never counts a document's links to itself", () => {
        const docs = [
            linked("https://target.dev/a", ["https://target.dev/b", "https://docs.target.dev/c"]),
            doc("https://target.dev/b"),
        ];

        expect(computePeerCitations(docs).get("https://target.dev/a")).toBe(0);
    });

    it("treats subdomains of one site as the same publisher", () => {
        const docs = [
            linked("https://example.com/a", ["https://www.target.dev/x"]),
            doc("https://docs.target.dev/y"),
        ];

        expect(computePeerCitations(docs).get("https://docs.target.dev/y")).toBe(1);
    });

    it("separates publishers that merely share a multi-tenant host", () => {
        const shared = [
            linked("https://example.com/a", ["https://github.com/someone-else/repo"]),
            doc("https://github.com/the-project/repo"),
        ];

        // Linking to one repository must not endorse every other repository on
        // the same host, or the signal collapses into "is hosted on GitHub".
        expect(computePeerCitations(shared).get("https://github.com/the-project/repo")).toBe(0);

        const direct = [
            linked("https://example.com/a", ["https://github.com/the-project/repo/blob/main/README.md"]),
            doc("https://github.com/the-project/repo"),
        ];
        expect(computePeerCitations(direct).get("https://github.com/the-project/repo")).toBe(1);
    });
});

describe("scoreAuthority: peer citation", () => {
    const query = parseQuery("how does the thing work");

    it("raises a document that the rest of the candidate set cites", () => {
        const candidate = doc("https://someone.example/article");

        const uncited = scoreAuthority(candidate, query, { peerCitations: 0 });
        const cited = scoreAuthority(candidate, query, { peerCitations: 3 });

        expect(cited.score).toBeGreaterThan(uncited.score);
        expect(reasonMatching(cited, "cited by 3")).toBe(true);
    });

    it("never penalizes a document for going uncited", () => {
        const candidate = doc("https://someone.example/article");

        const uncited = scoreAuthority(candidate, query, { peerCitations: 0 });
        const absent = scoreAuthority(candidate, query, {});

        expect(uncited.score).toBe(absent.score);
    });

    it("saturates so a heavily linked page cannot run away with the score", () => {
        const candidate = doc("https://someone.example/article");

        const atSaturation = scoreAuthority(candidate, query, {
            peerCitations: DEFAULT_AUTHORITY_CONFIG.peerCitationSaturation,
        });
        const wellBeyond = scoreAuthority(candidate, query, { peerCitations: 40 });

        expect(wellBeyond.score).toBe(atSaturation.score);
    });

    it("treats a widely cited page as canonical for the query", () => {
        const candidate = doc("https://someone.example/article");

        const result = scoreAuthority(candidate, query, {
            peerCitations: DEFAULT_AUTHORITY_CONFIG.peerCitationCanonical,
        });

        expect(result.canonical).toBe(true);
    });
});

// =============================================================================
// Domain-name matching
// =============================================================================

describe("scoreAuthority: the domain names the project", () => {
    it("accepts a label that is the project name with a conventional affix", () => {
        const result = scoreAuthority(doc("https://tailwindcss.com/blog/v4"), parseQuery("tailwind theme"));

        expect(reasonMatching(result, "domain names the project")).toBe(true);
    });

    it("rejects a label that merely contains the project name inside another word", () => {
        const result = scoreAuthority(
            doc("https://reacttraining.com/blog/useEffect-cleanup"),
            parseQuery("react useEffect cleanup function"),
        );

        // reacttraining.com is a training company, not the React project. The
        // measured cost of the loose rule: the containment matches it accepted
        // and this one rejects grade 14.3% bad / 28.6% good-or-canonical,
        // against a corpus baseline of 13.9% / 61.2%.
        expect(reasonMatching(result, "domain names the project")).toBe(false);
    });

    it("still accepts an exact label match", () => {
        const result = scoreAuthority(
            doc("https://react.dev/reference/react/useEffect"),
            parseQuery("react useEffect"),
        );

        expect(reasonMatching(result, "domain names the project")).toBe(true);
    });
});

// =============================================================================
// Body shape
// =============================================================================

describe("scoreAuthority: effectively empty body", () => {
    it("charges an extra penalty when a page carries almost no body at all", () => {
        const empty = scoreAuthority(
            doc("https://example.com/stub", { nodes: [node("Sign up to keep reading.", { order: 0 })] }),
            parseQuery("some question"),
        );
        const short = scoreAuthority(
            doc("https://example.com/short", {
                nodes: [node(paragraph("One."), { order: 0 }), node(paragraph("Two."), { order: 1 })],
            }),
            parseQuery("some question"),
        );

        expect(reasonMatching(empty, "effectively empty body")).toBe(true);
        expect(reasonMatching(short, "effectively empty body")).toBe(false);
        expect(empty.score).toBeLessThan(short.score);
    });
});
