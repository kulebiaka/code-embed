import { describe, expect, it } from "vitest";
import { isOnBattery, parsePmset, parseWindowsBattery } from "./power";

describe("power", () => {
  it("parses pmset output", () => {
    expect(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0")).toBe(true);
    expect(parsePmset("Now drawing from 'AC Power'")).toBe(false);
  });
  it("parses windows status", () => {
    expect(parseWindowsBattery("1\r\n")).toBe(true);
    expect(parseWindowsBattery("2\r\n")).toBe(false);
  });
  it("uses exec per platform and treats errors as AC", async () => {
    expect(await isOnBattery("darwin", async () => "Now drawing from 'Battery Power'")).toBe(true);
    expect(await isOnBattery("win32", async () => "2")).toBe(false);
    expect(
      await isOnBattery("darwin", async () => {
        throw new Error("no pmset");
      }),
    ).toBe(false);
  });
});
