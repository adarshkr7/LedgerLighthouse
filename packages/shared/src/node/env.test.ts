import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadDotEnv, optional, required } from "./env.js";

const TOUCHED = [
  "T_BLANK_WITH_COMMENT",
  "T_BLANK_BARE",
  "T_VALUE",
  "T_VALUE_WITH_COMMENT",
  "T_QUOTED_HASH",
  "T_HASH_NO_SPACE",
];

function writeEnv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ll-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key];
});

describe("loadDotEnv", () => {
  /*
   * The case that matters: every blank line in .env.example is written as
   * `KEY=<padding># explanation`. Read as a value, that prose reaches
   * requiredHexKey and friends, and the operator is told their deliberately
   * blank key is malformed rather than missing.
   */
  it("treats a value that is only a comment as empty", () => {
    loadDotEnv(
      writeEnv(
        [
          "T_BLANK_WITH_COMMENT=           # explanation of the thing",
          "T_BLANK_BARE=",
        ].join("\n"),
      ),
    );

    expect(optional("T_BLANK_WITH_COMMENT")).toBeUndefined();
    expect(optional("T_BLANK_BARE")).toBeUndefined();
  });

  it("reports a comment-only value as missing, not as malformed", () => {
    loadDotEnv(writeEnv("T_BLANK_WITH_COMMENT=      # gas only"));

    expect(() => required("T_BLANK_WITH_COMMENT")).toThrow(/Missing T_BLANK_WITH_COMMENT/);
  });

  it("still strips a trailing inline comment from a real value", () => {
    loadDotEnv(
      writeEnv(
        ["T_VALUE=plain", "T_VALUE_WITH_COMMENT=84532        # never infer it"].join("\n"),
      ),
    );

    expect(optional("T_VALUE")).toBe("plain");
    expect(optional("T_VALUE_WITH_COMMENT")).toBe("84532");
  });

  it("keeps a hash that is part of the value", () => {
    loadDotEnv(
      writeEnv(
        [
          `T_QUOTED_HASH="https://example.test/rpc#frag"`,
          "T_HASH_NO_SPACE=https://example.test/rpc#frag",
        ].join("\n"),
      ),
    );

    // Quoted: protected explicitly.
    expect(optional("T_QUOTED_HASH")).toBe("https://example.test/rpc#frag");
    // Unquoted with no preceding whitespace: not a comment either, since the
    // split requires whitespace before the `#`.
    expect(optional("T_HASH_NO_SPACE")).toBe("https://example.test/rpc#frag");
  });
});
