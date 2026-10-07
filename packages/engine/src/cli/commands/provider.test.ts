import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProviders } from "../../config/user";
import { EXIT, type CliIO } from "../types";
import { run } from "./provider";

let tmp: string;
let server: Server | undefined;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "ce-provider-")));
  mkdirSync(join(tmp, "repo", ".git"), { recursive: true });
  vi.stubEnv("CODE_EMBED_CACHE_DIR", join(tmp, "cache"));
  vi.stubEnv("CODE_EMBED_CONFIG_DIR", join(tmp, "config"));
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

function makeIO(tty = false, input = "") {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  stdout.on("data", (c) => out.push(String(c)));
  stderr.on("data", (c) => err.push(String(c)));
  if (input) stdin.end(input);
  const io: CliIO = { stdin, stdout, stderr, isTTY: tty, stdoutIsTTY: false, env: process.env, cwd: join(tmp, "repo") };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

async function startServer(): Promise<string> {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { input: string[] };
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: body.input.map((_, index) => ({ index, embedding: [1, 2, 3, 4] })),
        }),
      );
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

describe("provider command", () => {
  it("adds a provider from flags without storing a key", async () => {
    const t = makeIO();
    const code = await run(
      [
        "add",
        "mine",
        "--kind",
        "openai",
        "--base-url",
        "http://127.0.0.1:1/v1",
        "--model",
        "emb",
        "--api-key-env",
        "MY_KEY",
        "--dimensions",
        "256",
        "--query-prefix",
        "Q:",
      ],
      t.io,
    );
    expect(code).toBe(EXIT.OK);
    expect(loadProviders().mine).toMatchObject({
      kind: "openai",
      base_url: "http://127.0.0.1:1/v1",
      model: "emb",
      api_key_env: "MY_KEY",
      dimensions: 256,
      query_prefix: "Q:",
    });
    expect(readFileSync(join(tmp, "config", "providers.toml"), "utf8")).not.toMatch(/api_key\s*=/);
  });

  it("requires flags without a TTY", async () => {
    const t = makeIO();
    expect(await run(["add", "mine", "--model", "emb"], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("--base-url");
  });

  it("adds interactively in a TTY", async () => {
    const t = makeIO(true, "mine\n\nhttp://127.0.0.1:1/v1\nemb\nKEY_VAR\n");
    expect(await run(["add"], t.io)).toBe(EXIT.OK);
    expect(loadProviders().mine).toMatchObject({ kind: "openai", model: "emb", api_key_env: "KEY_VAR" });
  });

  it("lists local and configured providers with destinations", async () => {
    await run(["add", "ext", "--base-url", "https://api.example.com/v1", "--model", "m"], makeIO().io);
    const t = makeIO();
    expect(await run(["list"], t.io)).toBe(EXIT.OK);
    expect(t.out()).toContain("local");
    expect(t.out()).toMatch(/ext\topenai\tm\thttps:\/\/api\.example\.com\/v1\texternal: api\.example\.com/);

    const j = makeIO();
    await run(["list", "--json"], j.io);
    expect(JSON.parse(j.out()).map((p: { name: string }) => p.name)).toEqual(["local", "ext"]);
  });

  it("tests a provider and prints dims and latency", async () => {
    const base = await startServer();
    await run(["add", "loop", "--base-url", base, "--model", "m"], makeIO().io);
    const t = makeIO();
    expect(await run(["test", "loop"], t.io)).toBe(EXIT.OK);
    expect(t.out()).toMatch(/dims: 4\nlatency: \d+ ms/);
  });

  it("refuses an external provider without consent outside a TTY", async () => {
    await run(["add", "ext", "--base-url", "https://api.example.com/v1", "--model", "m"], makeIO().io);
    const t = makeIO();
    expect(await run(["test", "ext"], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("--allow-remote");
  });

  it("fails for an unknown provider", async () => {
    const t = makeIO();
    expect(await run(["test", "ghost"], t.io)).toBe(EXIT.ERROR);
    expect(t.err()).toContain("unknown embedding provider");
  });
});
