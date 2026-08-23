/**
 * MCP Server entry point.
 *
 * Tool descriptions are the one part of this package that costs the caller
 * tokens on EVERY turn, whether or not a tool is used. The previous set ran to
 * ~1,400 tokens across two tools and said several things twice — sessionKey in
 * both the prose and the parameter, `site:` in two sections, quoting in two
 * more, and the fetch cross-reference in both tools. What survives here is the
 * part that changes behaviour and that a model cannot infer: operator syntax,
 * and the habit of anchoring a query with the project's own stack.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchV2Mcp, fetchPageV2, surveySourcesV2 } from "./orchestrator-v2";
import Logger from "../utils/logger";

const logger = Logger.getInstance();

const server = new McpServer({
    name: "peeky_mcp",
    // Tracks the package version; this string is what clients log and display.
    version: "2.0.0",
});

/**
 * Both tools read the public web and change nothing. `openWorldHint` is the
 * honest value for a search tool, and `readOnlyHint` lets a host skip an
 * approval prompt it would otherwise have to raise.
 */
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/** Shared by all three tools, so operator syntax is stated exactly once. */
const OPERATORS = `Operators: site:domain.com, "exact phrase", -exclude. OR/AND may join site: operators (site:github.com OR site:stackoverflow.com) and are stripped before ranking; elsewhere "OR" is treated as a search word. Prefer discovering a domain from results over recalling one — documentation domains move.`;

server.registerTool(
    "peeky_web_search",
    {
        title: "Search the web",
        description: `Search the web and return verbatim excerpts from the pages, quoted rather than summarised, with the heading path each sits under and its source URL. Code blocks keep their fences.

QUERY FORMULATION
Anchor the query with the specific technology, and search for the underlying concept rather than the user's project. Generic terms ("auth", "database", "state management") return mixed results.
- auth invites, Clerk project → "clerk organization invite member"
- a React error, TS project → "react typescript useEffect cleanup memory leak"
- forms, Next.js + Zod → "nextjs zod form validation server actions"
Quote error strings exactly: they are the highest-signal anchor available.

${OPERATORS}

Start broad, read the results, then refine using the terminology and exact error strings they surface. Vary terms substantially between searches — near-identical queries return the same pages.`,
        inputSchema: {
            query: z.string().describe(
                'Search query with technical terms. Supports site:, "quotes", -exclude.'
            ),
            maxResults: z.number().optional().describe("Maximum pages to return (default: 5, max: 10)"),
            sessionKey: z.string().optional().describe(
                "Reuse one key across related searches to skip pages already fetched under it."
            ),
        },
        annotations: READ_ONLY,
    },
    async ({ query, maxResults, sessionKey }) => {
        // v2 is what this server runs. v1's search() stays in orchestrator.ts
        // because the eval harness injects fetchers into it to reproduce the
        // baseline, but nothing serves it to a caller any more.
        //
        // The old `diagnostics` parameter is gone: it reported on v1's filter
        // stages (blocked domains, pre-scrape title filtering), and this path
        // has none of them. An argument the model can pass that does nothing is
        // worse than no argument.
        const result = await searchV2Mcp(query, {
            ...(maxResults !== undefined && { maxResults }),
            ...(sessionKey !== undefined && { sessionKey }),
        });

        return { content: [{ type: "text", text: result }] };
    }
);

server.registerTool(
    "peeky_find_sources",
    {
        title: "Find sources without reading them",
        description: `Rank web sources for a query and return the list — URL, page kind, source, authority score, and one line of what each says — without the excerpts. Roughly a tenth the output of peeky_web_search over the same ranking.

Use it to survey what exists before committing tokens: when you expect several candidates and want to read one or two in full, when you need the canonical documentation URL rather than its contents, or when gathering references to cite.

Pages marked CANONICAL are the project's own documentation for something the query named. Follow up with peeky_fetch_page to read one, or peeky_web_search for excerpts across all of them.

${OPERATORS}`,
        inputSchema: {
            query: z.string().describe("What you are looking for. Same operators as peeky_web_search."),
            maxResults: z.number().optional().describe("Maximum sources to list (default: 5, max: 10)"),
            explain: z.boolean().optional().describe(
                "Show the signals behind each authority score. Verbose; use when a ranking looks wrong."
            ),
            sessionKey: z.string().optional().describe(
                "Skip pages already fetched under this key. Listing a page does not itself mark it fetched."
            ),
        },
        annotations: READ_ONLY,
    },
    async ({ query, maxResults, explain, sessionKey }) => {
        const result = await surveySourcesV2(query, {
            ...(maxResults !== undefined && { maxResults }),
            ...(explain !== undefined && { explain }),
            ...(sessionKey !== undefined && { sessionKey }),
        });

        return { content: [{ type: "text", text: result }] };
    }
);

server.registerTool(
    "peeky_fetch_page",
    {
        title: "Read one page",
        description: `Read one URL. Without a query, returns the whole readable document in order — headings, prose, code, tables. With a query, returns only the passages answering it, ranked.

Reads pages that block scrapers: Stack Overflow and Stack Exchange 403 every scraper and GitHub renders repo pages with JavaScript, so those go through their APIs instead — answers with vote counts and accepted flags, issue and discussion threads. npm packages and doc sites that publish markdown are read from source. A result is worth fetching even when you would expect it to be blocked.`,
        inputSchema: {
            url: z.string().describe("The URL to fetch and read"),
            query: z.string().optional().describe(
                "Optional. Focuses extraction on the passages answering it; omit for the full page."
            ),
        },
        annotations: READ_ONLY,
    },
    async ({ url, query }) => {
        const result = await fetchPageV2(url, {
            ...(query !== undefined && { query }),
        });

        return { content: [{ type: "text", text: result }] };
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    logger.error(`Fatal error: ${error}`);
    process.exit(1);
});
