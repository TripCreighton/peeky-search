import { runAllChecks } from "./checks";
import {
    createConfigFiles,
    startContainer,
    waitForReady,
    getConfigDir,
    readConfig,
} from "./docker";
import { getMcpConfigJson } from "./templates";

const DEFAULT_PORT = 8888;

export interface SetupOptions {
    port?: number;
    checkOnly?: boolean;
}

function printStep(success: boolean, message: string): void {
    const symbol = success ? "\u2713" : "\u2717";
    console.log(`  ${symbol} ${message}`);
}

function printSection(title: string): void {
    console.log(`\n  ${title}`);
}

/**
 * Run the setup wizard
 */
export async function runSetup(options: SetupOptions = {}): Promise<boolean> {
    const port = options.port ?? DEFAULT_PORT;

    console.log("\npeeky-search setup");
    console.log("=".repeat(60));

    // Run prerequisite checks
    printSection("Checking prerequisites...");
    const { allPassed, results } = await runAllChecks(port);

    for (const result of results) {
        printStep(result.success, result.message);
    }

    if (!allPassed) {
        console.log("\n  Setup cannot continue. Please fix the issues above.\n");
        return false;
    }

    // If check-only mode, stop here
    if (options.checkOnly) {
        console.log("\n  All prerequisites passed!\n");
        return true;
    }

    // Create config files
    printSection("Setting up SearXNG...");

    try {
        createConfigFiles(port);
        printStep(true, `Created ${getConfigDir()}/docker-compose.yml`);
        printStep(true, `Created ${getConfigDir()}/settings.yml (secret key generated)`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        printStep(false, `Failed to create config files: ${message}`);
        return false;
    }

    // Start container
    const startResult = await startContainer();
    if (!startResult.success) {
        printStep(false, startResult.message);
        return false;
    }
    printStep(true, "Started SearXNG container");

    // Wait for SearXNG to be ready
    console.log("  Waiting for SearXNG to be ready...");
    const ready = await waitForReady(port, 60000);
    if (!ready) {
        printStep(false, "SearXNG did not respond within 60 seconds");
        console.log("  Try running 'peeky-search status' to check the container.\n");
        return false;
    }
    printStep(true, `SearXNG is responding at http://localhost:${port}`);

    // Success!
    console.log("\n  " + "\u2705" + " Setup complete!");

    // Show MCP config
    console.log("\n  Add this to your MCP client config:");
    console.log("  " + "-".repeat(56));
    const configJson = getMcpConfigJson(port);
    for (const line of configJson.split("\n")) {
        console.log("  " + line);
    }
    console.log("  " + "-".repeat(56));

    // Show commands and requirements
    console.log("\n  Commands:");
    console.log("    peeky-search start      Start the SearXNG container");
    console.log("    peeky-search stop       Stop the SearXNG container");
    console.log("    peeky-search status     Check if SearXNG is running");
    console.log("    peeky-search uninstall  Remove container and config");

    console.log("\n  Requirements:");
    console.log("    Docker must be running for SearXNG to work.");
    console.log("    The container runs in the background and restarts automatically.");
    console.log("");
    return true;
}

/**
 * Print current status
 */
export async function printStatus(): Promise<void> {
    const config = readConfig();

    console.log("\npeeky-search status");
    console.log("=".repeat(60));

    if (!config) {
        console.log("  Not installed. Run 'peeky-search setup' first.\n");
        return;
    }

    console.log(`  Config directory: ${getConfigDir()}`);
    console.log(`  Port: ${config.port}`);
    console.log(`  Installed: ${config.installedAt}`);

    // Import dynamically to avoid circular deps
    const { getStatus } = await import("./docker");
    const status = await getStatus();

    console.log("");
    printStep(status.containerRunning, `Container ${status.containerRunning ? "running" : "not running"}`);
    printStep(
        status.searxngResponding,
        `SearXNG ${status.searxngResponding ? "responding" : "not responding"} at http://localhost:${config.port}`
    );

    if (!status.containerRunning) {
        console.log("\n  Run 'peeky-search start' to start the container.\n");
    } else {
        console.log("");
    }
}
