import { loadProjectConfig } from "../config/project";
import { loadUserConfig } from "../config/user";
import { resolveIndexDir } from "../core/location";

export function indexDirFor(root: string): string {
  const location = loadProjectConfig(root).index?.location ?? loadUserConfig().index?.location ?? "auto";
  return resolveIndexDir(root, location).dir;
}
