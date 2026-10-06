import { realpathSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { configDir } from "../core/paths";
import { readToml, writeFileAtomic } from "./toml";

interface Consent {
  root: string;
  host: string;
}

const file = () => join(configDir(), "consents.toml");

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

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
  const r = realRoot(root);
  const h = host.toLowerCase();
  return load().some((c) => c.root === r && c.host === h);
}

export function grantConsent(root: string, host: string): void {
  if (hasConsent(root, host)) return;
  const list = load();
  list.push({ root: realRoot(root), host: host.toLowerCase() });
  writeFileAtomic(file(), stringify({ consent: list }));
}
