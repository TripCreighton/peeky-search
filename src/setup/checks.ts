import { exec } from "child_process";
import { promisify } from "util";
import * as net from "net";

const execAsync = promisify(exec);

export interface CheckResult {
    success: boolean;
    message: string;
}

/**
 * Check if Docker is installed
 */
export async function checkDockerInstalled(): Promise<CheckResult> {
    try {
        await execAsync("docker --version");
        return { success: true, message: "Docker is installed" };
    } catch {
        return {
            success: false,
            message: "Docker not found. Install from https://docker.com",
        };
    }
}

/**
 * Check if Docker daemon is running
 */
export async function checkDockerRunning(): Promise<CheckResult> {
    try {
        await execAsync("docker info");
        return { success: true, message: "Docker is running" };
    } catch {
        return {
            success: false,
            message: "Docker is not running. Please start Docker Desktop.",
        };
    }
}

/**
 * Check if a port is available
 */
export async function checkPortAvailable(port: number): Promise<CheckResult> {
    return new Promise((resolve) => {
        const server = net.createServer();

        server.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
                resolve({
                    success: false,
                    message: `Port ${port} is in use. Use --port to specify another.`,
                });
            } else {
                resolve({
                    success: false,
                    message: `Port check failed: ${err.message}`,
                });
            }
        });

        server.once("listening", () => {
            server.close(() => {
                resolve({ success: true, message: `Port ${port} is available` });
            });
        });

        server.listen(port, "127.0.0.1");
    });
}

/**
 * Run all prerequisite checks
 */
export async function runAllChecks(port: number): Promise<{
    allPassed: boolean;
    results: CheckResult[];
}> {
    const results: CheckResult[] = [];

    // Check Docker installed
    const dockerInstalled = await checkDockerInstalled();
    results.push(dockerInstalled);
    if (!dockerInstalled.success) {
        return { allPassed: false, results };
    }

    // Check Docker running
    const dockerRunning = await checkDockerRunning();
    results.push(dockerRunning);
    if (!dockerRunning.success) {
        return { allPassed: false, results };
    }

    // Check port available
    const portAvailable = await checkPortAvailable(port);
    results.push(portAvailable);

    return {
        allPassed: results.every((r) => r.success),
        results,
    };
}
