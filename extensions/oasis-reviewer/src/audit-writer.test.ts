import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUDIT_QUEUE_MAX_ROWS, createAuditWriter } from "./audit-writer.js";

// T2 (training-data review 2026-11-07): the audit write used to swallow every
// error ("best-effort"), so a full disk or a read-only volume left gaps in the
// decider training data that nothing could count. These tests pin the new
// contract: count, log, queue, and write the gap into the file on recovery.

const SECRET = "SENTINEL-ROW-CONTENT-91c2";

let tmpDir: string;
let file: string;
let logs: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-reviewer-audit-writer-"));
  file = path.join(tmpDir, "reviewer-audit.jsonl");
  logs = [];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function lines(): string[] {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

function rows(): Record<string, unknown>[] {
  return lines().map((l) => JSON.parse(l));
}

/** An append that fails while `failing` is true, then writes to the real file. */
function flakyAppend() {
  const state = { failing: true, calls: 0 };
  const append = (f: string, d: string) => {
    state.calls++;
    if (state.failing) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    fs.appendFileSync(f, d);
  };
  return { state, append };
}

describe("audit writer", () => {
  it("writes one JSON line per row when the disk is healthy", () => {
    const w = createAuditWriter(file, (m) => logs.push(m));
    w.write({ phase: "a", n: 1 });
    w.write({ phase: "b", n: 2 });
    expect(rows()).toEqual([
      { phase: "a", n: 1 },
      { phase: "b", n: 2 },
    ]);
    expect(logs).toEqual([]);
    expect(w.stats()).toEqual({ failedWrites: 0, lostRows: 0, serializeFailures: 0, queued: 0 });
  });

  it("counts and logs a failed write, keeps the row, and writes the gap first on recovery", () => {
    const { state, append } = flakyAppend();
    const w = createAuditWriter(file, (m) => logs.push(m), { append });
    w.write({ phase: "before_tool_call", n: 1, params: SECRET });
    w.write({ phase: "before_tool_call", n: 2, params: SECRET });
    expect(w.stats()).toMatchObject({ failedWrites: 2, queued: 2, lostRows: 0 });
    expect(logs).toHaveLength(1); // first failure of the outage only
    expect(logs[0]).toContain("audit write failed (ENOSPC)");
    expect(fs.existsSync(file)).toBe(false);

    state.failing = false;
    w.write({ phase: "before_tool_call", n: 3 });
    const r = rows();
    expect(r.map((x) => x.phase)).toEqual(["audit_write_error", "before_tool_call", "before_tool_call", "before_tool_call"]);
    expect(r.slice(1).map((x) => x.n)).toEqual([1, 2, 3]); // original order kept
    expect(r[0]).toMatchObject({ failedWrites: 2, recoveredRows: 3, lostRows: 0, firstError: "ENOSPC", lastError: "ENOSPC", totalFailedWrites: 2 });
    expect(w.stats()).toMatchObject({ failedWrites: 2, queued: 0 });
    expect(logs.at(-1)).toContain("audit write recovered after 2 failed writes");

    // Back to normal: no further gap rows.
    w.write({ phase: "before_tool_call", n: 4 });
    expect(rows().filter((x) => x.phase === "audit_write_error")).toHaveLength(1);
  });

  it("NEGATIVE CONTROL: no log line and no gap row holds row content", () => {
    const { state, append } = flakyAppend();
    const w = createAuditWriter(file, (m) => logs.push(m), { append });
    for (let i = 0; i < 12; i++) w.write({ phase: "decider_shadow", decState: { params: SECRET } });
    state.failing = false;
    w.write({ phase: "x" });
    for (const m of logs) expect(m).not.toContain(SECRET);
    expect(JSON.stringify(rows()[0])).not.toContain(SECRET);
  });

  it("limits log lines during a long outage (1, 10, 100, ...)", () => {
    const { append } = flakyAppend();
    const w = createAuditWriter(file, (m) => logs.push(m), { append });
    for (let i = 0; i < 120; i++) w.write({ phase: "p" });
    expect(logs).toHaveLength(3);
    expect(logs[1]).toContain("failed writes in this outage: 10");
    expect(logs[2]).toContain("failed writes in this outage: 100");
    expect(w.stats().failedWrites).toBe(120);
  });

  it("bounds the queue: drops the OLDEST rows and counts them as lost", () => {
    const { state, append } = flakyAppend();
    const w = createAuditWriter(file, (m) => logs.push(m), { append, queueMax: 3 });
    for (let n = 1; n <= 5; n++) w.write({ phase: "p", n });
    expect(w.stats()).toMatchObject({ queued: 3, lostRows: 2 });
    state.failing = false;
    w.write({ phase: "p", n: 6 });
    const r = rows();
    expect(r[0]).toMatchObject({ phase: "audit_write_error", lostRows: 2, recoveredRows: 4, totalLostRows: 2 });
    // 1 and 2 were lost while failing; the successful recovery write keeps 3.
    expect(r.slice(1).map((x) => x.n)).toEqual([3, 4, 5, 6]);
    expect(AUDIT_QUEUE_MAX_ROWS).toBe(1000);
  });

  it("starts the recovery batch on a new line after a half-written line", () => {
    const { state, append } = flakyAppend();
    const w = createAuditWriter(file, (m) => logs.push(m), { append });
    fs.writeFileSync(file, '{"phase":"ok"}\n{"phase":"half-writ'); // what a failed append can leave
    w.write({ phase: "p", n: 1 });
    state.failing = false;
    w.write({ phase: "p", n: 2 });
    const all = lines();
    expect(all[1]).toBe('{"phase":"half-writ'); // the broken line stays broken and countable
    expect(JSON.parse(all[2]).phase).toBe("audit_write_error");
    expect(all.slice(3).map((l) => JSON.parse(l).n)).toEqual([1, 2]);
  });

  it("writes a stub for a row that cannot be serialized, and counts it", () => {
    const w = createAuditWriter(file, (m) => logs.push(m));
    w.write({ ts: "2026-11-07T00:00:00.000Z", phase: "decider_shadow", bot: "vega", toolCallId: "t1", n: BigInt(1) });
    expect(rows()).toEqual([
      { ts: "2026-11-07T00:00:00.000Z", phase: "decider_shadow", bot: "vega", toolCallId: "t1", auditSerializeError: expect.stringContaining("BigInt") },
    ]);
    expect(w.stats().serializeFailures).toBe(1);
    expect(logs[0]).toContain("not serializable");
  });

  it("works against a real fs failure: the audit path is a directory, then it is fixed", () => {
    fs.mkdirSync(file); // appendFileSync on a directory throws EISDIR
    const w = createAuditWriter(file, (m) => logs.push(m));
    w.write({ phase: "p", n: 1 });
    expect(w.stats()).toMatchObject({ failedWrites: 1, queued: 1 });
    expect(logs[0]).toMatch(/audit write failed \(EISDIR\)/);
    fs.rmdirSync(file);
    w.write({ phase: "p", n: 2 });
    expect(rows().map((x) => x.phase)).toEqual(["audit_write_error", "p", "p"]);
  });

  it("a logger that throws does not break the write path", () => {
    const { state, append } = flakyAppend();
    const w = createAuditWriter(file, () => {
      throw new Error("logger down");
    }, { append });
    expect(() => w.write({ phase: "p" })).not.toThrow();
    state.failing = false;
    expect(() => w.write({ phase: "p" })).not.toThrow();
    expect(rows()).toHaveLength(3);
  });
});
