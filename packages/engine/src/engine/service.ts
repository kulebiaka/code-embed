import pkg from "../../package.json";
import type { LocalEngine, LocalEngineOptions } from "./types";

export const SERVER_VERSION: string = pkg.version;

export function createLocalEngine(_opts: LocalEngineOptions): Promise<LocalEngine> {
  throw new Error("not implemented: engine/service.createLocalEngine");
}
