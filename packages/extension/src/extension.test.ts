import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

const calls: string[] = [];
const supervisor = {
  client: { name: "client" },
  start: vi.fn(async () => {
    calls.push("start");
  }),
  restart: vi.fn(),
  showLog: vi.fn(),
  dispose: vi.fn(),
};
const panel = { name: "panel" };

vi.mock("./engine/supervisor", () => ({
  createEngineSupervisor: vi.fn(() => {
    calls.push("supervisor");
    return supervisor;
  }),
}));
vi.mock("./panel", () => ({
  registerPanel: vi.fn(() => {
    calls.push("panel");
    return panel;
  }),
}));
vi.mock("./statusbar", () => ({ registerStatusBar: vi.fn(() => calls.push("statusbar")) }));
vi.mock("./commands", () => ({ registerCommands: vi.fn(() => calls.push("commands")) }));
vi.mock("./agent", () => ({
  registerAgentTools: vi.fn(() => calls.push("tools")),
  registerMcpProvider: vi.fn(() => calls.push("mcp")),
}));

const { activate, deactivate } = await import("./extension");
const { registerCommands } = await import("./commands");
const { registerAgentTools } = await import("./agent");

describe("extension wiring", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("activates all parts and starts the engine without awaiting", () => {
    const output = { appendLine: vi.fn(), dispose: vi.fn() };
    vi.spyOn(vscode.window, "createOutputChannel").mockReturnValue(output as never);
    const ctx = { subscriptions: [] as unknown[] };

    activate(ctx as never);

    expect(vscode.window.createOutputChannel).toHaveBeenCalledWith("Code Embed");
    expect(calls).toEqual(["supervisor", "panel", "statusbar", "commands", "tools", "mcp", "start"]);
    expect(registerCommands).toHaveBeenCalledWith(ctx, { client: supervisor.client, panel, supervisor, output });
    expect(registerAgentTools).toHaveBeenCalledWith(ctx, supervisor.client);
    expect(ctx.subscriptions).toContain(output);

    deactivate();
    expect(supervisor.dispose).toHaveBeenCalledOnce();
  });
});
