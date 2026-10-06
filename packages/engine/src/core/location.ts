import { existsSync, readFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { join, sep } from "node:path";
import { cacheDir, rootHash } from "./paths";

export type IndexLocation = "auto" | "project" | "cache";

export interface ResolvedIndexDir {
  dir: string;
  inCache: boolean;
  reason?: string;
}

export const INDEX_DIR_NAME = ".code-embed";

const NETWORK_FS = new Set(["nfs", "nfs4", "cifs", "smb", "smb2", "smb3", "smbfs"]);

function isWsl(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME) || /microsoft/i.test(release());
}

function networkMountReason(root: string): string | null {
  const file = process.env.CODE_EMBED_PROC_MOUNTS || "/proc/mounts";
  if (!existsSync(file)) return null;
  let best: { mount: string; type: string } | null = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [, rawMount, type] = line.split(" ");
    if (!rawMount || !type) continue;
    const mount = rawMount.replace(/\\040/g, " ");
    const matches = root === mount || root.startsWith(mount.endsWith("/") ? mount : `${mount}/`);
    if (matches && (!best || mount.length >= best.mount.length)) best = { mount, type };
  }
  return best && NETWORK_FS.has(best.type) ? `network file system (${best.type})` : null;
}

export function detectRiskyPath(root: string): string | null {
  const normalized = root.split(sep).join("/");
  const lower = normalized.toLowerCase();
  const home = homedir().split(sep).join("/");

  if (/\/dropbox(\/|$)/i.test(normalized)) return "Dropbox folder";
  if (lower.includes("/library/mobile documents/") || lower.endsWith("/library/mobile documents"))
    return "iCloud Drive";
  if (/\/onedrive[^/]*(\/|$)/i.test(normalized)) return "OneDrive folder";

  if (process.platform === "darwin") {
    const docs = `${home}/Documents`;
    if (normalized === docs || normalized.startsWith(`${docs}/`))
      return "~/Documents (may be synced by iCloud Drive)";
  }

  if (process.platform === "linux") {
    if (isWsl() && /^\/mnt\/[a-z](\/|$)/i.test(normalized)) return "Windows drive mounted in WSL";
    return networkMountReason(root);
  }
  return null;
}

export function resolveIndexDir(root: string, location: IndexLocation): ResolvedIndexDir {
  const projectDir = join(root, INDEX_DIR_NAME);
  const cached = (reason: string): ResolvedIndexDir => ({
    dir: join(cacheDir(), "indexes", rootHash(root)),
    inCache: true,
    reason,
  });
  if (location === "project") return { dir: projectDir, inCache: false };
  if (location === "cache") return cached("index.location = cache");
  const risk = detectRiskyPath(root);
  if (!risk) return { dir: projectDir, inCache: false };
  return cached(`${risk}: index stored in the cache instead of ${projectDir}`);
}
