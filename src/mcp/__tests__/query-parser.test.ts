import { describe, it, expect } from "vitest";
import { parseSearchOperators } from "../query-parser";

describe("parseSearchOperators", () => {
    it("keeps original query in searchQuery", () => {
        const query = "react hooks site:reactjs.org";

        const result = parseSearchOperators(query);

        expect(result.searchQuery).toBe(query);
    });

    it("removes site: operator from extractionQuery", () => {
        const query = "react hooks site:reactjs.org";

        const result = parseSearchOperators(query);

        expect(result.extractionQuery).toBe("react hooks");
    });

    it("removes site: operator with subdomain", () => {
        const query = "typescript site:docs.microsoft.com";

        const result = parseSearchOperators(query);

        expect(result.extractionQuery).toBe("typescript");
    });

    it("removes -excluded terms from extractionQuery", () => {
        const query = "react tutorial -beginner -video";

        const result = parseSearchOperators(query);

        expect(result.extractionQuery).toBe("react tutorial");
        expect(result.searchQuery).toBe(query);
    });

    it("handles -exclude at start of query", () => {
        // Per line 17 comment: "- -term - exclude term (removed from extraction)"
        // EXPECTED: -exclude should be removed from extraction query
        const query = "-exclude react hooks";

        const result = parseSearchOperators(query);

        // EXPECTED behavior: -exclude should be removed even at start
        // This test asserts expected behavior - will fail if bug exists
        expect(result.extractionQuery).toBe("react hooks");
    });

    it("removes filetype: operator from extractionQuery", () => {
        const query = "javascript tutorial filetype:pdf";

        const result = parseSearchOperators(query);

        expect(result.extractionQuery).toBe("javascript tutorial");
    });

    it("removes quotes but keeps phrase content", () => {
        const query = '"react hooks" tutorial';

        const result = parseSearchOperators(query);

        expect(result.extractionQuery).toBe("react hooks tutorial");
        expect(result.searchQuery).toBe(query);
    });

    it("handles multiple quoted phrases", () => {
        const query = '"react hooks" "state management"';

        const result = parseSearchOperators(query);

        expect(result.extractionQuery).toBe("react hooks state management");
    });

    it("handles all operators together", () => {
        const query = '"exact phrase" site:example.com -exclude filetype:html';

        const result = parseSearchOperators(query);

        expect(result.searchQuery).toBe(query);
        expect(result.extractionQuery).toBe("exact phrase");
    });

    it("returns empty extractionQuery when only operators remain", () => {
        const query = "site:example.com -term filetype:pdf";

        const result = parseSearchOperators(query);

        expect(result.extractionQuery).toBe("");
    });

    it("normalizes whitespace in extractionQuery", () => {
        const query = "react   hooks    tutorial";

        const result = parseSearchOperators(query);

        expect(result.extractionQuery).toBe("react hooks tutorial");
    });

    it("handles empty query", () => {
        const query = "";

        const result = parseSearchOperators(query);

        expect(result.searchQuery).toBe("");
        expect(result.extractionQuery).toBe("");
    });

    it("preserves case in extractionQuery", () => {
        const query = "React Hooks Tutorial";

        const result = parseSearchOperators(query);

        expect(result.extractionQuery).toBe("React Hooks Tutorial");
    });

    it("handles site: without TLD", () => {
        const query = "test site:localhost";

        const result = parseSearchOperators(query);

        expect(result.extractionQuery).toBe("test");
    });

    it("handles hyphenated domain in site:", () => {
        const query = "test site:my-example.co.uk";

        const result = parseSearchOperators(query);

        expect(result.extractionQuery).toBe("test");
    });

    it("removes OR between site: operators", () => {
        const query = "site:github.com OR site:stackoverflow.com react hooks";

        const result = parseSearchOperators(query);

        expect(result.searchQuery).toBe(query);
        expect(result.extractionQuery).toBe("react hooks");
    });

    it("removes AND between site: operators", () => {
        const query = "site:github.com AND site:stackoverflow.com typescript";

        const result = parseSearchOperators(query);

        expect(result.extractionQuery).toBe("typescript");
    });

    it("removes multiple OR between site: operators", () => {
        const query = "site:github.com OR site:stackoverflow.com OR site:reddit.com query";

        const result = parseSearchOperators(query);

        expect(result.extractionQuery).toBe("query");
    });

    it("preserves OR in regular search text", () => {
        const query = "invalid OR operation error";

        const result = parseSearchOperators(query);

        expect(result.extractionQuery).toBe("invalid OR operation error");
    });

    it("preserves OR inside quoted phrases", () => {
        const query = '"invalid OR clause" site:github.com';

        const result = parseSearchOperators(query);

        expect(result.extractionQuery).toBe("invalid OR clause");
    });
});
