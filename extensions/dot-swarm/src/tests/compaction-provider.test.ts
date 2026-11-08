import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestMessages, readLatestHandoff } from "../compaction-provider.js";

let tmpDir: string;
let stateMdPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-dotswarm-compaction-test-"));
  stateMdPath = path.join(tmpDir, "state.md");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readLatestHandoff — no botKey configured (default, pre-fix-equivalent behavior)
// ---------------------------------------------------------------------------

describe("readLatestHandoff — no botKey", () => {
  it("returns null even when the file has real, tagged handoff sections", () => {
    fs.writeFileSync(
      stateMdPath,
      ["", "---", "", "## Handoff Note — vega: 2026-08-13", "", "*Compacted at ...*", "", "some body", ""].join(
        "\n",
      ),
      "utf8",
    );
    expect(readLatestHandoff(stateMdPath)).toBeNull();
    expect(readLatestHandoff(stateMdPath, {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readLatestHandoff — botKey configured
// ---------------------------------------------------------------------------

describe("readLatestHandoff — botKey configured", () => {
  it("matches a plain, untagged, hand-written header for its own botKey only if tagged", () => {
    // Real fleet data (oasis-swarm/state.md) uses plain "## Handoff Note" with
    // no em dash and no tag. Those predate bot-scoped tagging entirely, so a
    // botKey-scoped read correctly does NOT match them — they belong to no bot.
    fs.writeFileSync(
      stateMdPath,
      ["", "---", "", "## Handoff Note", "", "*Compacted at ...*", "", "untagged legacy body", ""].join("\n"),
      "utf8",
    );
    expect(readLatestHandoff(stateMdPath, { botKey: "vega" })).toBeNull();
  });

  it("matches a section tagged for the given botKey, ignoring other bots' sections", () => {
    fs.writeFileSync(
      stateMdPath,
      [
        "",
        "---",
        "",
        "## Handoff Note — rigel: compact-2026-08-13T00:00:00.000Z",
        "",
        "*Compacted at 2026-08-13T00:00:00.000Z via the dot-swarm `compact` tool.*",
        "",
        "rigel's note, should never be read by vega",
        "",
        "---",
        "",
        "## Handoff Note — vega: compact-2026-08-13T01:00:00.000Z",
        "",
        "*Compacted at 2026-08-13T01:00:00.000Z via the dot-swarm `compact` tool.*",
        "",
        "vega's own note",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = readLatestHandoff(stateMdPath, { botKey: "vega" });
    expect(result).toContain("vega's own note");
    expect(result).not.toContain("rigel's note");
  });

  it("returns the LAST matching section for that botKey when there are several", () => {
    fs.writeFileSync(
      stateMdPath,
      [
        "",
        "---",
        "",
        "## Handoff Note — vega: first",
        "",
        "*Compacted at t1*",
        "",
        "older vega note",
        "",
        "---",
        "",
        "## Handoff Note — vega: second",
        "",
        "*Compacted at t2*",
        "",
        "newer vega note",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = readLatestHandoff(stateMdPath, { botKey: "vega" });
    expect(result).toContain("newer vega note");
    expect(result).not.toContain("older vega note");
  });

  it("returns null when the file doesn't exist", () => {
    expect(readLatestHandoff(path.join(tmpDir, "missing.md"), { botKey: "vega" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// digestMessages — unchanged fallback, sanity check
// ---------------------------------------------------------------------------

describe("digestMessages", () => {
  it("digests a simple user/assistant message array", () => {
    const digest = digestMessages([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    expect(digest).toContain("**User**: hello");
    expect(digest).toContain("**Agent**: hi there");
  });
});
