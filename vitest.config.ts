import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "protocol",
          root: r("./packages/protocol"),
          include: ["src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "engine",
          root: r("./packages/engine"),
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: ["test/fixtures/**", "**/node_modules/**"],
          testTimeout: 30000,
        },
      },
      {
        resolve: {
          alias: { vscode: r("./packages/extension/test/vscode-stub.ts") },
        },
        test: {
          name: "extension",
          root: r("./packages/extension"),
          include: ["src/**/*.test.ts", "webview/**/*.test.ts"],
          // webview tests opt into the DOM with a `// @vitest-environment happy-dom` docblock.
          exclude: ["test/e2e/**", "**/node_modules/**"],
        },
      },
      {
        test: {
          name: "eval",
          root: r("./eval"),
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "stage0/**/*.test.ts"],
          passWithNoTests: true,
        },
      },
    ],
  },
});
