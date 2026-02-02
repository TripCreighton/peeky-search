import { exec, spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
    generateSecretKey,
    getDockerComposeTemplate,
    getSettingsTemplate,
    getConfigTemplate,
} from "./templates";

const execAsync = promisify(exec);

const CONFIG_DIR = path.join(os.homedir(), ".peeky-search");

export interface DockerStatus {
    containerRunning: boolean;
    searxngResponding: boolean;
    port: number | null;
}

/**
 * Get the peeky-search config directory path
 */
export function getConfigDir(): string {
    return CONFIG_DIR;
}

/**
 * Read saved config from ~/.peeky-search/config.json
 */
export function readConfig(): { port: number; installedAt: string } | null {
    const configPath = path.join(CONFIG_DIR, "config.json");
    if (!fs.existsSync(configPath)) {
        return null;
    }
    try {
        const content = fs.readFileSync(configPath, "utf8");
        return JSON.parse(content) as { port: number; installedAt: string };
    } catch {
        return null;
    }
}

/**
 * Create config files in ~/.peeky-search/
 */
export function createConfigFiles(port: number): void {
    // Create directory if it doesn't exist
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    // Generate files
    const secretKey = generateSecretKey();

    const dockerComposePath = path.join(CONFIG_DIR, "docker-compose.yml");
    const settingsPath = path.join(CONFIG_DIR, "settings.yml");
    const configPath = path.join(CONFIG_DIR, "config.json");

    fs.writeFileSync(dockerComposePath, getDockerComposeTemplate(port));
    fs.writeFileSync(settingsPath, getSettingsTemplate(secretKey));
    fs.writeFileSync(configPath, getConfigTemplate(port));
}

/**
 * Start the SearXNG container
 */
export async function startContainer(): Promise<{ success: boolean; message: string }> {
    const config = readConfig();
    if (!config) {
        return {
            success: false,
            message: "Config not found. Run 'peeky-search setup' first.",
        };
    }

    try {
        await execAsync("docker compose up -d", { cwd: CONFIG_DIR });
        return { success: true, message: "Container started" };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, message: `Failed to start container: ${message}` };
    }
}

/**
 * Stop the SearXNG container
 */
export async function stopContainer(): Promise<{ success: boolean; message: string }> {
    if (!fs.existsSync(CONFIG_DIR)) {
        return { success: true, message: "No config directory found" };
    }

    try {
        await execAsync("docker compose down", { cwd: CONFIG_DIR });
        return { success: true, message: "Container stopped" };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, message: `Failed to stop container: ${message}` };
    }
}

/**
 * Check if the container is running and SearXNG is responding
 */
export async function getStatus(): Promise<DockerStatus> {
    const config = readConfig();
    const port = config?.port ?? null;

    // Check if container is running
    let containerRunning = false;
    try {
        const { stdout } = await execAsync("docker ps --format '{{.Names}}'");
        containerRunning = stdout.includes("peeky-searxng");
    } catch {
        // Docker not available
    }

    // Check if SearXNG is responding (just check root URL, not search)
    let searxngResponding = false;
    if (port !== null) {
        try {
            const response = await fetch(`http://localhost:${port}/`, {
                signal: AbortSignal.timeout(5000),
            });
            searxngResponding = response.ok;
        } catch {
            // Not responding
        }
    }

    return { containerRunning, searxngResponding, port };
}

/**
 * Wait for SearXNG to be ready
 */
export async function waitForReady(
    port: number,
    timeoutMs: number = 30000
): Promise<boolean> {
    const startTime = Date.now();
    const pollInterval = 1000;

    while (Date.now() - startTime < timeoutMs) {
        try {
            const response = await fetch(`http://localhost:${port}/search?q=test&format=json`, {
                signal: AbortSignal.timeout(2000),
            });
            if (response.ok) {
                return true;
            }
        } catch {
            // Not ready yet
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return false;
}

/**
 * Stream docker compose logs to stdout
 */
export function streamLogs(): void {
    if (!fs.existsSync(CONFIG_DIR)) {
        console.error("Config directory not found");
        return;
    }

    const child = spawn("docker", ["compose", "logs", "-f"], {
        cwd: CONFIG_DIR,
        stdio: "inherit",
    });

    child.on("error", (err) => {
        console.error(`Failed to stream logs: ${err.message}`);
    });
}
