/**
 * MCP Server entry point
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { search, fetchPage } from "./orchestrator";
import Logger from "../utils/logger";

const logger = Logger.getInstance();

// Create MCP server
const server = new McpServer({
    name: "peeky_mcp",
    version: "1.0.0",
});

// Register the search tool
server.tool(
    "peeky_web_search",
    `Search the web for technical information. Use this tool for ANY request involving research, documentation lookup, or questions you're not 100% confident about.

WHEN TO USE (prefer this over browsing or guessing):
- User says "research", "look up", "find docs", "search for"
- User asks "how do I...", "what is...", "best way to..."
- User asks about libraries, frameworks, APIs, tools
- User has an error message or needs debugging help
- You need current/accurate information beyond your training data

QUERY FORMULATION:
- For vague or project-level requests, extract the underlying technical concepts and search for those
- Always include the specific technology/framework/library name
- Focus on patterns, APIs, or techniques that have documentation - not the user's exact project
- If a topic is niche, think about what general concept it falls under

When working in a user's codebase, anchor queries with the relevant tech stack. This filters out results about competing or unrelated technologies:
- If the project uses a specific library (Clerk, Prisma, etc.), include that library name
- If asking about a framework pattern, include the framework (Next.js, Express, etc.)
- Generic terms like "auth", "database", or "state management" return mixed results

Examples of good queries:
- User asks about auth invites (Clerk project) → "clerk organization invite member"
- User has a React error (TypeScript project) → "react typescript useEffect cleanup memory leak"
- User wants ORM help (Prisma project) → "prisma relation query include nested"
- User asks about forms (Next.js + Zod) → "nextjs zod form validation server actions"

SEARCH OPERATORS:
- site:domain.com - limit to specific domain (e.g., "site:clerk.com organization invite")
- "exact phrase" - exact phrase match
- -term - exclude term

Avoid using site: with domains from memory—URLs change frequently. Search without site: first to discover current domains, or only use site: when you've confirmed the domain from recent results.

MULTIPLE SEARCHES:
Use the same sessionKey across related searches to skip already-fetched URLs. Vary your query terms significantly between searches—similar queries return overlapping results.

FOLLOW-UP:
If an excerpt looks promising but lacks detail, use peeky_fetch_page with that URL to read more.

RETURNS: Extracted text excerpts with source URLs.`,
    {
        query: z.string().describe(
            "Search query with technical terms. Supports operators: site:, \"quotes\", -exclude."
        ),
        maxResults: z.number().optional().describe("Maximum pages to scrape (default: 5, max: 10)"),
        diagnostics: z.boolean().optional().describe("Include detailed diagnostics about why pages were filtered or failed (default: false)."),
        sessionKey: z.string().optional().describe("Session key for cross-call URL deduplication. When provided, URLs already fetched in previous calls with the same key will be skipped. Use a consistent key (e.g., 'react-research') across related searches to avoid re-fetching the same pages."),
    },
    async ({ query, maxResults, diagnostics, sessionKey }) => {
        const result = await search(query, {
            ...(maxResults !== undefined && { maxResults }),
            ...(diagnostics !== undefined && { diagnostics }),
            ...(sessionKey !== undefined && { sessionKey }),
        });

        return {
            content: [
                {
                    type: "text",
                    text: result,
                },
            ],
        };
    }
);

// Register the fetch page tool
server.tool(
    "peeky_fetch_page",
    `Fetch and read a single web page. Use this when you have a specific URL you want to read.

WHEN TO USE:
- You have a specific URL and want to read its content
- Following up on a search result to read the full page
- User provides a URL and asks "what does this say" or "read this page"

MODES:
- Without query: Returns full cleaned content (headings, paragraphs, code blocks)
- With query: Returns focused excerpts relevant to the query

Tip: After peeky_web_search, if an excerpt looks promising but lacks detail, fetch that URL with a query to dig deeper.

RETURNS: Cleaned page content in markdown format with title and source URL.`,
    {
        url: z.string().describe("The URL to fetch and read"),
        query: z.string().optional().describe("Optional query to focus extraction. If omitted, returns full cleaned content."),
    },
    async ({ url, query }) => {
        const result = await fetchPage(url, {
            ...(query !== undefined && { query }),
        });

        return {
            content: [
                {
                    type: "text",
                    text: result,
                },
            ],
        };
    }
);

// Start the server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    logger.error(`Fatal error: ${error}`);
    process.exit(1);
});
