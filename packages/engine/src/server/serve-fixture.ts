import { log } from "../util/log";
import { serveStdio } from "./serve";
import type { LocalEngine } from "../engine/types";

const engine = {
  root: "/fixture",
  initialize: async (p: { protocolVersion: number }) => {
    console.log("stray stdout noise");
    log.info("hello from engine");
    return { serverVersion: "fixture", protocolVersion: p.protocolVersion };
  },
  search: async () => ({ results: [], partial: false, tookMs: 1 }),
  onProgress: () => ({ dispose() {} }),
  onIndexError: () => ({ dispose() {} }),
  onLog: () => ({ dispose() {} }),
  close: async () => {},
} as unknown as LocalEngine;

await serveStdio({ createEngine: async () => engine });
