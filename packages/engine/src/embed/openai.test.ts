import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderUnavailableError } from "../errors";
import { createOpenAIEmbedder } from "./openai";

interface Recorded {
  headers: IncomingMessage["headers"];
  body: { model: string; input: string[]; encoding_format: string; dimensions?: number };
}

type Handler = (req: Recorded, res: ServerResponse, n: number) => void;

let server: Server | undefined;
let requests: Recorded[] = [];

async function start(handler: Handler): Promise<string> {
  requests = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const rec: Recorded = { headers: req.headers, body: JSON.parse(raw) };
      requests.push(rec);
      handler(rec, res, requests.length);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

function ok(rec: Recorded, res: ServerResponse, dims = 4): void {
  const data = rec.body.input
    .map((text, index) => ({
      index,
      embedding: Array.from({ length: dims }, (_, d) => (d === 0 ? text.length + 1 : 1)),
    }))
    .reverse();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data }));
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe("createOpenAIEmbedder", () => {
  it("posts the request, applies prefixes, auth, order and normalization", async () => {
    const base = await start((r, res) => ok(r, res));
    const e = createOpenAIEmbedder({
      name: "p",
      apiKey: "sk-secret",
      config: { kind: "openai", base_url: base + "/", model: "m", dimensions: 4, doc_prefix: "D:", query_prefix: "Q:" },
    });
    await e.init();
    const docs = await e.embedDocuments(["a", "bbb"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toEqual({ model: "m", input: ["D:a", "D:bbb"], encoding_format: "float", dimensions: 4 });
    expect(requests[0]!.headers.authorization).toBe("Bearer sk-secret");
    expect(docs[0]![0]! / docs[0]![1]!).toBeCloseTo(4, 5);
    expect(docs[1]![0]! / docs[1]![1]!).toBeCloseTo(6, 5);
    for (const v of docs) expect(Math.hypot(...v)).toBeCloseTo(1, 5);
    await e.embedQueries(["x"]);
    expect(requests[1]!.body.input).toEqual(["Q:x"]);
    expect(e.info.remote).toBe(false);
    expect(e.info.host).toBe("127.0.0.1");
    expect(e.info.maxInputTokens).toBe(8192);
    expect(e.countTokens("abcdefgh")).toBe(2);
  });

  it("omits auth without a key and marks non-loopback hosts remote", async () => {
    const base = await start((r, res) => ok(r, res));
    const e = createOpenAIEmbedder({ name: "p", config: { kind: "openai", base_url: base, model: "m" } });
    await e.embedDocuments(["a"]);
    expect(requests[0]!.headers.authorization).toBeUndefined();
    expect(requests[0]!.body.dimensions).toBeUndefined();
    const r = createOpenAIEmbedder({ name: "p", config: { kind: "openai", base_url: "https://api.openai.com/v1", model: "m" } });
    expect(r.info.remote).toBe(true);
    expect(r.info.host).toBe("api.openai.com");
  });

  it("probes dimensions in init", async () => {
    const base = await start((r, res) => ok(r, res, 7));
    const e = createOpenAIEmbedder({ name: "p", config: { kind: "openai", base_url: base, model: "m" } });
    await e.init();
    expect(requests).toHaveLength(1);
    expect(e.info.dims).toBe(7);
    expect(e.info.modelId).toBe("p/m@7");
  });

  it("splits into batches with bounded concurrency", async () => {
    let active = 0;
    let peak = 0;
    const base = await start((r, res) => {
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        ok(r, res);
      }, 30);
    });
    const e = createOpenAIEmbedder({
      name: "p",
      config: { kind: "openai", base_url: base, model: "m", batch_size: 2, concurrency: 2 },
    });
    const out = await e.embedDocuments(["a", "bb", "ccc", "dddd", "eeeee"]);
    expect(out).toHaveLength(5);
    expect(requests.map((r) => r.body.input.length)).toEqual([2, 2, 1]);
    expect(peak).toBe(2);
    expect(out[4]![0]! / out[4]![1]!).toBeCloseTo(6, 5);
  });

  it("retries 429 honoring Retry-After seconds", async () => {
    const base = await start((r, res, n) => {
      if (n === 1) {
        res.statusCode = 429;
        res.setHeader("retry-after", "0");
        res.end("slow down");
      } else ok(r, res);
    });
    const e = createOpenAIEmbedder({ name: "p", config: { kind: "openai", base_url: base, model: "m" } });
    await e.embedDocuments(["a"]);
    expect(requests).toHaveLength(2);
  });

  it("retries 429 with an HTTP-date Retry-After", async () => {
    const base = await start((r, res, n) => {
      if (n === 1) {
        res.statusCode = 429;
        res.setHeader("retry-after", new Date(Date.now() - 1000).toUTCString());
        res.end();
      } else ok(r, res);
    });
    const e = createOpenAIEmbedder({ name: "p", config: { kind: "openai", base_url: base, model: "m" } });
    await e.embedDocuments(["a"]);
    expect(requests).toHaveLength(2);
  });

  it("retries 500 and then succeeds", async () => {
    const base = await start((r, res, n) => {
      if (n === 1) {
        res.statusCode = 500;
        res.end("boom");
      } else ok(r, res);
    });
    const e = createOpenAIEmbedder({ name: "p", config: { kind: "openai", base_url: base, model: "m" } });
    await e.embedDocuments(["a"]);
    expect(requests).toHaveLength(2);
  });

  it("throws ProviderUnavailableError with retryAfterMs when retries are exhausted", async () => {
    const base = await start((_r, res) => {
      res.statusCode = 429;
      res.setHeader("retry-after", "0");
      res.end();
    });
    const e = createOpenAIEmbedder({ name: "p", config: { kind: "openai", base_url: base, model: "m" } });
    const err = await e.embedDocuments(["a"]).catch((x) => x);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err.retryAfterMs).toBe(0);
    expect(requests).toHaveLength(5);
  });

  it("does not retry 401 and does not leak the key", async () => {
    const base = await start((r, res) => {
      res.statusCode = 401;
      res.end(`bad key ${r.headers.authorization}`);
    });
    const e = createOpenAIEmbedder({
      name: "p",
      apiKey: "sk-secret",
      config: { kind: "openai", base_url: base, model: "m" },
    });
    const err = await e.embedDocuments(["a"]).catch((x) => x);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(requests).toHaveLength(1);
    expect(err.message).toContain("401");
    expect(err.message).not.toContain("sk-secret");
  });

  it("times out", async () => {
    const base = await start(() => undefined);
    const e = createOpenAIEmbedder({
      name: "p",
      timeoutMs: 100,
      config: { kind: "openai", base_url: base, model: "m" },
    });
    const err = await e.embedDocuments(["a"]).catch((x) => x);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err.message).toContain("timed out");
  });

  it("maps network errors to ProviderUnavailableError without the key", async () => {
    const e = createOpenAIEmbedder({
      name: "p",
      apiKey: "sk-secret",
      fetchImpl: async () => {
        throw new Error("connect failed sk-secret");
      },
      config: { kind: "openai", base_url: "http://127.0.0.1:1/v1", model: "m" },
    });
    const err = await e.embedDocuments(["a"]).catch((x) => x);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err.message).not.toContain("sk-secret");
  });

  it("propagates caller aborts", async () => {
    const base = await start(() => undefined);
    const e = createOpenAIEmbedder({ name: "p", config: { kind: "openai", base_url: base, model: "m" } });
    const ac = new AbortController();
    const p = e.embedDocuments(["a"], ac.signal).catch((x) => x);
    setTimeout(() => ac.abort(new Error("cancelled")), 50);
    expect((await p).message).toBe("cancelled");
  });
});
