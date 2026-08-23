import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Corpus, canonicalizeUrl, canonicalizeQuery } from "../cache";
import type { CachedPage, CachedSerp } from "../cache";
import { createV2Adapter } from "../adapters/v2";
import type { Query } from "../types";

const QUERY: Query = {
    id: "test-timeouts",
    text: "request timeout option default",
    category: "api-docs",
    difficulty: 1,
    tranche: 1,
};

const GOOD_URL = "https://docs.example.com/reference/timeouts";
const DEAD_URL = "https://blocked.example.com/questions/12345/timeouts";
const MISSING_URL = "https://never-recorded.example.com/page";

const GOOD_HTML = `<!doctype html><html lang="en"><head><title>Timeouts - Example Reference</title></head>
<body><main>
<h1>Timeouts</h1>
<h2>The timeout option</h2>
<p>Set the timeout option to control how long a request may run before it is aborted by the client.</p>
<p>The default timeout is thirty seconds, and it applies to the entire request including redirects.</p>
<h2>Related posts</h2>
<p>Another article about the timeout option that you might also enjoy reading at some point.</p>
</main></body></html>`;

function sha(input: string): string {
    return createHash("sha256").update(input).digest("hex").slice(0, 40);
}

let root: string;

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "peeky-v2-adapter-"));
    mkdirSync(join(root, "pages"), { recursive: true });
    mkdirSync(join(root, "serp"), { recursive: true });

    const serp: CachedSerp = {
        query: QUERY.text,
        fetchedAt: new Date(0).toISOString(),
        results: [
            { url: GOOD_URL, title: "Timeouts", content: "", score: 1, engine: "test" },
            { url: DEAD_URL, title: "Blocked", content: "", score: 1, engine: "test" },
            { url: MISSING_URL, title: "Missing", content: "", score: 1, engine: "test" },
        ],
    };
    writeFileSync(join(root, "serp", `${sha(canonicalizeQuery(QUERY.text))}.json`), JSON.stringify(serp));

    const good: CachedPage = {
        url: GOOD_URL,
        fetchedAt: new Date(0).toISOString(),
        status: 200,
        contentType: "text/html; charset=utf-8",
        html: GOOD_HTML,
    };
    writeFileSync(join(root, "pages", `${sha(canonicalizeUrl(GOOD_URL))}.json`), JSON.stringify(good));

    // The shape every Stack Exchange page has in the real corpus: recorded, but
    // a 403 with an empty body.
    const dead: CachedPage = {
        url: DEAD_URL,
        fetchedAt: new Date(0).toISOString(),
        status: 403,
        contentType: "text/html",
        html: "",
        error: "HTTP 403",
    };
    writeFileSync(join(root, "pages", `${sha(canonicalizeUrl(DEAD_URL))}.json`), JSON.stringify(dead));
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("createV2Adapter", () => {
    it("identifies itself as v2 and records a serializable config", () => {
        const adapter = createV2Adapter();

        expect(adapter.name).toBe("v2");
        expect(JSON.parse(JSON.stringify(adapter.config))).toEqual(adapter.config);
    });

    it("extracts excerpts from cached HTML without touching the network", async () => {
        const result = await createV2Adapter().runQuery(QUERY, new Corpus(root, "replay"));

        expect(result.queryId).toBe(QUERY.id);
        expect(result.pages.length).toBeGreaterThan(0);
        expect(result.pages[0]?.url).toBe(GOOD_URL);
        expect(result.totalChars).toBeGreaterThan(0);

        const text = result.pages.flatMap((p) => p.excerpts).map((e) => e.text).join(" ");
        expect(text).toContain("timeout option");
    });

    it("populates serpUrls and consideredUrls the way v1 does", async () => {
        const result = await createV2Adapter().runQuery(QUERY, new Corpus(root, "replay"));

        expect(result.serpUrls).toEqual([GOOD_URL, DEAD_URL, MISSING_URL]);
        expect(result.consideredUrls).toEqual([GOOD_URL, DEAD_URL, MISSING_URL]);
    });

    it("degrades a recorded 403 and a corpus miss into dead results, not a failed query", async () => {
        const result = await createV2Adapter().runQuery(QUERY, new Corpus(root, "replay"));

        expect(result.error).toBeUndefined();
        expect(result.pages.map((p) => p.url)).not.toContain(DEAD_URL);
        expect(result.pages.map((p) => p.url)).not.toContain(MISSING_URL);
    });

    it("degrades a Q&A URL with no recorded doc exactly as v1 does", async () => {
        // This corpus was recorded WITHOUT structured adapters, so the Q&A URL
        // is an HTTP 403 with an empty body and nothing else. Replay never
        // calls an API to make up the difference, so the URL degrades exactly
        // as it does for v1. `structured-docs.test.ts` covers the other half:
        // a corpus that DID record the adapter's output.
        const result = await createV2Adapter().runQuery(QUERY, new Corpus(root, "replay"));

        expect(result.pages.some((p) => p.url === DEAD_URL)).toBe(false);
        expect(result.pages.length).toBe(1);
    });

    it("raises a SERP miss as a query-level failure", async () => {
        const unknown: Query = { ...QUERY, id: "unknown", text: "a query never recorded" };

        await expect(createV2Adapter().runQuery(unknown, new Corpus(root, "replay"))).rejects.toThrow(/Corpus miss/);
    });

    it("respects a caller-supplied budget", async () => {
        const result = await createV2Adapter({ budget: { totalChars: 200 } }).runQuery(
            QUERY,
            new Corpus(root, "replay"),
        );

        expect(result.totalChars).toBeLessThanOrEqual(200);
    });

    it("is deterministic across repeated replays", async () => {
        const first = await createV2Adapter().runQuery(QUERY, new Corpus(root, "replay"));
        const second = await createV2Adapter().runQuery(QUERY, new Corpus(root, "replay"));

        expect(JSON.stringify(second.pages)).toBe(JSON.stringify(first.pages));
    });
});
