import type { EngineSettings } from "@code-embed/protocol";

export const SECTION = "codeEmbed";

export function readEngineSettings(): EngineSettings {
  throw new Error("not implemented: settings.readEngineSettings");
}

export function workspaceRoot(): string | undefined {
  throw new Error("not implemented: settings.workspaceRoot");
}
