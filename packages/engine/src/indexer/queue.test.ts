import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { orderPaths, toStorePath } from "./queue";

describe("orderPaths", () => {
  it("opened, then recent, then by depth", () => {
    const all = ["a/b/c.ts", "z.ts", "a/x.ts", "m/n/o/p.ts", "b.ts", "r.ts"];
    expect(orderPaths(all, ["m/n/o/p.ts", "missing.ts"], ["r.ts", "m/n/o/p.ts", "a/b/c.ts"])).toEqual([
      "m/n/o/p.ts",
      "r.ts",
      "a/b/c.ts",
      "b.ts",
      "z.ts",
      "a/x.ts",
    ]);
  });
});

describe("toStorePath", () => {
  it("relativizes paths under root", () => {
    const root = join("/", "tmp", "proj");
    expect(toStorePath(root, join(root, "src", "a.ts"))).toBe("src/a.ts");
    expect(toStorePath(root, "src/a.ts")).toBe("src/a.ts");
    expect(toStorePath(root, join("/", "other", "a.ts"))).toBe(join("/", "other", "a.ts"));
  });
});
