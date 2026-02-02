import * as fs from "fs";
import { stopContainer, getConfigDir } from "./docker";

export interface UninstallResult {
    success: boolean;
    steps: { step: string; success: boolean; message: string }[];
}

/**
 * Uninstall peeky-search: stop container and remove config
 */
export async function uninstall(): Promise<UninstallResult> {
    const steps: UninstallResult["steps"] = [];
    const configDir = getConfigDir();

    // Stop container
    const stopResult = await stopContainer();
    steps.push({
        step: "Stop container",
        success: stopResult.success,
        message: stopResult.message,
    });

    // Remove config directory
    if (fs.existsSync(configDir)) {
        try {
            fs.rmSync(configDir, { recursive: true, force: true });
            steps.push({
                step: "Remove config",
                success: true,
                message: `Removed ${configDir}`,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            steps.push({
                step: "Remove config",
                success: false,
                message: `Failed to remove config: ${message}`,
            });
        }
    } else {
        steps.push({
            step: "Remove config",
            success: true,
            message: "Config directory not found (already removed)",
        });
    }

    return {
        success: steps.every((s) => s.success),
        steps,
    };
}
