import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { ErrorCodes, Methods, PROTOCOL_VERSION, type InitializeResult, type SearchResponse } from "@code-embed/protocol";
import { CLI, makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
let child: ChildProcess;
let conn: MessageConnection;

beforeEach(() => {
  sb = makeSandbox();
  child = spawn(process.execPath, [CLI, "serve"], { cwd: sb.root, env: sb.env, stdio: ["pipe", "pipe", "ignore"] });
  conn = createMessageConnection(new StreamMessageReader(child.stdout!), new StreamMessageWriter(child.stdin!));
  conn.listen();
});

afterEach(async () => {
  conn.dispose();
  child.kill();
  await sb.cleanup();
});

describe("serve (R-74, R-76)", () => {
  it("rejects a wrong protocolVersion with -32001", async () => {
    await expect(
      conn.sendRequest(Methods.initialize, {
        root: sb.root,
        clientName: "e2e",
        protocolVersion: PROTOCOL_VERSION + 1,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.ProtocolMismatch });
  });

  it("initializes and then searches", async () => {
    const init = await conn.sendRequest<InitializeResult>(Methods.initialize, {
      root: sb.root,
      clientName: "e2e",
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(init.capabilities.search).toBe(true);

    let res: SearchResponse | undefined;
    for (let i = 0; i < 50; i++) {
      res = await conn.sendRequest<SearchResponse>(Methods.search, { query: "refund payment", mode: "lexical" });
      if (res.results.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(res!.results.length).toBeGreaterThan(0);
    expect(res!.results.some((r) => r.path === "src/payment/refund.ts")).toBe(true);
  });
});
