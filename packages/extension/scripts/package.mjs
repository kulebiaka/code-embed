import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const TARGETS = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];

const bundled = new Set(["onnxruntime-web", "tree-sitter-wasms", "sharp"]);
const prunePaths = {
  "@huggingface/transformers": [
    "src",
    "types",
    "dist/transformers.js",
    "dist/transformers.min.js",
    "dist/transformers.web.js",
    "dist/transformers.web.min.js",
  ],
};

const here = dirname(fileURLToPath(import.meta.url));
const extDir = join(here, "..");
const engineDir = join(extDir, "..", "engine");
const rootDir = join(extDir, "..", "..");
const DIST_FILES = ["extension.js", "webview.js", "webview.css", "settings.js", "settings.css", "codicon.ttf"];

function matches(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  const neg = list.filter((x) => x.startsWith("!")).map((x) => x.slice(1));
  if (neg.includes(value)) return false;
  const pos = list.filter((x) => !x.startsWith("!"));
  return pos.length === 0 || pos.includes(value);
}

export function supportsTarget(pkg, target) {
  const [os, cpu] = target.split("-");
  if (!matches(pkg.os, os) || !matches(pkg.cpu, cpu)) return false;
  return os !== "linux" || matches(pkg.libc, "glibc");
}

async function findPackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpath(candidate);
    if (dirname(dir) === dir) return null;
  }
}

export async function collectRuntimeDeps(target, roots) {
  const found = new Map();
  const queue = roots.map((name) => ({ name, from: engineDir, optional: false }));
  while (queue.length > 0) {
    const { name, from, optional } = queue.shift();
    if (found.has(name) || bundled.has(name)) continue;
    const dir = await findPackage(name, from);
    if (!dir) {
      if (optional) continue;
      throw new Error(`dependency ${name} is not installed (run pnpm install)`);
    }
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    if (!supportsTarget(pkg, target)) continue;
    found.set(name, { dir, version: pkg.version });
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: dir, optional: false });
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name: dep, from: dir, optional: true });
  }
  return found;
}

async function pruneOnnxBinaries(dir, target) {
  const [os, cpu] = target.split("-");
  const bin = join(dir, "bin");
  if (!existsSync(bin)) return;
  for (const napi of await readdir(bin)) {
    const napiDir = join(bin, napi);
    for (const platform of await readdir(napiDir)) {
      if (platform !== os) {
        await rm(join(napiDir, platform), { recursive: true, force: true });
        continue;
      }
      for (const arch of await readdir(join(napiDir, platform))) {
        const archDir = join(napiDir, platform, arch);
        if (arch !== cpu) {
          await rm(archDir, { recursive: true, force: true });
          continue;
        }
        const names = new Set(await readdir(archDir));
        for (const n of names) {
          const dup = /^libonnxruntime\.(?:so\.\d+|\d+)\.\d+\.\d+(?:\.dylib)?$/.test(n);
          if (dup) {
            const short = n.replace(/\.\d+\.\d+(\.dylib)?$/, "$1");
            if (names.has(short)) await rm(join(archDir, n), { force: true });
          }
        }
      }
    }
  }
}

const skipFile = /\.(map|md|d\.ts|d\.mts|d\.cts)$/;

async function copyRuntimeDeps(found, target, dest) {
  for (const [name, { dir }] of found) {
    const out = join(dest, name);
    await cp(dir, out, {
      recursive: true,
      filter: (src) => !skipFile.test(src) && !src.endsWith("node_modules"),
    });
    for (const rel of prunePaths[name] ?? []) await rm(join(out, rel), { recursive: true, force: true });
    if (name === "onnxruntime-node") await pruneOnnxBinaries(out, target);
  }
}

async function writeSharpStub(dest) {
  const dir = join(dest, "sharp");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "sharp", version: "0.0.0-stub", type: "module", main: "index.js" }),
  );
  await writeFile(
    join(dir, "index.js"),
    'export default function sharp() {\n  throw new Error("sharp is not bundled: image processing is not supported");\n}\n',
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      out: { type: "string", default: join(extDir, "dist-vsix") },
      "allow-cross": { type: "boolean", default: false },
    },
  });
  const target = values.target;
  if (!target || !TARGETS.includes(target)) {
    throw new Error(`--target must be one of: ${TARGETS.join(", ")}`);
  }
  const host = `${process.platform}-${process.arch}`;
  if (target !== host && !values["allow-cross"]) {
    throw new Error(
      `target ${target} differs from host ${host}: native packages are copied from the host install; run on a ${target} runner or pass --allow-cross`,
    );
  }

  const engineDist = join(engineDir, "dist");
  const required = [
    ...DIST_FILES.map((f) => join(extDir, "dist", f)),
    join(engineDist, "cli.js"),
    join(engineDist, "grammars"),
    join(engineDist, "tree-sitter.wasm"),
    join(engineDist, "externals.json"),
  ];
  for (const f of required) if (!existsSync(f)) throw new Error(`${f} is missing (run pnpm build)`);

  const roots = JSON.parse(await readFile(join(engineDist, "externals.json"), "utf8"));
  const enginePkg = JSON.parse(await readFile(join(engineDir, "package.json"), "utf8"));
  const direct = roots.filter((n) => enginePkg.dependencies?.[n]);
  const found = await collectRuntimeDeps(target, direct);

  const stage = await mkdtemp(join(tmpdir(), "code-embed-vsix-"));
  try {
    const pkg = JSON.parse(await readFile(join(extDir, "package.json"), "utf8"));
    delete pkg.scripts;
    delete pkg.dependencies;
    delete pkg.devDependencies;
    await writeFile(join(stage, "package.json"), JSON.stringify(pkg, null, 2));

    const dist = join(stage, "dist");
    await mkdir(join(dist, "engine"), { recursive: true });
    for (const f of DIST_FILES) await cp(join(extDir, "dist", f), join(dist, f));
    await cp(join(engineDist, "cli.js"), join(dist, "engine/cli.js"));
    await cp(join(engineDist, "grammars"), join(dist, "engine/grammars"), { recursive: true });
    await cp(join(engineDist, "tree-sitter.wasm"), join(dist, "engine/tree-sitter.wasm"));
    await writeFile(join(dist, "engine/package.json"), JSON.stringify({ type: "module" }));

    if (existsSync(join(extDir, "media"))) await cp(join(extDir, "media"), join(stage, "media"), { recursive: true });
    for (const f of ["LICENSE", "README.md"]) {
      if (existsSync(join(rootDir, f))) await cp(join(rootDir, f), join(stage, f));
    }
    if (existsSync(join(extDir, ".vscodeignore"))) await cp(join(extDir, ".vscodeignore"), join(stage, ".vscodeignore"));

    await copyRuntimeDeps(found, target, join(dist, "engine/node_modules"));
    await writeSharpStub(join(dist, "engine/node_modules"));

    const out = resolve(values.out);
    await mkdir(out, { recursive: true });
    const vsix = join(out, `${pkg.name}-${target}-${pkg.version}.vsix`);
    const vsce = join(extDir, "node_modules/.bin/vsce");
    const r = spawnSync(
      vsce,
      ["package", "--target", target, "--no-dependencies", "--allow-missing-repository", "--out", vsix],
      { cwd: stage, stdio: "inherit", shell: process.platform === "win32" },
    );
    if (r.status !== 0) throw new Error(`vsce package failed (exit ${r.status})`);
    console.log(`${vsix} (${found.size} runtime packages)`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
