import type { EngineSettings } from "@code-embed/protocol";
import * as vscode from "vscode";

export const SECTION = "codeEmbed";

function excludeGlobs(value: Record<string, boolean> | undefined): string[] {
  return Object.entries(value ?? {})
    .filter(([, on]) => on === true)
    .map(([glob]) => glob);
}

export function readEngineSettings(): EngineSettings {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const get = <T>(key: string): T | undefined => cfg.get<T>(key);
  const nonEmpty = (v: string | undefined): string | undefined => (v ? v : undefined);

  const exclude = [
    ...excludeGlobs(vscode.workspace.getConfiguration("files").get<Record<string, boolean>>("exclude")),
    ...excludeGlobs(vscode.workspace.getConfiguration("search").get<Record<string, boolean>>("exclude")),
  ];
  const providers = get<NonNullable<EngineSettings["providers"]>>("providers");

  const settings: EngineSettings = {
    index: {
      location: get("index.location"),
      maxFileKb: get("index.maxFileKb"),
      threads: get("index.threads"),
      pauseOnBattery: get("index.pauseOnBattery"),
      exclude: [...new Set(exclude)],
    },
    search: { defaultMode: get("search.defaultMode"), top: get("search.top") },
    model: { id: nonEmpty(get("model.id")), offlineArchive: nonEmpty(get("model.offlineArchive")) },
    embedding: { provider: get("embedding.provider") },
    providers: providers && Object.keys(providers).length > 0 ? providers : undefined,
    proxy: nonEmpty(vscode.workspace.getConfiguration("http").get<string>("proxy")),
  };
  return JSON.parse(JSON.stringify(settings)) as EngineSettings;
}

export function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders as readonly vscode.WorkspaceFolder[] | undefined;
  return folders?.[0]?.uri.fsPath;
}
