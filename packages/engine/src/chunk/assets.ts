import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGUAGES } from "./languages";

const require = createRequire(import.meta.url);

function nodeModulesDir(): string | null {
  try {
    return join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
  } catch {
    return null;
  }
}

export function grammarPathFrom(lang: string, here: string): string {
  const spec = LANGUAGES[lang];
  if (!spec) throw new Error(`no grammar for language: ${lang}`);
  const dirs = [join(here, "grammars"), join(here, "..", "..", "grammars")];
  const nm = nodeModulesDir();
  if (nm) dirs.push(nm);
  for (const dir of dirs) {
    const p = join(dir, spec.wasm);
    if (existsSync(p)) return p;
  }
  throw new Error(`grammar file ${spec.wasm} not found (looked in ${dirs.join(", ")})`);
}

export function grammarPath(lang: string): string {
  return grammarPathFrom(lang, dirname(fileURLToPath(import.meta.url)));
}
