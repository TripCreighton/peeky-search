/**
 * Structured documents in the corpus.
 *
 * A source adapter (Stack Exchange, GitHub, npm, a markdown sibling) runs at
 * RECORD time and its `Doc` is frozen into `<corpus>/docs`. Replay then prefers
 * that Doc over the raw HTML for the same URL. These tests pin the three things
 * that make the arrangement safe:
 *
 *   - a recorded Doc WINS over cached HTML, which is the entire point on a host
 *     that answers every scraper with 403;
 *   - a missing, empty or corrupt Doc falls back to the HTML CLEANLY, so a
 *     half-recorded corpus degrades rather than fails;
 *   - opening a corpus that has never recorded one does not touch it — same
 *     files, same revision — so the original corpus and every measurement taken
 *     against it are unaffected by this code path existing.
 *
 * Nothing here touches the network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Corpus, canonicalizeUrl, canonicalizeQuery } from "../cache";
import type { CachedPage, CachedSerp } from "../cache";
import type { Doc } from "../../v2/types";
import { buildPassages } from "../../v2/passages";
import { createV2Adapter } from "../adapters/v2";
import { createOracleAdapter } from "../adapters/oracle";
import type { Query } from "../types";

const QUERY: Query = {
    id: "test-lockfile",
    text: "frozen lockfile ci install fails",
    category: "debugging",
    difficulty: 1,
    tranche: 1,
};

/** Frozen as HTTP 403 with an empty body — the shape every Stack Exchange page has in the real corpus. */
const QA_URL = "https://stackoverflow.com/questions/12345/frozen-lockfile-ci";
/** Frozen as a normal 200 with readable HTML. */
const HTML_URL = "https://docs.example.com/guide/lockfiles";
/** Has BOTH readable HTML and a recorded doc, so preference is observable. */
const BOTH_URL = "https://docs.example.com/guide/install";

const HTML_PAGE = `<!doctype html><html lang="en"><head><title>Lockfiles - Example</title></head>
<body><main>
<h1>Lockfiles</h1>
<h2>Frozen lockfile in CI</h2>
<p>A frozen lockfile install fails when the lockfile does not match the manifest, which is the behaviour continuous integration wants.</p>
<p>Run the install again locally and commit the updated lockfile so that the manifest and the lockfile agree.</p>
</main></body></html>`;

const BOTH_HTML = `<!doctype html><html lang="en"><head><title>Install - Example</title></head>
<body><main>
<h1>Install</h1>
<h2>Installing dependencies</h2>
<p>THIS SENTENCE COMES FROM THE CACHED HTML and mentions the frozen lockfile install so it is not filtered as irrelevant.</p>
<p>Another paragraph of installation prose about the lockfile so the page has enough substance to survive the quality gate.</p>
</main></body></html>`;

function sha(input: string): string {
    return createHash("sha256").update(input).digest("hex").slice(0, 40);
}

/** A Q&A document of the shape `fetch/stackexchange.ts` produces: votes and an accepted flag on every node. */
function qaDoc(): Doc {
    return {
        url: QA_URL,
        title: "Why does a frozen lockfile install fail in CI",
        kind: "qa",
        source: "stackexchange",
        nodes: [
            {
                kind: "question",
                text: "My continuous integration job runs a frozen lockfile install and it fails, but the same install works on my laptop. What is different about CI?",
                order: 0,
                headingPath: [],
                votes: 42,
            },
            {
                kind: "answer",
                text: "A frozen lockfile install refuses to update the lockfile, so it fails whenever the lockfile and the manifest disagree. Commit the regenerated lockfile and CI will install cleanly.",
                order: 1,
                headingPath: [],
                votes: 310,
                accepted: true,
            },
        ],
    };
}

/** A document for a URL whose HTML is also readable, so which one won is observable in the output. */
function markdownDoc(): Doc {
    return {
        url: BOTH_URL,
        title: "Install",
        kind: "guide",
        source: "markdown",
        nodes: [
            { kind: "heading", text: "Installing dependencies", order: 0, headingPath: [], level: 2 },
            {
                kind: "prose",
                text: "THIS SENTENCE COMES FROM THE RECORDED DOC and mentions the frozen lockfile install so the passage is scored, not discarded.",
                order: 1,
                headingPath: ["Installing dependencies"],
            },
            {
                kind: "prose",
                text: "A second paragraph about the lockfile and the install so the recorded document has comparable substance to the HTML it supersedes.",
                order: 2,
                headingPath: ["Installing dependencies"],
            },
        ],
    };
}

let root: string;

/** Build a corpus holding the three pages, with no `docs/` directory at all. */
function seedCorpus(): void {
    root = mkdtempSync(join(tmpdir(), "peeky-structured-docs-"));
    mkdirSync(join(root, "pages"), { recursive: true });
    mkdirSync(join(root, "serp"), { recursive: true });

    const serp: CachedSerp = {
        query: QUERY.text,
        fetchedAt: new Date(0).toISOString(),
        results: [
            { url: HTML_URL, title: "Lockfiles", content: "", score: 1, engine: "test" },
            { url: QA_URL, title: "Frozen lockfile in CI", content: "", score: 1, engine: "test" },
            { url: BOTH_URL, title: "Install", content: "", score: 1, engine: "test" },
        ],
    };
    writeFileSync(join(root, "serp", `${sha(canonicalizeQuery(QUERY.text))}.json`), JSON.stringify(serp));

    const write = (page: CachedPage): void => {
        writeFileSync(join(root, "pages", `${sha(canonicalizeUrl(page.url))}.json`), JSON.stringify(page));
    };

    write({
        url: HTML_URL,
        fetchedAt: new Date(0).toISOString(),
        status: 200,
        contentType: "text/html; charset=utf-8",
        html: HTML_PAGE,
    });
    write({
        url: BOTH_URL,
        fetchedAt: new Date(0).toISOString(),
        status: 200,
        contentType: "text/html; charset=utf-8",
        html: BOTH_HTML,
    });
    write({
        url: QA_URL,
        fetchedAt: new Date(0).toISOString(),
        status: 403,
        contentType: "text/html",
        html: "",
        error: "HTTP 403",
    });
}

beforeEach(() => {
    seedCorpus();
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function allText(pages: Array<{ excerpts: Array<{ text: string }> }>): string {
    return pages.flatMap((p) => p.excerpts).map((e) => e.text).join("\n");
}

// ---------------------------------------------------------------------------
// Corpus storage
// ---------------------------------------------------------------------------

describe("Corpus structured documents", () => {
    it("round-trips a doc keyed the same way pages are", () => {
        const recorder = new Corpus(root, "record");
        recorder.writeDoc(QA_URL, "stackexchange", qaDoc());

        const reader = new Corpus(root, "replay");
        const entry = reader.readDoc(QA_URL);

        expect(entry).not.toBeNull();
        expect(entry?.adapter).toBe("stackexchange");
        expect(entry?.doc.source).toBe("stackexchange");
        expect(entry?.doc.nodes[1]?.votes).toBe(310);
        expect(entry?.doc.nodes[1]?.accepted).toBe(true);
    });

    it("keys a doc by the canonicalized URL, so a doc and its page always agree", () => {
        const recorder = new Corpus(root, "record");
        recorder.writeDoc(QA_URL, "stackexchange", qaDoc());

        const reader = new Corpus(root, "replay");

        expect(reader.hasDoc(`${QA_URL}#comment-99`)).toBe(true);
        expect(reader.readDoc(`${QA_URL}?utm_source=newsletter`)).not.toBeNull();
    });

    it("never replaces the raw HTML, so v1 keeps seeing what it saw before", () => {
        const recorder = new Corpus(root, "record");
        recorder.writeDoc(BOTH_URL, "markdown", markdownDoc());

        const page = new Corpus(root, "replay").readPage(BOTH_URL);

        expect(page?.html).toBe(BOTH_HTML);
    });

    it("reports a missing doc as null rather than throwing", () => {
        expect(new Corpus(root, "replay").readDoc(HTML_URL)).toBeNull();
        expect(new Corpus(root, "replay").hasDoc(HTML_URL)).toBe(false);
    });

    it("treats a corrupt doc as absent, so a damaged entry degrades instead of failing a run", () => {
        mkdirSync(join(root, "docs"), { recursive: true });
        writeFileSync(join(root, "docs", `${sha(canonicalizeUrl(QA_URL))}.json`), "{ not json");

        expect(new Corpus(root, "replay").readDoc(QA_URL)).toBeNull();
        expect(new Corpus(root, "replay").allDocs()).toEqual([]);
    });

    it("refuses to write a doc in replay mode", () => {
        expect(() => new Corpus(root, "replay").writeDoc(QA_URL, "stackexchange", qaDoc())).toThrow(
            /replay mode/,
        );
    });

    it("counts docs in stats and lists them with their adapter", () => {
        const recorder = new Corpus(root, "record");
        recorder.writeDoc(QA_URL, "stackexchange", qaDoc());
        recorder.writeDoc(BOTH_URL, "markdown", markdownDoc());

        const reader = new Corpus(root, "replay");

        expect(reader.stats().docs).toBe(2);
        expect(reader.allDocs().map((d) => d.adapter).sort()).toEqual(["markdown", "stackexchange"]);
    });
});

// ---------------------------------------------------------------------------
// The original corpus must be unaffected
// ---------------------------------------------------------------------------

describe("a corpus with no structured documents", () => {
    it("is not modified by being opened - no docs directory is created", () => {
        const before = readdirSync(root).sort();

        new Corpus(root, "replay");
        new Corpus(root, "record");

        expect(readdirSync(root).sort()).toEqual(before);
        expect(existsSync(join(root, "docs"))).toBe(false);
    });

    it("keeps the revision it had before docs existed", () => {
        // The revision of a corpus with no docs must be a function of pages and
        // serps alone, or every previously recorded run would suddenly look as
        // though it had been taken against a different corpus.
        const expected = createHash("sha256")
            .update(
                `${readdirSync(join(root, "pages")).sort().join(",")}|` +
                    `${readdirSync(join(root, "serp")).sort().join(",")}`,
            )
            .digest("hex")
            .slice(0, 40)
            .slice(0, 12);

        expect(new Corpus(root, "replay").revision()).toBe(expected);
    });

    it("changes revision once a doc is recorded, so the two corpora are distinguishable", () => {
        const before = new Corpus(root, "replay").revision();
        new Corpus(root, "record").writeDoc(QA_URL, "stackexchange", qaDoc());

        expect(new Corpus(root, "replay").revision()).not.toBe(before);
    });

    it("replays v2 identically whether or not the doc code path exists", async () => {
        const result = await createV2Adapter().runQuery(QUERY, new Corpus(root, "replay"));

        // The 403 stays dead and the HTML pages are read from HTML.
        expect(result.pages.map((p) => p.url)).not.toContain(QA_URL);
        expect(allText(result.pages)).toContain("THIS SENTENCE COMES FROM THE CACHED HTML");
    });
});

// ---------------------------------------------------------------------------
// Replay preference
// ---------------------------------------------------------------------------

describe("v2 replay with structured documents", () => {
    it("prefers a recorded doc over the cached HTML for the same URL", async () => {
        new Corpus(root, "record").writeDoc(BOTH_URL, "markdown", markdownDoc());

        const result = await createV2Adapter().runQuery(QUERY, new Corpus(root, "replay"));
        const text = allText(result.pages);

        expect(text).toContain("THIS SENTENCE COMES FROM THE RECORDED DOC");
        expect(text).not.toContain("THIS SENTENCE COMES FROM THE CACHED HTML");
    });

    it("makes a page readable whose HTML is a dead 403", async () => {
        const withoutDoc = await createV2Adapter().runQuery(QUERY, new Corpus(root, "replay"));
        expect(withoutDoc.pages.map((p) => p.url)).not.toContain(QA_URL);

        new Corpus(root, "record").writeDoc(QA_URL, "stackexchange", qaDoc());
        const withDoc = await createV2Adapter().runQuery(QUERY, new Corpus(root, "replay"));

        expect(withDoc.pages.map((p) => p.url)).toContain(QA_URL);
        expect(allText(withDoc.pages)).toContain("refuses to update the lockfile");
    });

    it("carries votes and the accepted flag through to passages, which is what endorsement scores", () => {
        // The signal only exists if it survives the passage builder; scoring it
        // is `rank.ts`'s job, but a Doc whose votes never reach a Passage would
        // make `endorsement` silently inert.
        const passages = buildPassages(qaDoc());

        expect(passages.length).toBeGreaterThan(0);
        expect(passages.some((p) => p.votes !== undefined)).toBe(true);
        expect(passages.some((p) => p.accepted === true)).toBe(true);
    });

    it("falls back to cached HTML when the recorded doc has no nodes", async () => {
        new Corpus(root, "record").writeDoc(BOTH_URL, "markdown", { ...markdownDoc(), nodes: [] });

        const result = await createV2Adapter().runQuery(QUERY, new Corpus(root, "replay"));

        expect(allText(result.pages)).toContain("THIS SENTENCE COMES FROM THE CACHED HTML");
    });

    it("falls back to cached HTML when the recorded doc is corrupt", async () => {
        mkdirSync(join(root, "docs"), { recursive: true });
        writeFileSync(join(root, "docs", `${sha(canonicalizeUrl(BOTH_URL))}.json`), "}{");

        const result = await createV2Adapter().runQuery(QUERY, new Corpus(root, "replay"));

        expect(allText(result.pages)).toContain("THIS SENTENCE COMES FROM THE CACHED HTML");
    });

    it("stays offline and deterministic across repeated replays", async () => {
        new Corpus(root, "record").writeDoc(QA_URL, "stackexchange", qaDoc());

        const first = await createV2Adapter().runQuery(QUERY, new Corpus(root, "replay"));
        const second = await createV2Adapter().runQuery(QUERY, new Corpus(root, "replay"));

        expect(JSON.stringify(second.pages)).toBe(JSON.stringify(first.pages));
    });
});

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

describe("oracle with structured documents", () => {
    it("counts a doc-only page towards the ceiling", async () => {
        const before = await createOracleAdapter().runQuery(QUERY, new Corpus(root, "replay"));
        expect(before.pages.map((p) => p.url)).not.toContain(QA_URL);

        new Corpus(root, "record").writeDoc(QA_URL, "stackexchange", qaDoc());
        const after = await createOracleAdapter().runQuery(QUERY, new Corpus(root, "replay"));

        expect(after.pages.map((p) => p.url)).toContain(QA_URL);
        expect(after.totalChars).toBeGreaterThan(before.totalChars);
    });

    it("prefers the doc over the HTML for a URL that has both", async () => {
        new Corpus(root, "record").writeDoc(BOTH_URL, "markdown", markdownDoc());

        const result = await createOracleAdapter().runQuery(QUERY, new Corpus(root, "replay"));
        const text = allText(result.pages);

        expect(text).toContain("THIS SENTENCE COMES FROM THE RECORDED DOC");
        expect(text).not.toContain("THIS SENTENCE COMES FROM THE CACHED HTML");
    });
});
