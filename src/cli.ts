#!/usr/bin/env node

import { runSetup, printStatus } from "./setup/index";
import { startContainer, stopContainer } from "./setup/docker";
import { uninstall } from "./setup/uninstall";

const HELP_TEXT = `
peeky-search - Web search tool for MCP (Model Context Protocol)

Searches the web via a local SearXNG instance, scrapes pages, and extracts
relevant excerpts using IR (information retrieval) techniques. Exposes a
"peeky_web_search" tool to any MCP-compatible client.

REQUIREMENTS:
  Docker            Required to run SearXNG (the search backend)

QUICK START:
  npx peeky-search setup       One-time setup (starts SearXNG in Docker)
  Then add the MCP config to your client and restart it.

COMMANDS:
  setup [options]    Install and start SearXNG
    --port <port>      Use custom port (default: 8888)
    --check            Check prerequisites only, don't install

  start              Start the SearXNG container
  stop               Stop the SearXNG container
  status             Check if SearXNG is running
  uninstall          Stop container and remove all config

  mcp                Start the MCP server (called by MCP clients)
  help, --help       Show this help message

EXAMPLES:
  npx peeky-search setup                    # First-time setup
  npx peeky-search setup --port 9999        # Use a different port
  npx peeky-search status                   # Check if running
  npx peeky-search stop                     # Stop SearXNG
  npx peeky-search start                    # Start SearXNG again
  npx peeky-search uninstall                # Remove everything
`;

async function main(): Promise<void> {
    const args = process.argv.slice(2).filter((a) => a !== "--");
    const command = args[0];

    // Parse options for setup command
    function parseSetupOptions(): { port?: number; checkOnly?: boolean } {
        const options: { port?: number; checkOnly?: boolean } = {};
        for (let i = 1; i < args.length; i++) {
            const arg = args[i];
            const nextArg = args[i + 1];
            if (arg === "--port" && nextArg !== undefined) {
                options.port = parseInt(nextArg, 10);
                i++;
            } else if (arg === "--check") {
                options.checkOnly = true;
            }
        }
        return options;
    }

    switch (command) {
        case "setup": {
            const options = parseSetupOptions();
            const success = await runSetup(options);
            process.exit(success ? 0 : 1);
            break;
        }

        case "start": {
            console.log("\nStarting SearXNG container...");
            const result = await startContainer();
            if (result.success) {
                console.log("  \u2713 " + result.message);
                console.log("\nRun 'peeky-search status' to verify.\n");
            } else {
                console.log("  \u2717 " + result.message + "\n");
                process.exit(1);
            }
            break;
        }

        case "stop": {
            console.log("\nStopping SearXNG container...");
            const result = await stopContainer();
            if (result.success) {
                console.log("  \u2713 " + result.message + "\n");
            } else {
                console.log("  \u2717 " + result.message + "\n");
                process.exit(1);
            }
            break;
        }

        case "status": {
            await printStatus();
            break;
        }

        case "uninstall": {
            console.log("\npeeky-search uninstall");
            console.log("=".repeat(60));

            const result = await uninstall();
            console.log("");
            for (const step of result.steps) {
                const symbol = step.success ? "\u2713" : "\u2717";
                console.log(`  ${symbol} ${step.message}`);
            }

            if (result.success) {
                console.log("\n  \u2705 Uninstall complete!");
                console.log(
                    "\n  Note: Remember to remove peeky-search from your MCP client config.\n"
                );
            } else {
                console.log("\n  Some steps failed. Check the errors above.\n");
                process.exit(1);
            }
            break;
        }

        case "mcp": {
            // Dynamically import and run MCP server
            await import("./mcp/server");
            break;
        }

        case "--help":
        case "-h":
        case "help": {
            console.log(HELP_TEXT);
            break;
        }

        case undefined: {
            // No command - show help
            console.log(HELP_TEXT);
            break;
        }

        default: {
            // Check if it's an extraction command (--file, --url, --search, --query)
            if (
                command?.startsWith("--") ||
                command?.startsWith("-")
            ) {
                // Re-export argv and run the original index.ts logic
                await runExtraction(args);
            } else {
                console.log(`Unknown command: ${command}`);
                console.log("Run 'peeky-search --help' for usage.\n");
                process.exit(1);
            }
        }
    }
}

/**
 * Run the extraction pipeline (original index.ts logic)
 * Note: This just delegates to the original index.ts entry point
 */
async function runExtraction(_args: string[]): Promise<void> {
    // Simply import and run the original index.ts which handles all extraction logic
    await import("./index");
}

// Run main
main().catch((err) => {
    console.error(`Unexpected error: ${err}`);
    process.exit(1);
});
