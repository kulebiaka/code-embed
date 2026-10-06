import type { ProjectConfig } from "./types";

export const PROJECT_CONFIG = ".code-embed.toml";

export function loadProjectConfig(_root: string): ProjectConfig {
  throw new Error("not implemented: config/project.loadProjectConfig");
}

export function writeProjectConfig(_root: string, _patch: ProjectConfig): void {
  throw new Error("not implemented: config/project.writeProjectConfig");
}
