import { isAbsolute, relative, resolve, sep } from "node:path";

export function toStorePath(root: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return p;
  return sep === "/" ? rel : rel.split(sep).join("/");
}

function depth(p: string): number {
  return p.split("/").length;
}

export function orderPaths(all: string[], opened: string[], recent: string[]): string[] {
  const known = new Set(all);
  const out: string[] = [];
  const taken = new Set<string>();
  for (const p of [...opened, ...recent]) {
    if (known.has(p) && !taken.has(p)) {
      taken.add(p);
      out.push(p);
    }
  }
  const rest = all.filter((p) => !taken.has(p));
  rest.sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
  return out.concat(rest);
}
