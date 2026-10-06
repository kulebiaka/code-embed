// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

describe("webview test environment", () => {
  it("provides a DOM", () => {
    const el = document.createElement("div");
    el.textContent = "ok";
    document.body.append(el);
    expect(document.body.textContent).toBe("ok");
  });
});
