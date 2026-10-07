import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCodes,
  FIND_SIMILAR_TOOL_DESCRIPTION,
  MAX_TOOL_TOP,
  SEARCH_MODES,
  SEARCH_TOOL_DESCRIPTION,
  TOOL_NAMES,
  ToolInputError,
  formatForAgent,
  toFindSimilarParams,
  toSearchParams,
  type EngineApi,
  type FindSimilarToolInput,
  type SearchToolInput,
} from "@code-embed/protocol";
import { z } from "zod";
import { NoIndexError } from "../errors";
import { openEngine, type OpenedEngine } from "../server/client";
import { log } from "../util/log";

export interface McpServerOptions {
  root: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const NO_INDEX_HINT = "Индекс не найден. Выполните `code-embed index` в корне проекта.";

const top = z.number().int().min(1).max(MAX_TOOL_TOP).optional();

const searchShape = {
  query: z.string().min(1),
  mode: z.enum(SEARCH_MODES as [string, ...string[]]).optional(),
  top,
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  lang: z.string().optional(),
};

const findSimilarShape = {
  path: z.string().min(1).optional(),
  start_line: z.number().int().min(1).optional(),
  end_line: z.number().int().min(1).optional(),
  code: z.string().min(1).optional(),
  lang: z.string().optional(),
  top,
};

function isNoIndex(err: unknown): boolean {
  return err instanceof NoIndexError || (err as { code?: unknown } | null)?.code === ErrorCodes.NoIndex;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

function failure(err: unknown) {
  if (isNoIndex(err)) return textResult(NO_INDEX_HINT, true);
  if (err instanceof ToolInputError) return textResult(err.message, true);
  const message = err instanceof Error ? err.message : String(err);
  log.error(`mcp tool failed: ${message}`);
  return textResult(message, true);
}

export function createMcpServer(root: string): { server: McpServer; close(): Promise<void> } {
  let opened: Promise<OpenedEngine> | null = null;
  const engine = async (): Promise<EngineApi> => {
    const p = (opened ??= openEngine({ root, clientName: "mcp", readonly: true, vectorPhase: false }));
    try {
      return (await p).api;
    } catch (err) {
      if (opened === p) opened = null;
      throw err;
    }
  };

  const server = new McpServer({ name: "code-embed", version: "0.1.0" });

  server.registerTool(
    TOOL_NAMES.search,
    { description: SEARCH_TOOL_DESCRIPTION, inputSchema: searchShape },
    async (args) => {
      try {
        const params = toSearchParams(args as SearchToolInput);
        return textResult(formatForAgent(await (await engine()).search(params)));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    TOOL_NAMES.findSimilar,
    { description: FIND_SIMILAR_TOOL_DESCRIPTION, inputSchema: findSimilarShape },
    async (args) => {
      try {
        const params = toFindSimilarParams(args as FindSimilarToolInput);
        return textResult(formatForAgent(await (await engine()).findSimilar(params)));
      } catch (err) {
        return failure(err);
      }
    },
  );

  return {
    server,
    async close() {
      const p = opened;
      opened = null;
      if (p) await p.then((o) => o.close()).catch(() => {});
      await server.close();
    },
  };
}

export async function connectMcp(root: string, transport: Transport): Promise<{ close(): Promise<void> }> {
  const { server, close } = createMcpServer(root);
  await server.connect(transport);
  return { close };
}

export async function runMcpServer(opts: McpServerOptions): Promise<void> {
  const transport = new StdioServerTransport(
    (opts.input ?? process.stdin) as Readable,
    (opts.output ?? process.stdout) as Writable,
  );
  const { server, close } = createMcpServer(opts.root);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  await server.connect(transport);
  await closed;
  await close();
}
