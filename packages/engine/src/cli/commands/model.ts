import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadProjectConfig } from "../../config/project";
import { loadUserConfig } from "../../config/user";
import { modelsDir } from "../../core/paths";
import { DEFAULT_MODEL_ID, getModel, loadManifest } from "../../embed/catalog";
import { ensureModel, installFromArchive, isModelInstalled } from "../../embed/delivery";
import { resolveRoot } from "../open";
import { EXIT, type CliIO, type CommandRun } from "../types";

function list(io: CliIO, json: boolean): number {
  const items = loadManifest().models.map((m) => ({
    id: m.id,
    dims: m.dims,
    license: m.license,
    sizeMb: m.sizeMb,
    installed: isModelInstalled(m, modelsDir()),
    isDefault: m.id === DEFAULT_MODEL_ID,
  }));
  if (json) {
    io.stdout.write(JSON.stringify(items) + "\n");
    return EXIT.OK;
  }
  for (const m of items) {
    const marks = [m.installed ? "installed" : "", m.isDefault ? "default" : ""].filter(Boolean).join(", ");
    io.stdout.write(`${m.id}\t${m.dims}d\t${m.sizeMb} MB\t${m.license}${marks ? `\t[${marks}]` : ""}\n`);
  }
  return EXIT.OK;
}

async function install(argv: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { from: { type: "string" }, model: { type: "string" }, root: { type: "string" } },
    strict: true,
  });
  if (values.from) {
    const ids = await installFromArchive(resolve(io.cwd, values.from), modelsDir());
    io.stdout.write(`installed ${ids.join(", ")}\n`);
    return EXIT.OK;
  }
  const id =
    values.model ??
    loadProjectConfig(resolveRoot(io, values)).embedding?.model ??
    loadUserConfig().embedding?.model ??
    DEFAULT_MODEL_ID;
  const entry = getModel(id);
  let lastPct = -1;
  await ensureModel(entry, {
    modelsDir: modelsDir(),
    onProgress(done, total) {
      const pct = Math.floor((done / total) * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      if (io.isTTY) io.stderr.write(`\r\x1b[Kdownloading ${entry.id}: ${pct}%`);
      else if (pct % 10 === 0) io.stderr.write(`downloading ${entry.id}: ${pct}%\n`);
    },
  });
  if (io.isTTY && lastPct >= 0) io.stderr.write("\n");
  io.stdout.write(`installed ${entry.id}\n`);
  return EXIT.OK;
}

export const run: CommandRun = async (argv, io) => {
  try {
    const [sub, ...rest] = argv;
    if (sub === "list") {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } }, strict: true });
      return list(io, values.json ?? false);
    }
    if (sub === "install") return await install(rest, io);
    io.stderr.write("usage: code-embed model install [--from FILE] | model list\n");
    return EXIT.ERROR;
  } catch (err) {
    io.stderr.write(`code-embed: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.ERROR;
  }
};
