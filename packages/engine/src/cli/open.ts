import { resolve } from "node:path";
import type { EngineSettings } from "@code-embed/protocol";
import type { EffectiveSettings } from "../config/types";
import { findProjectRoot } from "../core/root";
import type { LocalEngineOptions } from "../engine/types";
import { openEngine, type OpenedEngine } from "../server/client";
import type { CliIO } from "./types";

export interface OpenFlags {
  root?: string;
  provider?: string;
  model?: string;
  allowRemote?: boolean;
}

export type OpenExtra = Pick<LocalEngineOptions, "readonly" | "watch" | "vectorPhase"> & {
  preferDaemon?: boolean;
};

export function resolveRoot(io: CliIO, flags: Pick<OpenFlags, "root">): string {
  return flags.root ? resolve(io.cwd, flags.root) : findProjectRoot(io.cwd);
}

export async function openForCli(
  io: CliIO,
  flags: OpenFlags,
  extra: OpenExtra = {},
): Promise<{ root: string; opened: OpenedEngine }> {
  const root = resolveRoot(io, flags);
  const cli: Partial<EffectiveSettings> = {};
  if (flags.provider) cli.provider = flags.provider;
  if (flags.model) cli.model = flags.model;
  if (flags.allowRemote) cli.allowRemote = true;

  const settings: EngineSettings = {};
  if (flags.provider) settings.embedding = { provider: flags.provider };
  if (flags.model) settings.model = { id: flags.model };
  if (flags.allowRemote) settings.allowRemote = true;

  const opened = await openEngine({
    root,
    clientName: "cli",
    cli,
    settings: Object.keys(settings).length > 0 ? settings : undefined,
    ...extra,
  });
  return { root, opened };
}
