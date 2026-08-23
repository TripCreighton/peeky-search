import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { registryAdapter, resolveHomepage, parseNpmPackageUrl } from "../../fetch/registry";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

// Follows the response shape of GET https://registry.npmjs.org/{package}. The
// package identity, versions and repository links are real — the adapter maps
// them — but every contact record (maintainers, author, contributors, npm user)
// has been removed rather than committing third-party email addresses, and the
// bundled readme is synthetic.
const registryFixture = JSON.parse(readFileSync(join(fixturesDir, "npm-registry-example-pkg.json"), "utf-8")) as unknown;

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as Response;
}

describe("parseNpmPackageUrl", () => {
    it("extracts an unscoped package name", () => {
        expect(parseNpmPackageUrl("https://www.npmjs.com/package/example-pkg")).toBe("example-pkg");
    });

    it("extracts a scoped package name", () => {
        expect(parseNpmPackageUrl("https://www.npmjs.com/package/@types/node")).toBe("@types/node");
    });

    it("handles a version-suffixed URL", () => {
        expect(parseNpmPackageUrl("https://www.npmjs.com/package/example-pkg/v/3.0.1")).toBe("example-pkg");
    });

    it("returns null for a non-npmjs host", () => {
        expect(parseNpmPackageUrl("https://example.com/package/example-pkg")).toBeNull();
    });

    it("returns null for the npmjs.com homepage", () => {
        expect(parseNpmPackageUrl("https://www.npmjs.com/")).toBeNull();
    });
});

describe("registryAdapter.canHandle", () => {
    it("claims npmjs.com package pages", () => {
        expect(registryAdapter.canHandle("https://www.npmjs.com/package/example-pkg")).toBe(true);
        expect(registryAdapter.canHandle("https://npmjs.com/package/example-pkg")).toBe(true);
    });

    it("does not claim unrelated URLs", () => {
        expect(registryAdapter.canHandle("https://example.com")).toBe(false);
    });
});

describe("registryAdapter.fetch — response mapping against a captured-shape payload", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("emits description, README nodes, and repository/homepage links", async () => {
        const fetchMock = vi.fn(async () => jsonResponse(registryFixture));
        vi.stubGlobal("fetch", fetchMock);

        const doc = await registryAdapter.fetch("https://www.npmjs.com/package/example-pkg");

        expect(doc).not.toBeNull();
        expect(doc?.source).toBe("registry");
        expect(doc?.kind).toBe("reference");
        expect(doc?.title).toContain("example-pkg");

        const descriptionNode = doc?.nodes[0];
        expect(descriptionNode?.text).toContain("odd");
        expect(descriptionNode?.links?.some((l) => l.href.includes("github.com/example-org/example-pkg"))).toBe(true);

        // README content should have been parsed into more nodes beyond the description.
        expect((doc?.nodes.length ?? 0)).toBeGreaterThan(1);
    });

    it("returns null on network failure rather than throwing", async () => {
        const fetchMock = vi.fn(async () => {
            throw new Error("network down");
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(registryAdapter.fetch("https://www.npmjs.com/package/example-pkg")).resolves.toBeNull();
    });

    it("returns null for a URL it does not recognize", async () => {
        const doc = await registryAdapter.fetch("https://example.com/foo");
        expect(doc).toBeNull();
    });
});

describe("resolveHomepage", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("resolves the declared homepage from the /latest endpoint", async () => {
        const fetchMock = vi.fn(async (input: string | URL) => {
            const url = input.toString();
            expect(url).toContain("/latest");
            return jsonResponse({
                name: "example-pkg",
                version: "3.0.1",
                homepage: "https://github.com/example-org/example-pkg",
            });
        });
        vi.stubGlobal("fetch", fetchMock);

        const homepage = await resolveHomepage("example-pkg");

        expect(homepage).toBe("https://github.com/example-org/example-pkg");
    });

    it("falls back to the repository URL when there is no homepage", async () => {
        const fetchMock = vi.fn(async () =>
            jsonResponse({
                name: "some-pkg",
                repository: { type: "git", url: "git+https://github.com/foo/some-pkg.git" },
            })
        );
        vi.stubGlobal("fetch", fetchMock);

        const homepage = await resolveHomepage("some-pkg");

        expect(homepage).toBe("https://github.com/foo/some-pkg");
    });

    it("returns null on network failure rather than throwing", async () => {
        const fetchMock = vi.fn(async () => {
            throw new Error("network down");
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(resolveHomepage("example-pkg")).resolves.toBeNull();
    });
});
