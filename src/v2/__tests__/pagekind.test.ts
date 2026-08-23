import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectPageKind } from "../pagekind";
import { parseHtml } from "../parse";
import type { Doc, DocNode, NodeKind } from "../types";

const CORPUS = join(process.cwd(), "eval", "corpus", "pages");

function loadCorpusPage(id: string): { url: string; html: string } {
    return JSON.parse(readFileSync(join(CORPUS, `${id}.json`), "utf-8")) as { url: string; html: string };
}

interface NodeSpec {
    kind: NodeKind;
    text: string;
    level?: number;
    accepted?: boolean;
}

function makeDoc(nodes: NodeSpec[], title = "Test Page"): Doc {
    const built: DocNode[] = nodes.map((spec, order) => ({
        kind: spec.kind,
        text: spec.text,
        order,
        headingPath: [],
        ...(spec.level !== undefined ? { level: spec.level } : {}),
        ...(spec.accepted !== undefined ? { accepted: spec.accepted } : {}),
    }));
    return { url: "https://example.com/page", title, kind: "unknown", source: "html", nodes: built };
}

describe("detectPageKind: URL signals", () => {
    it.each([
        ["https://stackoverflow.com/questions/123/why-is-my-build-slow", "qa"],
        ["https://superuser.com/questions/1122564/ssh-via-multiple-hosts", "qa"],
        ["https://github.com/tokio-rs/tokio/discussions/4149", "qa"],
        ["https://news.ycombinator.com/item?id=37575204", "qa"],
        ["https://github.com/denoland/deno/issues/36588", "issue"],
        ["https://example.com/docs/changelog/", "changelog"],
        ["https://example.com/api-reference/client", "reference"],
        ["https://example.com/guides/getting-started", "guide"],
        ["https://example.com/blog/why-rust-is-fast", "blog"],
        ["https://datatracker.ietf.org/doc/html/rfc9110", "spec"],
        ["https://example.com/10-best-ways-to-lose-weight", "listicle"],
    ])("classifies %s as %s", (url, expected) => {
        const doc = makeDoc([{ kind: "prose", text: "Some body text on the page." }]);

        const result = detectPageKind(doc, "<html></html>", url);

        expect(result.kind).toBe(expected);
    });

    it("returns unknown with an explanation when nothing matches", () => {
        const doc = makeDoc([{ kind: "prose", text: "Some body text." }]);

        const result = detectPageKind(doc, "<html></html>", "https://example.com/x");

        expect(result.kind).toBe("unknown");
        expect(result.evidence).toBe("no signals matched");
    });

    it("tolerates a URL that is not absolute", () => {
        const doc = makeDoc([{ kind: "prose", text: "Body." }]);

        expect(detectPageKind(doc, "<html></html>", "/questions/42").kind).toBe("qa");
    });
});

describe("detectPageKind: document structure", () => {
    it("reads a run of version-numbered headings as a changelog", () => {
        const doc = makeDoc([
            { kind: "heading", text: "1.4.0 - 2025-02-01", level: 2 },
            { kind: "prose", text: "Adds a thing." },
            { kind: "heading", text: "1.3.2 - 2025-01-14", level: 2 },
            { kind: "prose", text: "Fixes a thing." },
            { kind: "heading", text: "v1.3.1", level: 2 },
            { kind: "prose", text: "Fixes another thing." },
        ]);

        const result = detectPageKind(doc, "<html></html>", "https://example.com/notes");

        expect(result.kind).toBe("changelog");
        expect(result.evidence).toContain("version-numbered headings");
    });

    it("reads a parameter table as a reference page", () => {
        const doc = makeDoc([
            { kind: "heading", text: "createClient", level: 2 },
            { kind: "table", text: "Parameter | Type | Default\ntimeout | number | 5000" },
        ]);

        const result = detectPageKind(doc, "<html></html>", "https://example.com/x");

        expect(result.kind).toBe("reference");
        expect(result.evidence).toContain("parameter table");
    });

    it("reads a vertical parameter table, where the names are the first column", () => {
        const doc = makeDoc([
            { kind: "table", text: "Default value: | none\nInherited: | no\nReturns: | void" },
        ]);

        const result = detectPageKind(doc, "<html></html>", "https://example.com/x");

        expect(result.kind).toBe("reference");
        expect(result.evidence).toContain("first column");
    });

    it("reads sibling answer nodes as a Q&A page even without a URL hint", () => {
        const doc = makeDoc([
            { kind: "question", text: "How do I cancel a context in Go?" },
            { kind: "answer", text: "Call the cancel function returned by WithCancel." },
            { kind: "answer", text: "Defer cancel() immediately after creating the context." },
            { kind: "answer", text: "You can also use WithTimeout for a deadline." },
        ]);

        const result = detectPageKind(doc, "<html></html>", "https://example.com/thread/1");

        expect(result.kind).toBe("qa");
        expect(result.evidence).toContain("answer nodes");
    });

    it("reads numbered h2 runs as a listicle", () => {
        const doc = makeDoc([
            { kind: "heading", text: "1. Sleep more", level: 2 },
            { kind: "heading", text: "2. Drink water", level: 2 },
            { kind: "heading", text: "3. Walk daily", level: 2 },
            { kind: "heading", text: "4. Log off", level: 2 },
        ]);

        const result = detectPageKind(doc, "<html></html>", "https://example.com/wellness");

        expect(result.kind).toBe("listicle");
        expect(result.evidence).toContain("numbered <h2> headings");
    });

    it("does not call a changelog a listicle just because its headings start with digits", () => {
        const doc = makeDoc([
            { kind: "heading", text: "1.4.0 - 2025-02-01", level: 2 },
            { kind: "heading", text: "1.3.0 - 2025-01-02", level: 2 },
            { kind: "heading", text: "1.2.0 - 2024-12-02", level: 2 },
            { kind: "heading", text: "1.1.0 - 2024-11-02", level: 2 },
        ]);

        expect(detectPageKind(doc, "<html></html>", "https://example.com/x").kind).toBe("changelog");
    });

    it("reads RFC boilerplate as a spec", () => {
        const doc = makeDoc([
            { kind: "heading", text: "Status of This Memo", level: 2 },
            { kind: "prose", text: "This document is an Internet Standards Track document." },
        ]);

        expect(detectPageKind(doc, "<html></html>", "https://example.com/x").kind).toBe("spec");
    });

    it("reads a JSON-LD QAPage declaration", () => {
        const doc = makeDoc([{ kind: "prose", text: "Body." }]);
        const html = '<script type="application/ld+json">{"@type":"QAPage"}</script>';

        const result = detectPageKind(doc, html, "https://example.com/x");

        expect(result.kind).toBe("qa");
        expect(result.evidence).toContain("jsonld=QAPage");
    });

    it("does not call a blog post an issue for mentioning reproduction steps in prose", () => {
        const doc = makeDoc([
            { kind: "prose", text: "I could not find steps to reproduce the problem anywhere." },
            { kind: "prose", text: "Expected behavior was never documented either." },
        ]);

        expect(detectPageKind(doc, "<html></html>", "https://example.com/2013/07/post").kind).toBe("blog");
    });
});

describe("detectPageKind: evidence", () => {
    it("names the winning kind, its score and its runners-up", () => {
        const doc = makeDoc([
            { kind: "question", text: "Q?" },
            { kind: "answer", text: "A one." },
            { kind: "answer", text: "A two." },
        ]);

        const result = detectPageKind(doc, "<html></html>", "https://stackoverflow.com/questions/1/x");

        expect(result.evidence).toMatch(/^qa=\d+: /);
        expect(result.evidence).toContain("host=stackoverflow");
        expect(result.evidence).toContain("path=/questions/");
    });

    it("is deterministic", () => {
        const doc = makeDoc([{ kind: "prose", text: "Body." }]);

        const a = detectPageKind(doc, "<html></html>", "https://example.com/docs/guide/x");
        const b = detectPageKind(doc, "<html></html>", "https://example.com/docs/guide/x");

        expect(a).toEqual(b);
    });
});

describe("detectPageKind: real corpus pages", () => {
    it.each([
        ["2328eb8c03f967d540ec711feb7b4720d2311a26", "qa"],
        ["ea40de9572d79e003ad2f2a58e8ae47aaa077b2d", "reference"],
        ["fa9987ab48a2500a49b2eaea444d613416dd08b3", "listicle"],
        ["c7b1c8423ba26f45d5ccd0f8d9a3ec8926f66255", "changelog"],
    ])("classifies cached page %s as %s", (id, expected) => {
        const page = loadCorpusPage(id);

        const doc = parseHtml(page.html, page.url);

        expect(doc.kind).toBe(expected);
        expect(doc.kindEvidence ?? "").not.toBe("");
    });
});
