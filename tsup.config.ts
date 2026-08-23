import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/cli.ts", "src/index.ts", "src/mcp/server.ts", "src/eval/cli.ts"],
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    clean: true,
});
