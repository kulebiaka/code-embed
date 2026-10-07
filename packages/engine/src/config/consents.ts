import { join } from "node:path";
import { stringify } from "smol-toml";
import { canonicalRoot, configDir } from "../core/paths";
import { readToml, writeFileAtomic } from "./toml";

interface Consent {
  root: string;
  host: string;
}

const file = () => join(configDir(), "consents.toml");

function load(): Consent[] {
  const path = file();
  const list = readToml(path).consent;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${path}: key "consent" must be an array of tables`);
  return list.map((c, i) => {
    if (typeof c?.root !== "string" || typeof c?.host !== "string") {
      throw new Error(`${path}: consent[${i}] needs string "root" and "host"`);
    }
    return { root: c.root, host: c.host };
  });
}

export function hasConsent(root: string, host: string): boolean {
  const r = canonicalRoot(root);
  const h = host.toLowerCase();
  return load().some((c) => c.root === r && c.host === h);
}

export function grantConsent(root: string, host: string): void {
  if (hasConsent(root, host)) return;
  const list = load();
  list.push({ root: canonicalRoot(root), host: host.toLowerCase() });
  writeFileAtomic(file(), stringify({ consent: list }));
}
