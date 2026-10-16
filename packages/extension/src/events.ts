import type { Disposable, EngineApi } from "@code-embed/protocol";
import * as vscode from "vscode";

const BATCH_MS = 300;
// Short trips to another window keep this one active.
export const BACKGROUND_AFTER_MS = 30_000;

type Sink = Pick<EngineApi, "filesChanged" | "filesOpened" | "setActive">;

function filePath(uri: vscode.Uri): string | undefined {
  return uri.scheme === "file" ? uri.fsPath : undefined;
}

export function registerEditorEvents(client: Sink): Disposable {
  let created = new Set<string>();
  let changed = new Set<string>();
  let deleted = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    if (created.size + changed.size + deleted.size === 0) return;
    const params = { created: [...created], changed: [...changed], deleted: [...deleted] };
    created = new Set();
    changed = new Set();
    deleted = new Set();
    client.filesChanged(params);
  };
  const schedule = () => {
    timer ??= setTimeout(flush, BATCH_MS);
  };

  const onCreate = (uri: vscode.Uri) => {
    const p = filePath(uri);
    if (!p) return;
    deleted.delete(p);
    created.add(p);
    schedule();
  };
  const onChange = (uri: vscode.Uri) => {
    const p = filePath(uri);
    if (!p) return;
    if (!created.has(p)) changed.add(p);
    schedule();
  };
  const onDelete = (uri: vscode.Uri) => {
    const p = filePath(uri);
    if (!p) return;
    created.delete(p);
    changed.delete(p);
    deleted.add(p);
    schedule();
  };

  const sendOpened = () => {
    const paths = new Set<string>();
    for (const ed of vscode.window.visibleTextEditors) {
      const p = filePath(ed.document.uri);
      if (p) paths.add(p);
    }
    const active = vscode.window.activeTextEditor;
    const ap = active && filePath(active.document.uri);
    if (ap) paths.add(ap);
    if (paths.size > 0) client.filesOpened({ paths: [...paths] });
  };

  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  const onWindowState = (state: vscode.WindowState) => {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = undefined;
    if (state.focused) client.setActive({ active: true });
    else blurTimer = setTimeout(() => client.setActive({ active: false }), BACKGROUND_AFTER_MS);
  };

  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const subs: Disposable[] = [
    watcher,
    watcher.onDidCreate(onCreate),
    watcher.onDidChange(onChange),
    watcher.onDidDelete(onDelete),
    vscode.workspace.onDidSaveTextDocument((doc) => onChange(doc.uri)),
    vscode.window.onDidChangeVisibleTextEditors(sendOpened),
    vscode.window.onDidChangeActiveTextEditor(sendOpened),
    vscode.window.onDidChangeWindowState(onWindowState),
  ];
  sendOpened();
  client.setActive({ active: vscode.window.state.focused });

  return {
    dispose: () => {
      if (timer) clearTimeout(timer);
      if (blurTimer) clearTimeout(blurTimer);
      subs.forEach((s) => s.dispose());
    },
  };
}
