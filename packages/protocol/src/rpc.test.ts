import { describe, expect, it } from "vitest";
import { EngineRpcError, ErrorCodes, Methods, Notifications, PROTOCOL_VERSION } from "./rpc";

describe("rpc contract", () => {
  it("has an integer protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
  });

  it("fixes error codes", () => {
    expect(ErrorCodes).toEqual({
      ProtocolMismatch: -32001,
      NoIndex: -32002,
      ConsentRequired: -32003,
      ProviderUnavailable: -32004,
      ReadOnly: -32005,
      RequestCancelled: -32800,
    });
  });

  it("fixes request method names", () => {
    expect(Methods).toEqual({
      initialize: "initialize",
      search: "search",
      findSimilar: "findSimilar",
      indexStatus: "index.status",
      indexRebuild: "index.rebuild",
      indexPause: "index.pause",
      indexResume: "index.resume",
      settingsUpdate: "settings.update",
      shutdown: "shutdown",
      providerTest: "provider.test",
      providerList: "provider.list",
      modelList: "model.list",
      consentGrant: "consent.grant",
    });
  });

  it("fixes notification names", () => {
    expect(Notifications).toEqual({
      filesChanged: "files.changed",
      filesOpened: "files.opened",
      indexProgress: "index.progress",
      indexError: "index.error",
      log: "log",
    });
  });

  it("method and notification names are unique", () => {
    const names = [...Object.values(Methods), ...Object.values(Notifications)];
    expect(new Set(names).size).toBe(names.length);
  });

  it("EngineRpcError carries code and data", () => {
    const e = new EngineRpcError(ErrorCodes.ConsentRequired, "consent", { host: "api.example.com", provider: "x" });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe(-32003);
    expect(e.message).toBe("consent");
    expect(e.data).toEqual({ host: "api.example.com", provider: "x" });
  });
});
