import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { markdownAdapter, hostProbeState, MAX_CONSECUTIVE_MISSES, MAX_TRACKED_HOSTS } from "../../fetch/markdown";

function headerResponse(body: string, contentType: string, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
        text: async () => body,
    } as unknown as Response;
}

describe("markdownAdapter.canHandle", () => {
    it("claims arbitrary doc-site URLs", () => {
        expect(markdownAdapter.canHandle("https://react.dev/reference/react/useEffect")).toBe(true);
        expect(markdownAdapter.canHandle("https://tailwindcss.com/docs/installation")).toBe(true);
    });

    it("excludes hosts already owned by a more specific adapter", () => {
        expect(markdownAdapter.canHandle("https://stackoverflow.com/questions/1/x")).toBe(false);
        expect(markdownAdapter.canHandle("https://github.com/foo/bar")).toBe(false);
        expect(markdownAdapter.canHandle("https://npmjs.com/package/foo")).toBe(false);
    });

    it("rejects non-http(s) URLs", () => {
        expect(markdownAdapter.canHandle("not a url")).toBe(false);
    });
});

describe("markdownAdapter.fetch", () => {
    beforeEach(() => {
        hostProbeState.clear();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("accepts a text/markdown response (verified live: nextjs.org, docs.anthropic.com)", async () => {
        const fetchMock = vi.fn(async () => headerResponse("# Title\n\nSome real content here.\n", "text/markdown; charset=utf-8"));
        vi.stubGlobal("fetch", fetchMock);

        const doc = await markdownAdapter.fetch("https://nextjs.org/docs/app/building-your-application/routing");

        expect(doc).not.toBeNull();
        expect(doc?.source).toBe("markdown");
        expect(doc?.title).toBe("Title");
        expect(hostProbeState.get("nextjs.org")).toEqual({ consecutiveMisses: 0, confirmedGood: true });
    });

    it("accepts a text/plain response (verified live: react.dev)", async () => {
        const fetchMock = vi.fn(async () => headerResponse("# useEffect\n\nHook reference content.\n", "text/plain; charset=utf-8"));
        vi.stubGlobal("fetch", fetchMock);

        const doc = await markdownAdapter.fetch("https://react.dev/reference/react/useEffect");

        expect(doc).not.toBeNull();
        expect(doc?.source).toBe("markdown");
    });

    // Reproduces the exact case found live this session: vite.dev/guide/ 404s
    // while vite.dev/guide/why returns 200 markdown. A single miss must not
    // disable the host for other paths.
    it("does not let a miss on one path disable a hit on another path of the same host", async () => {
        const fetchMock = vi.fn(async (input: string | URL) => {
            const url = input.toString();
            if (url === "https://vite.dev/guide/.md") return headerResponse("not found", "text/html", 404);
            if (url === "https://vite.dev/guide/why.md") return headerResponse("# Why Vite\n\nBecause it's fast.\n", "text/markdown");
            throw new Error(`unexpected URL: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);

        const missDoc = await markdownAdapter.fetch("https://vite.dev/guide/");
        expect(missDoc).toBeNull();
        expect(hostProbeState.get("vite.dev")?.confirmedGood).toBe(false);
        expect(hostProbeState.get("vite.dev")?.consecutiveMisses).toBe(1);

        // This is the assertion that would fail against the old
        // "cache the first result as the host's permanent answer" logic.
        const hitDoc = await markdownAdapter.fetch("https://vite.dev/guide/why");
        expect(hitDoc).not.toBeNull();
        expect(hitDoc?.source).toBe("markdown");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(hostProbeState.get("vite.dev")).toEqual({ consecutiveMisses: 0, confirmedGood: true });
    });

    it("does not permanently disable a host after fewer than MAX_CONSECUTIVE_MISSES misses", async () => {
        const fetchMock = vi.fn(async () => headerResponse("not found", "text/html", 404));
        vi.stubGlobal("fetch", fetchMock);

        for (let i = 0; i < MAX_CONSECUTIVE_MISSES - 1; i++) {
            const doc = await markdownAdapter.fetch(`https://tailwindcss.com/docs/page-${i}`);
            expect(doc).toBeNull();
        }

        // Still under the threshold: the adapter must still be attempting the network call.
        expect(fetchMock).toHaveBeenCalledTimes(MAX_CONSECUTIVE_MISSES - 1);
        expect(hostProbeState.get("tailwindcss.com")?.consecutiveMisses).toBe(MAX_CONSECUTIVE_MISSES - 1);
    });

    it("permanently disables a host only after MAX_CONSECUTIVE_MISSES consecutive misses with no hit ever", async () => {
        const fetchMock = vi.fn(async () => headerResponse("not found", "text/html", 404));
        vi.stubGlobal("fetch", fetchMock);

        for (let i = 0; i < MAX_CONSECUTIVE_MISSES; i++) {
            await markdownAdapter.fetch(`https://tailwindcss.com/docs/page-${i}`);
        }
        expect(fetchMock).toHaveBeenCalledTimes(MAX_CONSECUTIVE_MISSES);

        // The threshold is now reached: no further network call should be made for this host.
        const doc = await markdownAdapter.fetch("https://tailwindcss.com/docs/one-more-page");

        expect(doc).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(MAX_CONSECUTIVE_MISSES);
    });

    it("a hit resets the miss streak, so a host with mixed coverage never gets permanently disabled", async () => {
        let call = 0;
        const fetchMock = vi.fn(async () => {
            call++;
            // Miss, miss, hit, miss, miss, hit, ... — never MAX_CONSECUTIVE_MISSES in a row.
            if (call % 3 === 0) return headerResponse("# Heading\n\nContent.\n", "text/markdown");
            return headerResponse("not found", "text/html", 404);
        });
        vi.stubGlobal("fetch", fetchMock);

        for (let i = 0; i < 9; i++) {
            await markdownAdapter.fetch(`https://mixed-coverage.example/page-${i}`);
        }

        // All 9 attempts should have hit the network — the host was never disabled.
        expect(fetchMock).toHaveBeenCalledTimes(9);
        expect(hostProbeState.get("mixed-coverage.example")?.confirmedGood).toBe(true);
    });

    it("a host once confirmed good is never disabled, even by later misses", async () => {
        hostProbeState.set("vite.dev", { consecutiveMisses: 0, confirmedGood: true });
        const fetchMock = vi.fn(async () => headerResponse("not found", "text/html", 404));
        vi.stubGlobal("fetch", fetchMock);

        for (let i = 0; i < MAX_CONSECUTIVE_MISSES + 5; i++) {
            await markdownAdapter.fetch(`https://vite.dev/guide/nonexistent-${i}`);
        }

        // A confirmed-good host keeps being probed regardless of how many subsequent misses pile up.
        expect(fetchMock).toHaveBeenCalledTimes(MAX_CONSECUTIVE_MISSES + 5);
    });

    it("does not re-probe a host already permanently disabled", async () => {
        hostProbeState.set("tailwindcss.com", { consecutiveMisses: MAX_CONSECUTIVE_MISSES, confirmedGood: false });
        const fetchMock = vi.fn(async () => headerResponse("# should not be reached", "text/markdown"));
        vi.stubGlobal("fetch", fetchMock);

        const doc = await markdownAdapter.fetch("https://tailwindcss.com/docs/another-page");

        expect(doc).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a text/html content-type even on a 200", async () => {
        const fetchMock = vi.fn(async () => headerResponse("<html>not markdown</html>", "text/html; charset=utf-8"));
        vi.stubGlobal("fetch", fetchMock);

        const doc = await markdownAdapter.fetch("https://hono.dev/docs/api/context");

        expect(doc).toBeNull();
    });

    it("rejects a response that claims text/plain but is actually an HTML error page", async () => {
        const fetchMock = vi.fn(async () =>
            headerResponse("<!DOCTYPE html><html><body>404 page not found</body></html>", "text/plain; charset=utf-8")
        );
        vi.stubGlobal("fetch", fetchMock);

        const doc = await markdownAdapter.fetch("https://vite.dev/guide/not-a-real-page");

        expect(doc).toBeNull();
    });

    it("returns null on network failure rather than throwing", async () => {
        const fetchMock = vi.fn(async () => {
            throw new Error("network down");
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(markdownAdapter.fetch("https://docs.astro.build/en/getting-started")).resolves.toBeNull();
    });

    it("bounds the number of tracked hosts, evicting the oldest on overflow", async () => {
        const fetchMock = vi.fn(async () => headerResponse("not found", "text/html", 404));
        vi.stubGlobal("fetch", fetchMock);

        const total = MAX_TRACKED_HOSTS + 10;
        for (let i = 0; i < total; i++) {
            await markdownAdapter.fetch(`https://host-${i}.example/page`);
        }

        expect(hostProbeState.size).toBeLessThanOrEqual(MAX_TRACKED_HOSTS);
        // The earliest-tracked hosts should have been evicted.
        expect(hostProbeState.has("host-0.example")).toBe(false);
        // The most recently tracked host should still be present.
        expect(hostProbeState.has(`host-${total - 1}.example`)).toBe(true);
    });
});
