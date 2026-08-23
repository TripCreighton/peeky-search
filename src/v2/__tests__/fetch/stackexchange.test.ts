import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stackExchangeAdapter, parseStackExchangeUrl, siteFromHostname } from "../../fetch/stackexchange";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

// Fixtures follow the exact response shape of:
//   GET /2.3/questions/{id}?site=stackoverflow&filter=withbody
//   GET /2.3/questions/{id}/answers?site=stackoverflow&filter=withbody&sort=votes&order=desc
//
// Structure, field names, ids, scores, dates and the accepted flag are taken
// from a real capture, because those are what the adapter maps. The post bodies
// and every user record are synthetic: real ones would mean redistributing
// other people's writing and their profile data as test data.
const questionFixture = JSON.parse(readFileSync(join(fixturesDir, "stackexchange-question.json"), "utf-8")) as unknown;
const answersFixture = JSON.parse(readFileSync(join(fixturesDir, "stackexchange-answers.json"), "utf-8")) as unknown;

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as Response;
}

describe("siteFromHostname / parseStackExchangeUrl", () => {
    it("resolves top-level SE family sites", () => {
        expect(siteFromHostname("stackoverflow.com")).toBe("stackoverflow");
        expect(siteFromHostname("superuser.com")).toBe("superuser");
        expect(siteFromHostname("serverfault.com")).toBe("serverfault");
        expect(siteFromHostname("askubuntu.com")).toBe("askubuntu");
    });

    it("resolves *.stackexchange.com subdomains", () => {
        expect(siteFromHostname("dba.stackexchange.com")).toBe("dba");
        expect(siteFromHostname("unix.stackexchange.com")).toBe("unix");
        expect(siteFromHostname("physics.stackexchange.com")).toBe("physics");
        expect(siteFromHostname("webmasters.stackexchange.com")).toBe("webmasters");
    });

    it("returns null for non-SE hosts", () => {
        expect(siteFromHostname("example.com")).toBeNull();
        expect(siteFromHostname("reactjs.org")).toBeNull();
    });

    it("extracts the question id from /questions/{id}/slug", () => {
        const parsed = parseStackExchangeUrl("https://stackoverflow.com/questions/231767/what-does-the-yield-keyword-do");
        expect(parsed).toEqual({ site: "stackoverflow", questionId: 231767 });
    });

    it("extracts the question id from the short /q/{id} form", () => {
        const parsed = parseStackExchangeUrl("https://unix.stackexchange.com/q/12345");
        expect(parsed).toEqual({ site: "unix", questionId: 12345 });
    });

    it("extracts the answer id from the short /a/{id} form", () => {
        const parsed = parseStackExchangeUrl("https://stackoverflow.com/a/231855");
        expect(parsed).toEqual({ site: "stackoverflow", answerId: 231855 });
    });

    it("returns null for a non-SE URL", () => {
        expect(parseStackExchangeUrl("https://example.com/questions/1")).toBeNull();
    });
});

describe("stackExchangeAdapter.canHandle", () => {
    it("claims Stack Overflow question URLs", () => {
        expect(stackExchangeAdapter.canHandle("https://stackoverflow.com/questions/231767/x")).toBe(true);
    });

    it("claims other SE family URLs", () => {
        expect(stackExchangeAdapter.canHandle("https://dba.stackexchange.com/questions/1/x")).toBe(true);
    });

    it("does not claim unrelated URLs", () => {
        expect(stackExchangeAdapter.canHandle("https://example.com/questions/1")).toBe(false);
        expect(stackExchangeAdapter.canHandle("https://github.com/foo/bar")).toBe(false);
    });
});

describe("stackExchangeAdapter.fetch — response mapping against a captured-shape payload", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("maps the question and answers into a Doc carrying votes/accepted/author/date", async () => {
        const fetchMock = vi.fn(async (input: string | URL) => {
            const url = input.toString();
            if (url.includes("/answers")) return jsonResponse(answersFixture);
            return jsonResponse(questionFixture);
        });
        vi.stubGlobal("fetch", fetchMock);

        const doc = await stackExchangeAdapter.fetch("https://stackoverflow.com/questions/231767/what-does-the-yield-keyword-do-in-python");

        expect(doc).not.toBeNull();
        expect(doc?.source).toBe("stackexchange");
        expect(doc?.kind).toBe("qa");
        // The API escapes titles: the fixture holds `&quot;yield&quot;`. An
        // undecoded title reaches the caller verbatim and renders as markup.
        expect(doc?.title).toBe('What does the "yield" keyword do in Python?');
        expect(doc?.title).not.toContain("&quot;");

        // Question carries its own score as votes.
        const questionNodes = doc?.nodes.filter((n) => n.kind === "question") ?? [];
        expect(questionNodes.length).toBeGreaterThan(0);
        expect(questionNodes[0]?.votes).toBe(13135);

        // The accepted answer (id 231855, score 18317) must be marked accepted with its real vote count.
        const acceptedNodes = doc?.nodes.filter((n) => n.kind === "answer" && n.accepted === true) ?? [];
        expect(acceptedNodes.length).toBeGreaterThan(0);
        expect(acceptedNodes[0]?.votes).toBe(18317);
        expect(acceptedNodes[0]?.author).toBe("Answerer 1");

        // A non-accepted answer must be marked accepted: false, not just missing.
        const answerNodes = doc?.nodes.filter((n) => n.kind === "answer") ?? [];
        const nonAccepted = answerNodes.filter((n) => n.accepted === false);
        expect(nonAccepted.length).toBeGreaterThan(0);

        // Code blocks inside the answer body keep their own "code" kind (not
        // relabeled to "answer") but still carry the answer's endorsement.
        const codeNodes = doc?.nodes.filter((n) => n.kind === "code") ?? [];
        expect(codeNodes.length).toBeGreaterThan(0);
        expect(codeNodes[0]?.votes).toBeDefined();

        // order is dense and ascending across the whole doc.
        const orders = doc?.nodes.map((n) => n.order) ?? [];
        expect(orders).toEqual([...orders].sort((a, b) => a - b));
        expect(new Set(orders).size).toBe(orders.length);
    });

    it("returns null on a 429 rather than throwing", async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ items: [] }, 429));
        vi.stubGlobal("fetch", fetchMock);

        const doc = await stackExchangeAdapter.fetch("https://stackoverflow.com/questions/231767/x");

        expect(doc).toBeNull();
    });

    it("returns null when the response carries a backoff field", async () => {
        const fetchMock = vi.fn(async (input: string | URL) => {
            const url = input.toString();
            if (url.includes("/answers")) return jsonResponse({ items: [], backoff: 10 });
            return jsonResponse({ items: [], backoff: 10 });
        });
        vi.stubGlobal("fetch", fetchMock);

        const doc = await stackExchangeAdapter.fetch("https://stackoverflow.com/questions/231767/x");

        expect(doc).toBeNull();
    });

    it("returns null on a network failure rather than throwing", async () => {
        const fetchMock = vi.fn(async () => {
            throw new Error("network down");
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(stackExchangeAdapter.fetch("https://stackoverflow.com/questions/231767/x")).resolves.toBeNull();
    });

    it("returns null for a URL it does not recognize", async () => {
        const doc = await stackExchangeAdapter.fetch("https://example.com/not-se");
        expect(doc).toBeNull();
    });
});
