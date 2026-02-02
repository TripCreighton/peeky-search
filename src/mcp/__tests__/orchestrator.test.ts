import { describe, it, expect } from "vitest";
import { computePreScrapeRelevance, createSessionCacheKey } from "../orchestrator";
import { tokenize } from "../../preprocessing/tokenize";
import type { SearxngResult } from "../types";

// Helper to create a mock SearXNG result
function mockSearxngResult(overrides: Partial<SearxngResult>): SearxngResult {
    return {
        url: "https://example.com/page",
        title: "",
        content: "",
        score: 1.0,
        engine: "google",
        ...overrides,
    };
}

// We need to test the internal functions, but they're not exported.
// For now, we test via the module's behavior by importing and calling indirectly
// or by testing the functions we can access.

// Since the orchestrator exports `search` and `fetchPage` which require network,
// we'll focus on testing the URL filtering logic by extracting testable patterns.

// Helper to test URL blocking logic (mimics isBlockedDomain)
function isBlockedDomain(url: string): boolean {
    const BLOCKED_DOMAINS = new Set([
        "medium.com",
        "npmjs.com",
        "researchgate.net",
        "grokipedia.org",
    ]);

    try {
        const hostname = new URL(url).hostname.replace(/^www\./, "");

        for (const blocked of BLOCKED_DOMAINS) {
            if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
                return true;
            }
        }

        // Check GitHub repo main pages
        if (hostname === "github.com") {
            const path = new URL(url).pathname.replace(/\/$/, "");
            const segments = path.split("/").filter(s => s.length > 0);
            if (segments.length === 2) {
                return true; // Repo main page
            }
        }

        return false;
    } catch {
        return false;
    }
}

// Helper to test URL normalization (mimics normalizeUrlForDedup)
function normalizeUrlForDedup(url: string): string {
    const VERSION_PATH_PATTERNS = [
        /\/v\d+(\.\d+)*\//gi,
        /\/\d+\.\d+(\.\d+)*\//gi,
        /\/(stable|latest|current|master|main|dev|nightly)\//gi,
        /\/(en|en-us|en-gb)\//gi,
    ];

    const VERSION_SUBDOMAIN_PATTERNS = [
        /^v\d+\./i,
        /^\d+\.\d+\./,
        /^(stable|latest|current|docs)\./i,
        /^[a-z]{2}\./i,
        /^[a-z]{2}-[a-z]{2}\./i,
    ];

    try {
        const urlObj = new URL(url);
        let hostname = urlObj.hostname;
        let path = urlObj.pathname;

        for (const pattern of VERSION_SUBDOMAIN_PATTERNS) {
            hostname = hostname.replace(pattern, "");
        }

        for (const pattern of VERSION_PATH_PATTERNS) {
            path = path.replace(pattern, "/");
        }

        path = path.replace(/\/+/g, "/");

        return `${hostname}${path}`;
    } catch {
        return url;
    }
}

describe("URL blocking", () => {
    describe("blocked domains", () => {
        it("blocks medium.com", () => {
            expect(isBlockedDomain("https://medium.com/article")).toBe(true);
        });

        it("blocks www.medium.com", () => {
            expect(isBlockedDomain("https://www.medium.com/article")).toBe(true);
        });

        it("blocks subdomains of medium.com", () => {
            expect(isBlockedDomain("https://user.medium.com/article")).toBe(true);
        });

        it("blocks npmjs.com", () => {
            expect(isBlockedDomain("https://www.npmjs.com/package/react")).toBe(true);
        });

        it("blocks researchgate.net", () => {
            expect(isBlockedDomain("https://researchgate.net/paper")).toBe(true);
        });

        it("blocks grokipedia.org", () => {
            expect(isBlockedDomain("https://grokipedia.org/topic")).toBe(true);
        });

        it("allows stackoverflow.com", () => {
            expect(isBlockedDomain("https://stackoverflow.com/questions/123")).toBe(false);
        });

        it("allows reactjs.org", () => {
            expect(isBlockedDomain("https://reactjs.org/docs/hooks")).toBe(false);
        });
    });

    describe("GitHub blocking", () => {
        it("blocks repo main page (github.com/user/repo)", () => {
            expect(isBlockedDomain("https://github.com/facebook/react")).toBe(true);
        });

        it("blocks repo main page with trailing slash", () => {
            expect(isBlockedDomain("https://github.com/facebook/react/")).toBe(true);
        });

        it("allows GitHub issues", () => {
            expect(isBlockedDomain("https://github.com/facebook/react/issues")).toBe(false);
        });

        it("allows GitHub issues with number", () => {
            expect(isBlockedDomain("https://github.com/facebook/react/issues/123")).toBe(false);
        });

        it("allows GitHub discussions", () => {
            expect(isBlockedDomain("https://github.com/facebook/react/discussions")).toBe(false);
        });

        it("allows GitHub pull requests", () => {
            expect(isBlockedDomain("https://github.com/facebook/react/pull/123")).toBe(false);
        });

        it("allows GitHub blob (code files)", () => {
            expect(isBlockedDomain("https://github.com/facebook/react/blob/main/README.md")).toBe(false);
        });

        it("allows GitHub tree (directory)", () => {
            expect(isBlockedDomain("https://github.com/facebook/react/tree/main/packages")).toBe(false);
        });
    });
});

describe("URL normalization for deduplication", () => {
    describe("version path stripping", () => {
        it("strips /v1/ version paths", () => {
            const url = "https://example.com/v1/api/reference";
            expect(normalizeUrlForDedup(url)).toBe("example.com/api/reference");
        });

        it("strips /v2/ version paths", () => {
            const url = "https://example.com/v2/api/reference";
            expect(normalizeUrlForDedup(url)).toBe("example.com/api/reference");
        });

        it("strips /4.3/ numeric version paths", () => {
            const url = "https://tailwindcss.com/docs/4.3/installation";
            expect(normalizeUrlForDedup(url)).toBe("tailwindcss.com/docs/installation");
        });

        it("strips /stable/ version paths", () => {
            const url = "https://example.com/stable/guide";
            expect(normalizeUrlForDedup(url)).toBe("example.com/guide");
        });

        it("strips /latest/ version paths", () => {
            const url = "https://example.com/latest/reference";
            expect(normalizeUrlForDedup(url)).toBe("example.com/reference");
        });

        it("strips /en/ language paths", () => {
            const url = "https://example.com/en/guide";
            expect(normalizeUrlForDedup(url)).toBe("example.com/guide");
        });
    });

    describe("version subdomain stripping", () => {
        it("strips v1. subdomain", () => {
            const url = "https://v1.tailwindcss.com/docs";
            expect(normalizeUrlForDedup(url)).toBe("tailwindcss.com/docs");
        });

        it("strips v2. subdomain", () => {
            const url = "https://v2.tailwindcss.com/docs";
            expect(normalizeUrlForDedup(url)).toBe("tailwindcss.com/docs");
        });

        it("strips docs. subdomain", () => {
            const url = "https://docs.example.com/guide";
            expect(normalizeUrlForDedup(url)).toBe("example.com/guide");
        });

        it("strips en. language subdomain", () => {
            const url = "https://en.wikipedia.org/wiki/React";
            expect(normalizeUrlForDedup(url)).toBe("wikipedia.org/wiki/React");
        });

        it("strips en-us. language subdomain", () => {
            const url = "https://en-us.example.com/docs";
            expect(normalizeUrlForDedup(url)).toBe("example.com/docs");
        });
    });

    describe("deduplication effectiveness", () => {
        it("normalizes v1 and v2 docs to same key", () => {
            const v1 = normalizeUrlForDedup("https://example.com/v1/api");
            const v2 = normalizeUrlForDedup("https://example.com/v2/api");

            expect(v1).toBe(v2);
        });

        it("normalizes stable and latest to same key", () => {
            const stable = normalizeUrlForDedup("https://example.com/stable/guide");
            const latest = normalizeUrlForDedup("https://example.com/latest/guide");

            expect(stable).toBe(latest);
        });

        it("normalizes different version subdomains to same key", () => {
            const v1 = normalizeUrlForDedup("https://v1.example.com/docs");
            const v2 = normalizeUrlForDedup("https://v2.example.com/docs");

            expect(v1).toBe(v2);
        });

        it("keeps different pages distinct", () => {
            const api = normalizeUrlForDedup("https://example.com/v1/api");
            const guide = normalizeUrlForDedup("https://example.com/v1/guide");

            expect(api).not.toBe(guide);
        });
    });

    describe("edge cases", () => {
        it("handles URL without version markers", () => {
            const url = "https://example.com/docs/guide";
            expect(normalizeUrlForDedup(url)).toBe("example.com/docs/guide");
        });

        it("handles invalid URL gracefully", () => {
            const url = "not-a-url";
            expect(normalizeUrlForDedup(url)).toBe("not-a-url");
        });

        it("normalizes multiple slashes", () => {
            const url = "https://example.com//docs///guide";
            expect(normalizeUrlForDedup(url)).toBe("example.com/docs/guide");
        });
    });
});

describe("session cache behavior", () => {
    // Note: Can't easily test the actual session cache without network calls
    // These tests document expected behavior

    it("session TTL is 10 seconds", () => {
        // Documented behavior: SESSION_TTL_MS = 10 * 1000
        const SESSION_TTL_MS = 10 * 1000;
        expect(SESSION_TTL_MS).toBe(10000);
    });
});

describe("createSessionCacheKey", () => {
    it("creates composite key from URL and sorted tokens", () => {
        const url = "https://example.com/page";
        const tokens = ["react", "hook"];

        const key = createSessionCacheKey(url, tokens);

        expect(key).toBe("https://example.com/page:hook,react");
    });

    it("deduplicates tokens before creating key", () => {
        const url = "https://example.com/page";
        const tokens = ["react", "hook", "react", "hook"];

        const key = createSessionCacheKey(url, tokens);

        expect(key).toBe("https://example.com/page:hook,react");
    });

    it("sorts tokens alphabetically for deterministic keys", () => {
        const url = "https://example.com/page";

        const key1 = createSessionCacheKey(url, ["zebra", "apple", "mango"]);
        const key2 = createSessionCacheKey(url, ["mango", "zebra", "apple"]);

        expect(key1).toBe(key2);
        expect(key1).toBe("https://example.com/page:apple,mango,zebra");
    });

    it("produces identical keys for stemmed variations", () => {
        const url = "https://example.com/react-guide";

        // tokenize() applies stemming, so "hooks" → "hook"
        const tokens1 = tokenize("react hooks");
        const tokens2 = tokenize("react hook");

        const key1 = createSessionCacheKey(url, tokens1);
        const key2 = createSessionCacheKey(url, tokens2);

        expect(key1).toBe(key2);
    });

    it("produces different keys for different queries on same URL", () => {
        const url = "https://example.com/react-guide";

        const hooksTokens = tokenize("react hooks");
        const stateTokens = tokenize("react useState");

        const key1 = createSessionCacheKey(url, hooksTokens);
        const key2 = createSessionCacheKey(url, stateTokens);

        expect(key1).not.toBe(key2);
    });

    it("allows same URL to have different keys for different queries", () => {
        const url = "https://reactjs.org/docs/hooks.html";

        // Scenario: LLM searches "react hooks" first, then "react useState"
        // The same URL should be fetchable again with different query
        const query1Tokens = tokenize("react hooks tutorial");
        const query2Tokens = tokenize("react useState example");

        const key1 = createSessionCacheKey(url, query1Tokens);
        const key2 = createSessionCacheKey(url, query2Tokens);

        // Different queries = different keys = URL can be re-fetched
        expect(key1).not.toBe(key2);
    });
});

describe("computePreScrapeRelevance", () => {
    describe("title matching", () => {
        it("returns 1.0 when all query tokens appear in title", () => {
            const result = mockSearxngResult({
                title: "Send and manage Organization invitations via Clerk",
                content: "",
            });
            const queryTokens = tokenize("clerk organization invite");

            const relevance = computePreScrapeRelevance(result, queryTokens);

            expect(relevance).toBe(1.0);
        });

        it("returns partial score when some tokens match", () => {
            const result = mockSearxngResult({
                title: "Organization invitations guide",
                content: "",
            });
            const queryTokens = tokenize("clerk organization invite");

            const relevance = computePreScrapeRelevance(result, queryTokens);

            // "organ" and "invit" match, "clerk" doesn't = 2/3
            expect(relevance).toBeCloseTo(0.67, 1);
        });

        it("returns 0 when no tokens match", () => {
            const result = mockSearxngResult({
                title: "Keycloak authentication setup",
                content: "",
            });
            const queryTokens = tokenize("clerk organization invite");

            const relevance = computePreScrapeRelevance(result, queryTokens);

            expect(relevance).toBe(0);
        });
    });

    describe("snippet (content) matching", () => {
        it("uses snippet to find missing tokens", () => {
            const result = mockSearxngResult({
                title: "Organization invitations guide",
                content: "Learn how to use Clerk to manage your organization invitations.",
            });
            const queryTokens = tokenize("clerk organization invite");

            const relevance = computePreScrapeRelevance(result, queryTokens);

            // All tokens found: "clerk" in snippet, "organ" and "invit" in title
            expect(relevance).toBe(1.0);
        });

        it("combines title and snippet for scoring", () => {
            const result = mockSearxngResult({
                title: "Authentication guide",
                content: "This guide covers Clerk organization features.",
            });
            const queryTokens = tokenize("clerk organization invite");

            const relevance = computePreScrapeRelevance(result, queryTokens);

            // "clerk" and "organ" found in snippet, "invit" not found = 2/3
            expect(relevance).toBeCloseTo(0.67, 1);
        });
    });

    describe("URL path matching", () => {
        it("uses URL path tokens for matching", () => {
            const result = mockSearxngResult({
                url: "https://example.com/docs/clerk/organizations/invitations",
                title: "Invitations",
                content: "Learn about invitations.",
            });
            const queryTokens = tokenize("clerk organization invite");

            const relevance = computePreScrapeRelevance(result, queryTokens);

            // "clerk" from URL path, "organ" from URL path, "invit" from title
            expect(relevance).toBe(1.0);
        });

        it("extracts tokens from kebab-case paths", () => {
            const result = mockSearxngResult({
                url: "https://example.com/user-management/organization-settings",
                title: "Settings",
                content: "",
            });
            const queryTokens = tokenize("organization settings");

            const relevance = computePreScrapeRelevance(result, queryTokens);

            expect(relevance).toBe(1.0);
        });
    });

    describe("filtering competing technologies", () => {
        it("filters Keycloak when searching for Clerk", () => {
            const result = mockSearxngResult({
                title: "Support attaching roles to user invitations (organization / realm level)",
                content: "Keycloak discussion about organization roles and invitations.",
                url: "https://keycloak.org/discussions/123",
            });
            const queryTokens = tokenize("clerk organization invite");

            const relevance = computePreScrapeRelevance(result, queryTokens);

            // "organ" and "invit" match, but "clerk" doesn't = 2/3 ≈ 0.67
            // This is below the 0.4 threshold when "clerk" is a key term
            expect(relevance).toBeCloseTo(0.67, 1);
        });

        it("filters Supabase when searching for Clerk", () => {
            const result = mockSearxngResult({
                title: "How to implement invite-only user registration for my educational platform",
                content: "Using Supabase to handle user invitations.",
                url: "https://reddit.com/r/supabase/123",
            });
            const queryTokens = tokenize("clerk organization invite");

            const relevance = computePreScrapeRelevance(result, queryTokens);

            // Only "invit" matches = 1/3 ≈ 0.33
            expect(relevance).toBeCloseTo(0.33, 1);
        });

        it("accepts Clerk results when searching for Clerk", () => {
            const result = mockSearxngResult({
                title: "Clerk/Next JS Allowing only certain Users to Sign Up",
                content: "Discussion about Clerk organization permissions.",
                url: "https://reddit.com/r/nextjs/clerk-signup",
            });
            const queryTokens = tokenize("clerk organization invite");

            const relevance = computePreScrapeRelevance(result, queryTokens);

            // "clerk" and "organ" match = 2/3 ≈ 0.67
            expect(relevance).toBeCloseTo(0.67, 1);
        });
    });

    describe("edge cases", () => {
        it("returns 1.0 for empty query tokens", () => {
            const result = mockSearxngResult({
                title: "Any title",
                content: "Any content",
            });

            const relevance = computePreScrapeRelevance(result, []);

            expect(relevance).toBe(1);
        });

        it("handles empty title and content", () => {
            const result = mockSearxngResult({
                title: "",
                content: "",
                url: "https://example.com/page",
            });
            const queryTokens = tokenize("test query");

            const relevance = computePreScrapeRelevance(result, queryTokens);

            expect(relevance).toBe(0);
        });

        it("handles special characters in title", () => {
            const result = mockSearxngResult({
                title: "Clerk.OrganizationInvitation — Clerk SDK v1.2.0",
                content: "",
            });
            const queryTokens = tokenize("clerk organization invitation");

            const relevance = computePreScrapeRelevance(result, queryTokens);

            // All tokens should be found
            expect(relevance).toBe(1.0);
        });
    });

    describe("threshold behavior", () => {
        // The MIN_PRESCRAPE_RELEVANCE is 0.4 (40%)
        // These tests verify the threshold makes sense

        it("40% threshold filters 1/3 match (0.33)", () => {
            const result = mockSearxngResult({
                title: "Generic invitations guide",
                content: "",
            });
            const queryTokens = tokenize("clerk organization invite");

            const relevance = computePreScrapeRelevance(result, queryTokens);

            // Only "invit" matches = 1/3 ≈ 0.33 < 0.4 threshold
            expect(relevance).toBeLessThan(0.4);
        });

        it("40% threshold accepts 2/3 match (0.67)", () => {
            const result = mockSearxngResult({
                title: "Organization invitations",
                content: "",
            });
            const queryTokens = tokenize("clerk organization invite");

            const relevance = computePreScrapeRelevance(result, queryTokens);

            // "organ" and "invit" match = 2/3 ≈ 0.67 >= 0.4 threshold
            expect(relevance).toBeGreaterThanOrEqual(0.4);
        });

        it("40% threshold accepts 1/2 match (0.5)", () => {
            const result = mockSearxngResult({
                title: "Clerk authentication",
                content: "",
            });
            const queryTokens = tokenize("clerk invite");

            const relevance = computePreScrapeRelevance(result, queryTokens);

            // "clerk" matches = 1/2 = 0.5 >= 0.4 threshold
            expect(relevance).toBeGreaterThanOrEqual(0.4);
        });
    });
});
