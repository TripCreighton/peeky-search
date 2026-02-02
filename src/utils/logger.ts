export interface TimingResult {
    label: string;
    durationMs: number;
}

class Logger {
    private static instance: Logger;
    private timings: TimingResult[] = [];
    private timingEnabled: boolean = false;

    private constructor() {
        // Private constructor to prevent direct instantiation
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    public log(message: string) {
        console.log(`[${new Date().toISOString()}] [INFO] ${message}`);
    }

    public error(message: string) {
        console.error(`[${new Date().toISOString()}] [ERROR] ${message}`);
    }

    public debug(message: string, enabled: boolean = true): void {
        if (enabled) {
            console.error(`[${new Date().toISOString()}] [DEBUG] ${message}`);
        }
    }

    /**
     * Enable or disable timing collection
     */
    public setTimingEnabled(enabled: boolean): void {
        this.timingEnabled = enabled;
        if (enabled) {
            this.timings = [];
        }
    }

    /**
     * Time a synchronous function and record the result
     */
    public time<T>(label: string, fn: () => T): T {
        if (!this.timingEnabled) {
            return fn();
        }
        const start = performance.now();
        const result = fn();
        const durationMs = performance.now() - start;
        this.timings.push({ label, durationMs });
        return result;
    }

    /**
     * Time an async function and record the result
     */
    public async timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
        if (!this.timingEnabled) {
            return fn();
        }
        const start = performance.now();
        const result = await fn();
        const durationMs = performance.now() - start;
        this.timings.push({ label, durationMs });
        return result;
    }

    /**
     * Get all recorded timings
     */
    public getTimings(): TimingResult[] {
        return [...this.timings];
    }

    /**
     * Clear recorded timings
     */
    public clearTimings(): void {
        this.timings = [];
    }

    /**
     * Record a timing directly (useful for manual timing measurements)
     */
    public recordTiming(label: string, durationMs: number): void {
        if (this.timingEnabled) {
            this.timings.push({ label, durationMs });
        }
    }

    /**
     * Print timing summary to console
     */
    public printTimings(): void {
        if (this.timings.length === 0) {
            console.error("[TIMING] No timings recorded");
            return;
        }

        console.error("\n[TIMING] === Performance Summary ===");
        const total = this.timings.reduce((sum, t) => sum + t.durationMs, 0);

        for (const timing of this.timings) {
            const pct = ((timing.durationMs / total) * 100).toFixed(1);
            console.error(`[TIMING] ${timing.label.padEnd(30)} ${timing.durationMs.toFixed(2).padStart(8)}ms (${pct.padStart(5)}%)`);
        }

        console.error(`[TIMING] ${"TOTAL".padEnd(30)} ${total.toFixed(2).padStart(8)}ms`);
        console.error("[TIMING] ================================\n");
    }
}

export default Logger;