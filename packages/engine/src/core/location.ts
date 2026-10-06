export type IndexLocation = "auto" | "project" | "cache";

export interface ResolvedIndexDir {
  dir: string;
  inCache: boolean;
  reason?: string;
}

export const INDEX_DIR_NAME = ".code-embed";

export function detectRiskyPath(_root: string): string | null {
  throw new Error("not implemented: core/location.detectRiskyPath");
}

export function resolveIndexDir(_root: string, _location: IndexLocation): ResolvedIndexDir {
  throw new Error("not implemented: core/location.resolveIndexDir");
}
