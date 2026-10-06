import picomatch from "picomatch";
import type { SearchFilters } from "@code-embed/protocol";

function compileGlobs(globs: string[] | undefined): ((path: string) => boolean) | null {
  if (!globs?.length) return null;
  const matchers = globs.map((g) => picomatch(g, { dot: true, matchBase: !g.includes("/") }));
  return (path) => matchers.some((m) => m(path));
}

export function compileFilters(f: SearchFilters): (path: string, lang: string | null) => boolean {
  const include = compileGlobs(f.include);
  const exclude = compileGlobs(f.exclude);
  return (path, lang) => {
    if (f.lang && lang !== f.lang) return false;
    if (f.pathPrefix && !path.startsWith(f.pathPrefix)) return false;
    if (include && !include(path)) return false;
    if (exclude?.(path)) return false;
    return true;
  };
}
