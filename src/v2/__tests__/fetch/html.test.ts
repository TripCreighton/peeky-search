import { describe, it, expect, vi, afterEach } from "vitest";
import { htmlAdapter } from "../../fetch/html";

function htmlResponse(body: string, status = 200, contentType = "text/html; charset=utf-8"): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
        text: async () => body,
        url: "",
    } as unknown as Response;
}

describe("htmlAdapter.canHandle", () => {
    it("claims any http(s) URL", () => {
        expect(htmlAdapter.canHandle("https://example.com/anything")).toBe(true);
    });

    it("rejects non-http(s) URLs", () => {
        expect(htmlAdapter.canHandle("not a url")).toBe(false);
    });
});

describe("htmlAdapter.fetch", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("extracts main content into DocNodes with source html and kind unknown", async () => {
        const fetchMock = vi.fn(async () =>
            htmlResponse(`
                <html>
                <head><title>Example Page</title></head>
                <body>
                    <nav>Home | About</nav>
                    <main>
                        <h1>Heading</h1>
                        <p>Real content paragraph.</p>
                    </main>
                    <footer>Copyright 2026</footer>
                </body>
                </html>
            `)
        );
        vi.stubGlobal("fetch", fetchMock);

        const doc = await htmlAdapter.fetch("https://example.com/page");

        expect(doc).not.toBeNull();
        expect(doc?.source).toBe("html");
        expect(doc?.kind).toBe("unknown");
        expect(doc?.title).toBe("Example Page");
        expect(doc?.nodes.some((n) => n.text === "Real content paragraph.")).toBe(true);
        // Boilerplate (nav/footer) should not leak into the node list.
        expect(doc?.nodes.some((n) => n.text.includes("Home | About"))).toBe(false);
    });

    it("returns null for a non-HTML content type", async () => {
        const fetchMock = vi.fn(async () => htmlResponse("{}", 200, "application/json"));
        vi.stubGlobal("fetch", fetchMock);

        const doc = await htmlAdapter.fetch("https://example.com/data.json");

        expect(doc).toBeNull();
    });

    it("returns null on a non-2xx response", async () => {
        const fetchMock = vi.fn(async () => htmlResponse("not found", 404));
        vi.stubGlobal("fetch", fetchMock);

        const doc = await htmlAdapter.fetch("https://example.com/missing");

        expect(doc).toBeNull();
    });

    it("returns null on network failure rather than throwing", async () => {
        const fetchMock = vi.fn(async () => {
            throw new Error("network down");
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(htmlAdapter.fetch("https://example.com/page")).resolves.toBeNull();
    });
});
