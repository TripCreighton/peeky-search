/**
 * Content-addressed corpus cache.
 *
 * Every page and every SERP the harness has ever seen is frozen on disk. Eval
 * runs replay from the cache and never touch the network, which is what makes
 * them reproducible, fast, and free of rate limits. Only an explicit
 * `record` pass is allowed to fetch.
 *
 * STRUCTURED DOCUMENTS
 * --------------------
 * A corpus holds three things, not two: `pages/` (raw HTML), `serp/` (search
 * results), and `docs/` (serialized v2 `Doc`s produced by a structured source
 * adapter — the Stack Exchange API, the GitHub API, the npm registry, a
 * markdown sibling).
 *
 * `docs/` exists because some sources cannot be scraped at all. stackoverflow.com
 * answers every recorder User-Agent with HTTP 403, so its pages are frozen in the
 * corpus as empty 403 bodies; `api.stackexchange.com` answers the same question
 * with vote counts and accepted-answer flags attached. A replay has no network,
 * so the only way that content can reach a run is if the RECORDER froze the
 * adapter's output too.
 *
 * Two invariants keep this honest:
 *   - A recorded Doc NEVER replaces the raw HTML. Both are stored, so v1 (which
 *     can only read HTML) and v2 see the same universe of URLs.
 *   - `docs/` is optional and created lazily. A corpus recorded before this
 *     existed reads back byte-for-byte identically, revision included.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Doc } from "../v2/types";

export type CacheMode = "replay" | "record" | "refresh";

export interface CachedPage {
    url: string;
    /** URL after redirects, when it differs. */
    finalUrl?: string;
    fetchedAt: string;
    status: number;
    contentType: string;
    html: string;
    error?: string;
}

export interface CachedSerpResult {
    url: string;
    title: string;
    content: string;
    score: number;
    engine: string;
}

export interface CachedSerp {
    query: string;
    fetchedAt: string;
    results: CachedSerpResult[];
    error?: string;
    /**
     * The explicit engine selection this SERP was recorded with, when one was
     * given. Provenance matters: a tranche recorded off a different engine set
     * differs from another in retrieval SOURCE, not just in queries, and
     * comparing the two would confound the result with the search backend.
     */
    engines?: string;
}

/**
 * A structured document frozen alongside the raw HTML for the same URL.
 *
 * `adapter` records WHICH source produced it, so a corpus can report what its
 * structured coverage actually consists of rather than just how much of it
 * there is.
 */
export interface CachedDoc {
    /** The SERP URL this was recorded for — the key, not necessarily `doc.url`. */
    url: string;
    fetchedAt: string;
    /** Name of the `SourceAdapter` that produced it, e.g. "stackexchange". */
    adapter: string;
    doc: Doc;
}

export class CorpusMissError extends Error {
    constructor(kind: string, key: string) {
        super(
            `Corpus miss (${kind}): ${key}\n` +
            `Run \`peeky-eval record\` to fetch it, or use --mode record for this run.`
        );
        this.name = "CorpusMissError";
    }
}

function sha(input: string): string {
    return createHash("sha256").update(input).digest("hex").slice(0, 40);
}

/** Normalize a URL so trivial variations share a cache entry. */
export function canonicalizeUrl(url: string): string {
    try {
        const u = new URL(url);
        u.hash = "";
        // Strip tracking params that never change content.
        for (const p of [...u.searchParams.keys()]) {
            if (/^(utm_|fbclid|gclid|ref|source)/i.test(p)) u.searchParams.delete(p);
        }
        if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
            u.pathname = u.pathname.slice(0, -1);
        }
        return u.toString();
    } catch {
        return url;
    }
}

/** Normalize a query so whitespace and case don't fragment the cache. */
export function canonicalizeQuery(query: string): string {
    return query.trim().replace(/\s+/g, " ").toLowerCase();
}

const USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";

export class Corpus {
    private readonly pagesDir: string;
    private readonly serpDir: string;
    private readonly docsDir: string;

    constructor(
        readonly root: string,
        private readonly mode: CacheMode = "replay"
    ) {
        this.pagesDir = join(root, "pages");
        this.serpDir = join(root, "serp");
        this.docsDir = join(root, "docs");
        mkdirSync(this.pagesDir, { recursive: true });
        mkdirSync(this.serpDir, { recursive: true });
        // `docs/` is created on first write, never on open. Constructing a
        // Corpus over an existing corpus must not modify it — a replay is a
        // read, and an eval root that has never recorded a structured document
        // should stay exactly as it was found.
    }

    /**
     * A stable fingerprint of the corpus contents, recorded with each run.
     *
     * `docs/` participates only when it is non-empty, so a corpus with no
     * structured documents keeps the exact revision it had before `docs/`
     * existed — otherwise every previously recorded run would appear to have
     * been taken against a different corpus.
     */
    revision(): string {
        const pages = existsSync(this.pagesDir) ? readdirSync(this.pagesDir).sort() : [];
        const serps = existsSync(this.serpDir) ? readdirSync(this.serpDir).sort() : [];
        const docs = existsSync(this.docsDir) ? readdirSync(this.docsDir).sort() : [];
        const base = `${pages.join(",")}|${serps.join(",")}`;
        return sha(docs.length === 0 ? base : `${base}|${docs.join(",")}`).slice(0, 12);
    }

    stats(): { pages: number; serps: number; docs: number } {
        return {
            pages: existsSync(this.pagesDir) ? readdirSync(this.pagesDir).length : 0,
            serps: existsSync(this.serpDir) ? readdirSync(this.serpDir).length : 0,
            docs: existsSync(this.docsDir) ? readdirSync(this.docsDir).length : 0,
        };
    }

    private pagePath(url: string): string {
        return join(this.pagesDir, `${sha(canonicalizeUrl(url))}.json`);
    }

    private serpPath(query: string): string {
        return join(this.serpDir, `${sha(canonicalizeQuery(query))}.json`);
    }

    /** Structured documents are keyed by URL exactly as pages are, so the two stay aligned. */
    private docPath(url: string): string {
        return join(this.docsDir, `${sha(canonicalizeUrl(url))}.json`);
    }

    hasPage(url: string): boolean {
        return existsSync(this.pagePath(url));
    }

    hasSerp(query: string): boolean {
        return existsSync(this.serpPath(query));
    }

    hasDoc(url: string): boolean {
        return existsSync(this.docPath(url));
    }

    /**
     * Read the structured document recorded for a URL, or null when there is
     * none.
     *
     * A missing — or corrupt — Doc is NEVER an error. The caller's job is to
     * fall back to the cached HTML, which is always present for the same URL,
     * so a half-recorded `docs/` degrades to the HTML-only behaviour rather
     * than failing a run.
     */
    readDoc(url: string): CachedDoc | null {
        const path = this.docPath(url);
        if (!existsSync(path)) return null;
        try {
            return JSON.parse(readFileSync(path, "utf-8")) as CachedDoc;
        } catch {
            return null;
        }
    }

    /**
     * Freeze a structured document for a URL. Only a recording pass calls this.
     *
     * The raw HTML for the same URL is deliberately left in place: v1 can read
     * nothing else, and the two pipelines must be compared over the same set of
     * URLs.
     */
    writeDoc(url: string, adapter: string, doc: Doc): void {
        if (this.mode === "replay") {
            throw new Error(`refusing to write a structured doc in replay mode: ${url}`);
        }
        mkdirSync(this.docsDir, { recursive: true });
        const entry: CachedDoc = {
            url,
            fetchedAt: new Date().toISOString(),
            adapter,
            doc,
        };
        writeFileSync(this.docPath(url), JSON.stringify(entry, null, 2));
    }

    /** Every structured document on disk. Used for corpus reporting, not for runs. */
    allDocs(): CachedDoc[] {
        if (!existsSync(this.docsDir)) return [];
        const docs: CachedDoc[] = [];
        for (const file of readdirSync(this.docsDir).sort()) {
            if (!file.endsWith(".json")) continue;
            try {
                docs.push(JSON.parse(readFileSync(join(this.docsDir, file), "utf-8")) as CachedDoc);
            } catch {
                // A corrupt entry is invisible to a run; keep it invisible here too.
            }
        }
        return docs;
    }

    readPage(url: string): CachedPage | null {
        const path = this.pagePath(url);
        if (!existsSync(path)) return null;
        return JSON.parse(readFileSync(path, "utf-8")) as CachedPage;
    }

    readSerp(query: string): CachedSerp | null {
        const path = this.serpPath(query);
        if (!existsSync(path)) return null;
        return JSON.parse(readFileSync(path, "utf-8")) as CachedSerp;
    }

    /**
     * Get a page, fetching only if the mode allows it.
     * In replay mode a miss is an error, never a silent network call — a run
     * that quietly fetched would not be reproducible.
     */
    async getPage(url: string, timeoutMs = 15000): Promise<CachedPage> {
        const cached = this.readPage(url);
        if (cached && this.mode !== "refresh") return cached;

        if (this.mode === "replay") {
            throw new CorpusMissError("page", url);
        }

        const page = await fetchPage(url, timeoutMs);
        writeFileSync(this.pagePath(url), JSON.stringify(page, null, 2));
        return page;
    }

    async getSerp(
        query: string,
        searxngUrl: string,
        maxResults: number,
        timeoutMs = 15000,
        engines?: string
    ): Promise<CachedSerp> {
        const cached = this.readSerp(query);
        if (cached && this.mode !== "refresh") return cached;

        if (this.mode === "replay") {
            throw new CorpusMissError("serp", query);
        }

        const serp = await fetchSerp(query, searxngUrl, maxResults, timeoutMs, engines);
        // A failed SERP is never cached. Unlike a page — where a 403 is a real,
        // stable property of the source worth freezing — an empty or errored
        // SERP means we learned nothing about the query, and caching it would
        // silently freeze a rate-limit window into the corpus as ground truth.
        // Leaving it uncached makes the next record run retry it.
        if (serp.error === undefined) {
            writeFileSync(this.serpPath(query), JSON.stringify(serp, null, 2));
        }
        return serp;
    }
}

async function fetchPage(url: string, timeoutMs: number): Promise<CachedPage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const fetchedAt = new Date().toISOString();

    try {
        const res = await fetch(url, {
            signal: controller.signal,
            redirect: "follow",
            headers: {
                "User-Agent": USER_AGENT,
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
        });

        const contentType = res.headers.get("content-type") ?? "";
        const html = await res.text();

        const page: CachedPage = {
            url,
            fetchedAt,
            status: res.status,
            contentType,
            html,
        };
        if (res.url && res.url !== url) page.finalUrl = res.url;
        if (!res.ok) page.error = `HTTP ${res.status}`;
        return page;
    } catch (err) {
        return {
            url,
            fetchedAt,
            status: 0,
            contentType: "",
            html: "",
            error: err instanceof Error ? err.message : "fetch failed",
        };
    } finally {
        clearTimeout(timer);
    }
}

async function fetchSerp(
    query: string,
    searxngUrl: string,
    maxResults: number,
    timeoutMs: number,
    engines?: string
): Promise<CachedSerp> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const fetchedAt = new Date().toISOString();

    try {
        const searchUrl = new URL("/search", searxngUrl);
        searchUrl.searchParams.set("q", query);
        searchUrl.searchParams.set("format", "json");
        // SearXNG honours an explicit selection even for engines marked
        // `disabled: true` in settings.yml, so the recorder can reach engines the
        // shipped product config leaves off WITHOUT editing that config. Keeping
        // the two separate is the point: the recorder is free to experiment while
        // the product's defaults stay exactly as users installed them.
        if (engines !== undefined) searchUrl.searchParams.set("engines", engines);

        const res = await fetch(searchUrl.toString(), {
            signal: controller.signal,
            headers: { Accept: "application/json" },
        });

        if (!res.ok) {
            return { query, fetchedAt, results: [], error: `SearXNG HTTP ${res.status}` };
        }

        const data = (await res.json()) as {
            results?: Array<{
                url: string;
                title?: string;
                content?: string;
                score?: number;
                engine?: string;
            }>;
        };

        const results = (data.results ?? []).slice(0, maxResults).map((r) => ({
            url: r.url,
            title: r.title ?? "",
            content: r.content ?? "",
            score: r.score ?? 1,
            engine: r.engine ?? "unknown",
        }));

        if (results.length === 0) {
            const empty: CachedSerp = {
                query,
                fetchedAt,
                results: [],
                error: "SearXNG returned 0 results (engines blocked, rate-limited, or captcha?)",
            };
            if (engines !== undefined) empty.engines = engines;
            return empty;
        }

        const serp: CachedSerp = { query, fetchedAt, results };
        if (engines !== undefined) serp.engines = engines;
        return serp;
    } catch (err) {
        return {
            query,
            fetchedAt,
            results: [],
            error: err instanceof Error ? err.message : "serp fetch failed",
        };
    } finally {
        clearTimeout(timer);
    }
}
