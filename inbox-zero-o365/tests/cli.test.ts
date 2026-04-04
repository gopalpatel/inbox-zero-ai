import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DATA_DIR, resolveDataDir } from "../src/cli.js";

const ORIGINAL_DATA_DIR = process.env["DATA_DIR"];

afterEach(() => {
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env["DATA_DIR"];
  } else {
    process.env["DATA_DIR"] = ORIGINAL_DATA_DIR;
  }
});

describe("cli helpers", () => {
  it("uses DATA_DIR when provided", () => {
    process.env["DATA_DIR"] = "/tmp/inbox-zero-o365-data";

    expect(resolveDataDir()).toBe("/tmp/inbox-zero-o365-data");
  });

  it("falls back to the default data directory", () => {
    delete process.env["DATA_DIR"];

    expect(resolveDataDir()).toBe(DEFAULT_DATA_DIR);
  });

  it("treats blank DATA_DIR as unset", () => {
    process.env["DATA_DIR"] = "   ";

    expect(resolveDataDir()).toBe(DEFAULT_DATA_DIR);
  });
});
