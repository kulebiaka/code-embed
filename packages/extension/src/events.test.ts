import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cbs: {} as Record<string, (...a: never[]) => void>,
  visible: [] as unknown[],
  focused: true,
}));

vi.mock("vscode", () => {
  const ev = (name: string) => (cb: (...a: never[]) => void) => {
    h.cbs[name] = cb;
    return { dispose: () => undefined };
  };
  return {
    workspace: {
      createFileSystemWatcher: () => ({
        onDidCreate: ev("create"),
        onDidChange: ev("change"),
        onDidDelete: ev("delete"),
        dispose: () => undefined,
      }),
      onDidSaveTextDocument: ev("save"),
    },
    window: {
      get visibleTextEditors() {
        return h.visible;
      },
      activeTextEditor: undefined,
      onDidChangeVisibleTextEditors: ev("visible"),
      onDidChangeActiveTextEditor: ev("active"),
      onDidChangeWindowState: ev("windowState"),
      get state() {
        return { focused: h.focused };
      },
    },
  };
});

import { BACKGROUND_AFTER_MS, registerEditorEvents } from "./events";

const f = (p: string) => ({ scheme: "file", fsPath: p });
const fire = (name: string, ...a: unknown[]) => (h.cbs[name] as unknown as (...x: unknown[]) => void)(...a);

describe("registerEditorEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.visible = [];
    h.focused = true;
  });
  afterEach(() => vi.useRealTimers());

  it("batches file events into one files.changed", () => {
    const client = { filesChanged: vi.fn(), filesOpened: vi.fn(), setActive: vi.fn() };
    registerEditorEvents(client);
    fire("create", f("/a"));
    fire("change", f("/a"));
    fire("change", f("/b"));
    fire("save", { uri: f("/b") });
    fire("delete", f("/c"));
    fire("change", { scheme: "untitled", fsPath: "/u" });
    expect(client.filesChanged).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(client.filesChanged).toHaveBeenCalledTimes(1);
    expect(client.filesChanged).toHaveBeenCalledWith({ created: ["/a"], changed: ["/b"], deleted: ["/c"] });
  });

  it("reports visible editors as opened", () => {
    h.visible = [{ document: { uri: f("/x") } }, { document: { uri: { scheme: "output", fsPath: "/o" } } }];
    const client = { filesChanged: vi.fn(), filesOpened: vi.fn(), setActive: vi.fn() };
    registerEditorEvents(client);
    expect(client.filesOpened).toHaveBeenCalledWith({ paths: ["/x"] });
  });

  it("reports the window as background only after it stays unfocused", () => {
    h.focused = false;
    const client = { filesChanged: vi.fn(), filesOpened: vi.fn(), setActive: vi.fn() };
    registerEditorEvents(client);
    expect(client.setActive).toHaveBeenLastCalledWith({ active: false });
    fire("windowState", { focused: true });
    expect(client.setActive).toHaveBeenLastCalledWith({ active: true });
    fire("windowState", { focused: false });
    vi.advanceTimersByTime(BACKGROUND_AFTER_MS - 1);
    fire("windowState", { focused: true });
    vi.advanceTimersByTime(BACKGROUND_AFTER_MS);
    expect(client.setActive).toHaveBeenLastCalledWith({ active: true });
    fire("windowState", { focused: false });
    vi.advanceTimersByTime(BACKGROUND_AFTER_MS);
    expect(client.setActive).toHaveBeenLastCalledWith({ active: false });
  });
});
