import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { extractExcerpts, type PipelineConfig } from "./pipeline";
import { formatExcerpts } from "./output/excerpts";
import { tokenize } from "./preprocessing/tokenize";
import { search, fetchPage } from "./mcp/orchestrator";
import Logger from "./utils/logger";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = Logger.getInstance();

/**
 * CLI entry point
 */
async function main(): Promise<void> {
    // Filter out standalone "--" which pnpm passes through
    const args = process.argv.slice(2).filter(a => a !== "--");

    // Parse arguments
    let query = "";
    let filePath = "";
    let url = "";
    let searchMode = false;
    let fetchMode = false;
    let debug = false;
    let timing = false;
    let diagnostics = false;
    let maxResults = 5;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const nextArg = args[i + 1];

        if ((arg === "--query" || arg === "-q") && nextArg !== undefined) {
            query = nextArg;
            i++;
        } else if ((arg === "--file" || arg === "-f") && nextArg !== undefined) {
            filePath = nextArg;
            i++;
        } else if ((arg === "--url" || arg === "-u") && nextArg !== undefined) {
            url = nextArg;
            i++;
        } else if (arg === "--search" || arg === "-s") {
            searchMode = true;
        } else if (arg === "--fetch") {
            fetchMode = true;
        } else if (arg === "--max" && nextArg !== undefined) {
            maxResults = parseInt(nextArg, 10);
            i++;
        } else if (arg === "--debug") {
            debug = true;
        } else if (arg === "--diagnostics") {
            diagnostics = true;
        } else if (arg === "--timing" || arg === "-t") {
            timing = true;
        } else if (arg === "--help" || arg === "-h") {
            printUsage();
            return;
        }
    }

    // Enable timing if requested
    if (timing) {
        logger.setTimingEnabled(true);
    }

    // Search mode: query SearXNG and extract from results
    if (searchMode) {
        if (query === "") {
            logger.error("--search requires --query");
            process.exit(1);
        }
        logger.log(`Searching: "${query}" (max ${maxResults} results)`);
        const result = await search(query, { maxResults, debug, diagnostics });
        console.log("\n" + result);
        return;
    }

    // Fetch mode: fetch a single page and return cleaned content
    if (fetchMode) {
        if (url === "") {
            logger.error("--fetch requires --url");
            process.exit(1);
        }
        logger.log(`Fetching: ${url}`);
        if (query) {
            logger.log(`Query: "${query}"`);
        }
        const result = await fetchPage(url, query ? { query } : {});
        console.log("\n" + result);
        return;
    }

    // URL mode: fetch and extract from a single URL
    if (url !== "") {
        if (query === "") {
            logger.error("--url requires --query");
            process.exit(1);
        }
        await processUrl(url, query, debug);
        return;
    }

    // File mode: process local file
    await processFile(filePath, query, debug);
}

async function processUrl(url: string, query: string, debug: boolean): Promise<void> {
    logger.log(`Fetching: ${url}`);
    logger.log(`Query: "${query}"`);
    logger.log(`Query tokens: ${JSON.stringify(tokenize(query))}`);

    try {
        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; PeekyBot/1.0)",
                "Accept": "text/html",
            },
        });

        if (!response.ok) {
            logger.error(`HTTP ${response.status}: ${response.statusText}`);
            process.exit(1);
        }

        const html = await response.text();
        processHtml(html, query, debug);
    } catch (err) {
        logger.error(`Fetch failed: ${err}`);
        process.exit(1);
    }
}

async function processFile(filePath: string, query: string, debug: boolean): Promise<void> {
    // Use default sample file if none specified
    if (filePath === "") {
        filePath = path.join(__dirname, "../samples", "clerk-how-to-add-user-to-org-sample.html");
    }

    // Use default query if none specified
    if (query === "") {
        query = "how to add user to organization";
    }

    // Check file exists
    if (!fs.existsSync(filePath)) {
        logger.error(`File not found: ${filePath}`);
        process.exit(1);
    }

    logger.log(`Reading file: ${filePath}`);
    logger.log(`Query: "${query}"`);
    logger.log(`Query tokens: ${JSON.stringify(tokenize(query))}`);

    const html = fs.readFileSync(filePath, "utf8");
    processHtml(html, query, debug);
}

function processHtml(html: string, query: string, debug: boolean): void {
    // Configure pipeline
    const config: PipelineConfig = {
        debug,
        excerpts: {
            maxExcerpts: 3,
            charBudget: 4000,
        },
    };

    // Extract excerpts (timing is handled inside if enabled)
    const result = extractExcerpts(html, query, config);

    // Print timing summary if enabled
    logger.printTimings();

    // Output results
    console.log("\n" + "=".repeat(60));
    console.log(formatExcerpts(result));

    // Output debug info if requested
    if (debug && "debug" in result && result.debug) {
        logger.debug("=".repeat(60));
        logger.debug("Debug Info:");
        logger.debug(`  Sentences: ${result.debug.sentenceCount}`);
        logger.debug(`  Query term coverage: ${((result.debug.queryTermCoverage ?? 0) * 100).toFixed(1)}%`);
        logger.debug(`  Max raw BM25: ${(result.debug.maxRawBm25 ?? 0).toFixed(3)}`);
        logger.debug(`  Has relevant results: ${result.debug.hasRelevantResults ?? "N/A"}`);
        logger.debug(`  Anchors selected: ${result.debug.anchorCount}`);
        logger.debug(`  Chunks before dedupe: ${result.debug.chunkCount}`);
        logger.debug(`  Chunks after dedupe: ${result.debug.dedupedChunkCount}`);
        logger.debug("\nTop 10 sentences by score:");
        for (const s of result.debug.topSentences) {
            const pathStr = s.headingPath.length > 0 ? ` [${s.headingPath.join(" > ")}]` : "";
            logger.debug(`  ${s.score.toFixed(3)}${pathStr}: ${s.text}`);
        }
    }

    console.log("=".repeat(60));
}

function printUsage(): void {
    console.log(`
peeky-search: IR-based excerpt extraction from HTML

Usage:
  node dist/index.js [options]

Modes:
  --file path       Process a local HTML file (default mode)
  --url URL         Fetch and process a single URL (with --query for focused extraction)
  --search          Search via SearXNG and extract from multiple pages
  --fetch           Fetch a URL and return cleaned content (use with --url)

Options:
  --query "text"    Search query (required for --url and --search)
  --max N           Max results for --search mode (default: 5)
  --debug           Show debug information
  --diagnostics     Show page-by-page extraction diagnostics (--search only)
  --timing, -t      Show performance timing breakdown
  --help, -h        Show this help message

Examples:
  # Process local file
  node dist/index.js --query "invite member" --file page.html

  # Fetch and process a URL
  node dist/index.js --url "https://clerk.com/docs/..." --query "invitation redirect"

  # Search via SearXNG (requires SEARXNG_URL env var)
  node dist/index.js --search --query "Clerk organization invitation redirect_url"

  # Fetch a page and return full cleaned content
  node dist/index.js --fetch --url "https://react.dev/learn"

  # Fetch a page with query for focused extraction
  node dist/index.js --fetch --url "https://react.dev/learn" --query "useState"

  # Run with timing enabled
  node dist/index.js --search --query "React hooks" --timing
`);
}

// Run main
main().catch(err => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
