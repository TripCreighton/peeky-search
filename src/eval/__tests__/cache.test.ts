import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Corpus } from "../cache";

/**
 * These tests exist because of a specific, expensive failure.
 *
 * Recording a 140-query tranche once rate-limited every SearXNG upstream engine
 * in turn. With all of them suspended SearXNG kept answering 200 OK with an
 * empty result list, the recorder read that as success, and 87 queries froze
 * into the corpus as "this query has no results". Nothing failed loudly; the
 * readiness check reported every SERP cached. Labels authored against that
 * corpus were fiction.
 *
 * An empty SERP is a statement about when we asked, not about the query.
 */
describe("Corpus.getSerp", () => {
    let server: Server;
    let baseUrl: string;
    let root: string;

    /** What the stub SearXNG returns next. Mutated per test. */
    let respond: () => { status: number; body: string };

    beforeAll(async () => {
        server = createServer((req, res) => {
            const { status, body } = respond();
            res.writeHead(status, { "content-type": "application/json" });
            res.end(body);
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address();
        if (addr === null || typeof addr === "string") throw new Error("no port");
        baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    function freshCorpus(): Corpus {
        root = mkdtempSync(join(tmpdir(), "peeky-corpus-"));
        return new Corpus(root, "record");
    }

    function cleanup(): void {
        rmSync(root, { recursive: true, force: true });
    }

    it("caches a SERP that actually carries results", async () => {
        const corpus = freshCorpus();
        respond = () => ({
            status: 200,
            body: JSON.stringify({
                results: [{ url: "https://example.com/a", title: "A", engine: "google cse" }],
            }),
        });

        const serp = await corpus.getSerp("some query", baseUrl, 20);

        expect(serp.error).toBeUndefined();
        expect(serp.results).toHaveLength(1);
        expect(corpus.hasSerp("some query")).toBe(true);

        cleanup();
    });

    it("treats a 200 with zero results as an error, not as a fact", async () => {
        const corpus = freshCorpus();
        respond = () => ({ status: 200, body: JSON.stringify({ results: [] }) });

        const serp = await corpus.getSerp("some query", baseUrl, 20);

        expect(serp.error).toBeDefined();
        expect(serp.results).toHaveLength(0);

        cleanup();
    });

    it("does not cache an empty SERP, so the next record run retries it", async () => {
        const corpus = freshCorpus();
        respond = () => ({ status: 200, body: JSON.stringify({ results: [] }) });

        await corpus.getSerp("some query", baseUrl, 20);
        expect(corpus.hasSerp("some query")).toBe(false);

        // The engines recover; the same query now succeeds rather than being
        // skipped as already-cached.
        respond = () => ({
            status: 200,
            body: JSON.stringify({
                results: [{ url: "https://example.com/b", title: "B", engine: "duckduckgo" }],
            }),
        });

        const retried = await corpus.getSerp("some query", baseUrl, 20);

        expect(retried.error).toBeUndefined();
        expect(retried.results).toHaveLength(1);
        expect(corpus.hasSerp("some query")).toBe(true);

        cleanup();
    });

    it("does not cache a SERP that failed with an HTTP error", async () => {
        const corpus = freshCorpus();
        respond = () => ({ status: 500, body: "boom" });

        const serp = await corpus.getSerp("some query", baseUrl, 20);

        expect(serp.error).toContain("500");
        expect(corpus.hasSerp("some query")).toBe(false);

        cleanup();
    });
});
