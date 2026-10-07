import picomatch from "picomatch";
import type { SearchFilters } from "@code-embed/protocol";
import { detectLang } from "../scan/lang";

const EXPLICIT_ALIASES: Record<string, string> = { golang: "go", "c++": "cpp", "c#": "csharp" };

export function normalizeLang(lang: string | undefined): string | undefined {
  const l = lang?.trim().toLowerCase();
  if (!l) return undefined;
  return EXPLICIT_ALIASES[l] ?? detectLang(`x.${l}`) ?? l;
}

function compileGlobs(globs: string[] | undefined): ((path: string) => boolean) | null {
  if (!globs?.length) return null;
  const matchers = globs.map((g) => picomatch(g, { dot: true, matchBase: !g.includes("/") }));
  return (path) => matchers.some((m) => m(path));
}

export function compileFilters(f: SearchFilters): (path: string, lang: string | null) => boolean {
  const include = compileGlobs(f.include);
  const exclude = compileGlobs(f.exclude);
  const wanted = normalizeLang(f.lang);
  return (path, lang) => {
    if (wanted && lang !== wanted) return false;
    if (f.pathPrefix && !path.startsWith(f.pathPrefix)) return false;
    if (include && !include(path)) return false;
    if (exclude?.(path)) return false;
    return true;
  };
}
