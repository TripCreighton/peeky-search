import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts", "src/**/__tests__/**/*.ts"],
        environment: "node",
        globals: false,
        testTimeout: 10000,
        coverage: {
            provider: "v8",
            reporter: ["text", "html"],
            include: ["src/**/*.ts"],
            exclude: ["src/**/*.test.ts", "src/**/__tests__/**"],
        },
    },
});
