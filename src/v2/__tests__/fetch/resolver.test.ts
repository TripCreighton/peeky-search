import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveAdapter, fetchDoc } from "../../fetch/resolver";

function textResponse(body: string, status = 200, contentType = "text/html"): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
        text: async () => body,
        json: async () => JSON.parse(body),
        url: "",
    } as unknown as Response;
}

describe("resolveAdapter", () => {
    it("picks the Stack Exchange adapter for an SE URL", () => {
        expect(resolveAdapter("https://stackoverflow.com/questions/1/x")?.name).toBe("stackexchange");
    });

    it("picks the GitHub adapter for a github.com URL", () => {
        expect(resolveAdapter("https://github.com/foo/bar")?.name).toBe("github");
    });

    it("picks the registry adapter for an npmjs.com package page", () => {
        expect(resolveAdapter("https://www.npmjs.com/package/is-odd")?.name).toBe("registry");
    });

    it("falls through to the markdown adapter for an arbitrary doc host", () => {
        expect(resolveAdapter("https://react.dev/reference/react/useEffect")?.name).toBe("markdown");
    });

    it("returns null for a non-http(s) URL", () => {
        expect(resolveAdapter("ftp://example.com/file")).toBeNull();
    });
});

describe("fetchDoc", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("falls through from a failing structured adapter to generic HTML", async () => {
        // A Stack Exchange URL where the API is unreachable (network failure)
        // should fall all the way through markdown (no .md sibling on SE) to
        // the generic HTML adapter, rather than returning null outright.
        const fetchMock = vi.fn(async (input: string | URL) => {
            const url = input.toString();
            if (url.includes("api.stackexchange.com")) {
                throw new Error("network down");
            }
            // markdown probe and generic HTML both hit the same URL family; give HTML.
            return textResponse("<html><head><title>T</title></head><body><main><p>Body text.</p></main></body></html>");
        });
        vi.stubGlobal("fetch", fetchMock);

        const doc = await fetchDoc("https://stackoverflow.com/questions/1/x");

        expect(doc).not.toBeNull();
        expect(doc?.source).toBe("html");
    });

    it("returns null when every adapter fails", async () => {
        const fetchMock = vi.fn(async () => {
            throw new Error("network down");
        });
        vi.stubGlobal("fetch", fetchMock);

        const doc = await fetchDoc("https://example.com/some-page");

        expect(doc).toBeNull();
    });
});
