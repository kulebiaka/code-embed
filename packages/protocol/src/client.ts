import type { MessageConnection } from "vscode-jsonrpc";
import type { Disposable, EngineApi } from "./rpc";

export function createEngineProxy(_conn: MessageConnection): EngineApi {
  throw new Error("not implemented: client.createEngineProxy");
}

export function registerEngineHandlers(_conn: MessageConnection, _api: EngineApi): Disposable {
  throw new Error("not implemented: client.registerEngineHandlers");
}
