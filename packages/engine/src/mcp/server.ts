export interface McpServerOptions {
  root: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export function runMcpServer(_opts: McpServerOptions): Promise<void> {
  throw new Error("not implemented: mcp/server.runMcpServer");
}
