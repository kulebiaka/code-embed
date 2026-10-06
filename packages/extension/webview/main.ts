import type { HostToWebview, WebviewToHost } from "../src/panel/messages";
import { createApp } from "./app";

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void };

const api = acquireVsCodeApi();
const app = createApp(document.getElementById("app") as HTMLElement, api);
window.addEventListener("message", (e: MessageEvent<HostToWebview>) => app.handle(e.data));
api.postMessage({ type: "ready" });
