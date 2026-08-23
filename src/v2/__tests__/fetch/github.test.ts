import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { githubAdapter, parseGithubUrl } from "../../fetch/github";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

// Fixtures follow the response shape of:
//   GET https://raw.githubusercontent.com/{owner}/{repo}/HEAD/README.md
//   GET https://api.github.com/repos/{owner}/{repo}/issues/{n}
//   GET https://api.github.com/repos/{owner}/{repo}/issues/{n}/comments
//
// Field names and structure come from a real capture; the README, the issue and
// comment bodies, and every user record are synthetic. Committing the real ones
// would redistribute other people's writing and profile data as test data.
const readmeFixture = readFileSync(join(fixturesDir, "github-readme.md"), "utf-8");
const issueFixture = JSON.parse(readFileSync(join(fixturesDir, "github-issue.json"), "utf-8")) as unknown;
const commentsFixture = JSON.parse(readFileSync(join(fixturesDir, "github-issue-comments.json"), "utf-8")) as unknown;

function textResponse(body: string, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
    } as Response;
}

function jsonTextResponse(body: unknown, status = 200): Response {
    return textResponse(JSON.stringify(body), status);
}

describe("parseGithubUrl", () => {
    it("parses a repo main page", () => {
        expect(parseGithubUrl("https://github.com/vitejs/vite")).toEqual({ owner: "vitejs", repo: "vite", kind: "repo" });
    });

    it("parses an issue URL", () => {
        expect(parseGithubUrl("https://github.com/vitejs/vite/issues/1")).toEqual({
            owner: "vitejs",
            repo: "vite",
            kind: "issue",
            number: 1,
        });
    });

    it("parses a discussion URL", () => {
        expect(parseGithubUrl("https://github.com/vitejs/vite/discussions/42")).toEqual({
            owner: "vitejs",
            repo: "vite",
            kind: "discussion",
            number: 42,
        });
    });

    it("returns null for a non-github host", () => {
        expect(parseGithubUrl("https://gitlab.com/vitejs/vite")).toBeNull();
    });

    it("returns null for a page github.com serves that isn't owner/repo/issues/discussions", () => {
        expect(parseGithubUrl("https://github.com/vitejs/vite/pulls")).toBeNull();
    });
});

describe("githubAdapter.canHandle", () => {
    it("claims github.com repo/issue/discussion URLs", () => {
        expect(githubAdapter.canHandle("https://github.com/vitejs/vite")).toBe(true);
        expect(githubAdapter.canHandle("https://github.com/vitejs/vite/issues/1")).toBe(true);
    });

    it("does not claim unrelated URLs", () => {
        expect(githubAdapter.canHandle("https://example.com")).toBe(false);
    });
});

describe("githubAdapter.fetch — response mapping against captured-shape payloads", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("fetches the raw README for a repo main page", async () => {
        const fetchMock = vi.fn(async (input: string | URL) => {
            const url = input.toString();
            if (url.includes("raw.githubusercontent.com") && url.endsWith("/HEAD/README.md")) {
                return textResponse(readmeFixture);
            }
            return textResponse("", 404);
        });
        vi.stubGlobal("fetch", fetchMock);

        const doc = await githubAdapter.fetch("https://github.com/vitejs/vite");

        expect(doc).not.toBeNull();
        expect(doc?.source).toBe("github");
        expect(doc?.kind).toBe("guide");
        expect(doc?.nodes.length).toBeGreaterThan(0);
        // README fixture has markdown headings — at least one should survive as a heading node.
        expect(doc?.nodes.some((n) => n.kind === "heading")).toBe(true);
    });

    it("maps an issue and its comments into question/answer nodes with author and date", async () => {
        const fetchMock = vi.fn(async (input: string | URL) => {
            const url = input.toString();
            if (url.includes("/comments")) return jsonTextResponse(commentsFixture);
            if (url.includes("/issues/1")) return jsonTextResponse(issueFixture);
            return textResponse("", 404);
        });
        vi.stubGlobal("fetch", fetchMock);

        const doc = await githubAdapter.fetch("https://github.com/vitejs/vite/issues/1");

        expect(doc).not.toBeNull();
        expect(doc?.source).toBe("github");
        expect(doc?.kind).toBe("issue");
        expect(doc?.title).toContain("img path");

        const questionNodes = doc?.nodes.filter((n) => n.kind === "question") ?? [];
        expect(questionNodes.length).toBeGreaterThan(0);
        expect(questionNodes[0]?.author).toBe("reporter-one");

        // The issue body contains a fenced code block — it should survive as its own code node.
        expect(doc?.nodes.some((n) => n.kind === "code")).toBe(true);

        // The one comment should show up as an "answer" kind node.
        const answerNodes = doc?.nodes.filter((n) => n.kind === "answer") ?? [];
        expect(answerNodes.length).toBeGreaterThan(0);
    });

    it("falls back to HTML for discussions (no unauthenticated REST endpoint)", async () => {
        const fetchMock = vi.fn(async () =>
            textResponse(
                "<html><head><title>Some discussion</title></head><body><main><p>Discussion body text here.</p></main></body></html>"
            )
        );
        vi.stubGlobal("fetch", fetchMock);

        const doc = await githubAdapter.fetch("https://github.com/vitejs/vite/discussions/1");

        expect(doc).not.toBeNull();
        expect(doc?.source).toBe("github");
    });

    it("returns null on network failure rather than throwing", async () => {
        const fetchMock = vi.fn(async () => {
            throw new Error("network down");
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(githubAdapter.fetch("https://github.com/vitejs/vite")).resolves.toBeNull();
    });

    it("returns null for a URL it does not recognize", async () => {
        const doc = await githubAdapter.fetch("https://example.com/foo");
        expect(doc).toBeNull();
    });
});
