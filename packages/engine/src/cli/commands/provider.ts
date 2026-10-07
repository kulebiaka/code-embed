import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { ProviderConfig } from "@code-embed/protocol";
import { grantConsent } from "../../config/consents";
import { loadProjectConfig } from "../../config/project";
import { resolveSettings } from "../../config/resolve";
import { loadProviders, loadUserConfig, saveProvider } from "../../config/user";
import { isLoopbackUrl, resolveEmbedder } from "../../embed/registry";
import type { Embedder } from "../../embed/types";
import { askConsent, consentNeeded } from "../consent";
import { resolveRoot } from "../open";
import { EXIT, type CliIO, type CommandRun } from "../types";

const ADD_OPTIONS = {
  kind: { type: "string" },
  "base-url": { type: "string" },
  model: { type: "string" },
  "api-key-env": { type: "string" },
  dimensions: { type: "string" },
  "max-input-tokens": { type: "string" },
  "query-prefix": { type: "string" },
  "doc-prefix": { type: "string" },
  "store-key": { type: "boolean" },
} as const;

function listProviders(io: CliIO, json: boolean): number {
  const items = [
    { name: "local", kind: "local", model: "", baseUrl: undefined as string | undefined, remote: false },
    ...Object.entries(loadProviders()).map(([name, c]) => ({
      name,
      kind: c.kind,
      model: c.model,
      baseUrl: c.base_url,
      remote: !isLoopbackUrl(c.base_url),
    })),
  ];
  if (json) {
    io.stdout.write(JSON.stringify(items) + "\n");
    return EXIT.OK;
  }
  for (const p of items) {
    const where = p.remote ? `external: ${new URL(p.baseUrl!).hostname}` : "local";
    io.stdout.write([p.name, p.kind, p.model, p.baseUrl ?? "", where].join("\t").trimEnd() + "\n");
  }
  return EXIT.OK;
}

function lineReader(io: CliIO) {
  const rl = createInterface({ input: io.stdin, terminal: false });
  const lines: string[] = [];
  const waiters: ((s: string) => void)[] = [];
  let closed = false;
  rl.on("line", (l) => {
    const w = waiters.shift();
    if (w) w(l);
    else lines.push(l);
  });
  rl.on("close", () => {
    closed = true;
    for (const w of waiters.splice(0)) w("");
  });
  return {
    ask(question: string): Promise<string> {
      io.stderr.write(question);
      const next = lines.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (closed) return Promise.resolve("");
      return new Promise((resolve) => waiters.push(resolve));
    },
    close: () => rl.close(),
  };
}

function toInt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} expects a positive integer, got "${raw}"`);
  return n;
}

async function readStdin(io: CliIO): Promise<string> {
  let data = "";
  for await (const chunk of io.stdin) data += String(chunk);
  return data.trim();
}

async function add(argv: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: ADD_OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  let name = positionals[0];
  let kind = values.kind;
  let baseUrl = values["base-url"];
  let model = values.model;
  let apiKeyEnv = values["api-key-env"];
  const interactive = io.isTTY && !values["store-key"];
  if (interactive) {
    const reader = lineReader(io);
    try {
      name ||= (await reader.ask("name: ")).trim();
      kind ||= (await reader.ask("kind [openai]: ")).trim() || "openai";
      baseUrl ||= (await reader.ask("base url: ")).trim();
      model ||= (await reader.ask("model: ")).trim();
      if (apiKeyEnv === undefined) apiKeyEnv = (await reader.ask("api key env var (optional): ")).trim() || undefined;
    } finally {
      reader.close();
    }
  }
  kind ||= "openai";
  if (!name) throw new Error("usage: code-embed provider add <name> --base-url URL --model NAME [--kind openai] [--api-key-env VAR]");
  if (name === "local") throw new Error('"local" is a reserved provider name');
  if (!baseUrl || !model) throw new Error("--base-url and --model are required");
  if (kind !== "openai") throw new Error(`--kind must be "openai", got "${kind}"`);

  const cfg: ProviderConfig = { kind, base_url: baseUrl, model };
  if (apiKeyEnv) cfg.api_key_env = apiKeyEnv;
  const dimensions = toInt("dimensions", values.dimensions);
  if (dimensions !== undefined) cfg.dimensions = dimensions;
  const maxTokens = toInt("max-input-tokens", values["max-input-tokens"]);
  if (maxTokens !== undefined) cfg.max_input_tokens = maxTokens;
  if (values["query-prefix"] !== undefined) cfg.query_prefix = values["query-prefix"];
  if (values["doc-prefix"] !== undefined) cfg.doc_prefix = values["doc-prefix"];

  if (values["store-key"]) {
    const key = await readStdin(io);
    if (!key) throw new Error("--store-key expects the API key on stdin");
    const { Entry } = await import("@napi-rs/keyring");
    new Entry("code-embed", name).setPassword(key);
  }
  saveProvider(name, cfg);
  io.stdout.write(`provider "${name}" saved\n`);
  return EXIT.OK;
}

async function test(argv: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { root: { type: "string" }, "allow-remote": { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  const name = positionals[0];
  if (!name) throw new Error("usage: code-embed provider test <name>");
  const root = resolveRoot(io, values);
  const settings = resolveSettings({
    cli: { provider: name, ...(values["allow-remote"] ? { allowRemote: true } : {}) },
    project: loadProjectConfig(root),
    user: loadUserConfig(),
  });
  const embedderFor = () => resolveEmbedder({ root, settings });
  let embedder: Embedder;
  try {
    embedder = await embedderFor();
  } catch (err) {
    const need = consentNeeded(err);
    if (!need) throw err;
    if (!io.isTTY) {
      io.stderr.write(
        `code-embed: code would be sent to ${need.host}; consent is required. Re-run with --allow-remote to allow it.\n`,
      );
      return EXIT.ERROR;
    }
    if (!(await askConsent(io, need.host))) {
      io.stderr.write("code-embed: consent declined\n");
      return EXIT.ERROR;
    }
    grantConsent(root, need.host);
    embedder = await embedderFor();
  }
  try {
    const t0 = performance.now();
    await embedder.init();
    const [v] = await embedder.embedQueries(["code-embed provider test"]);
    io.stdout.write(`dims: ${v?.length ?? embedder.info.dims}\nlatency: ${Math.round(performance.now() - t0)} ms\n`);
    return EXIT.OK;
  } finally {
    await embedder.dispose();
  }
}

export const run: CommandRun = async (argv, io) => {
  try {
    const [sub, ...rest] = argv;
    if (sub === "list") {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } }, strict: true });
      return listProviders(io, values.json ?? false);
    }
    if (sub === "add") return await add(rest, io);
    if (sub === "test") return await test(rest, io);
    io.stderr.write("usage: code-embed provider list | add <name> | test <name>\n");
    return EXIT.ERROR;
  } catch (err) {
    io.stderr.write(`code-embed: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.ERROR;
  }
};
