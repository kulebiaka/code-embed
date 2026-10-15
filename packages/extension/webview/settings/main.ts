import type { HostToSettings, SettingsToHost } from "../../src/settings-page/messages";
import { createSettingsApp } from "./app";

declare function acquireVsCodeApi(): { postMessage(msg: SettingsToHost): void };

const api = acquireVsCodeApi();
const app = createSettingsApp(document.getElementById("app") as HTMLElement, api);
window.addEventListener("message", (e: MessageEvent<HostToSettings>) => app.handle(e.data));
api.postMessage({ type: "ready" });
