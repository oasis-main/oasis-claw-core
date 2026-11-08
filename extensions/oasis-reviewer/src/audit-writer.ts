import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";

// ── Audit writer that does not lose rows silently (T2, training-data review
// 2026-11-07) ──────────────────────────────────────────────────────────────
// reviewer-audit.jsonl is the label source for the decision-model fine-tune.
// The old writer was `try { appendFileSync(...) } catch { /* best-effort */ }`:
// a full disk, a read-only volume or a permission change dropped every row and
// left no trace, so the training data had gaps that nothing could count.
//
// Now:
//   - each failed write increments a counter and logs a line (the first
//     failure of an outage, then at 10, 100, 1000 ... failures, so a dead disk
//     cannot flood the container log);
//   - the row is kept in a bounded in-memory queue and written on the next
//     write that succeeds, in its original order;
//   - when the queue is full, the OLDEST row is dropped and counted as lost;
//   - after an outage, one phase:"audit_write_error" row goes first, with the
//     counts, so the audit file itself records the gap and its size.
// No log line and no gap row holds row content: only counts, phases and the
// fs error message.
//
// Rows that cannot be serialized (a BigInt, a cycle) are written as a stub
// with phase, bot, toolCallId and the error, and are counted, not dropped.

export const AUDIT_QUEUE_MAX_ROWS = 1000;

export interface AuditWriterStats {
  /** Failed append calls since start. */
  failedWrites: number;
  /** Rows dropped since start because the queue was full. */
  lostRows: number;
  /** Rows that could not be serialized and were written as a stub. */
  serializeFailures: number;
  /** Rows waiting in the queue now. */
  queued: number;
}

export interface AuditWriter {
  write(row: Record<string, unknown>): void;
  stats(): AuditWriterStats;
}

export type AuditLog = (message: string) => void;

interface Outage {
  failedWrites: number;
  lostRows: number;
  firstError: string;
  firstErrorAt: string;
  lastError: string;
  lastErrorAt: string;
}

function errorText(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return String(e?.code ?? e?.message ?? err).slice(0, 200);
}

/** True when the file is missing, empty, or its last byte is "\n". */
function endsWithNewline(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, size - 1);
    return b[0] === 0x0a;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/** 1, 10, 100, 1000, ... */
function shouldLog(n: number): boolean {
  return /^10*$/.test(String(n));
}

export function createAuditWriter(
  file: string,
  log: AuditLog,
  opts: { queueMax?: number; append?: (file: string, data: string) => void } = {},
): AuditWriter {
  const queueMax = Math.max(1, opts.queueMax ?? AUDIT_QUEUE_MAX_ROWS);
  const append = opts.append ?? ((f: string, d: string) => appendFileSync(f, d));
  const queue: string[] = [];
  const totals = { failedWrites: 0, lostRows: 0, serializeFailures: 0 };
  let outage: Outage | null = null;

  const serialize = (row: Record<string, unknown>): string => {
    try {
      return JSON.stringify(row);
    } catch (err) {
      totals.serializeFailures++;
      const msg = errorText(err);
      safeLog(`oasis-reviewer: audit row not serializable (phase=${String(row.phase ?? "?")}, total=${totals.serializeFailures}): ${msg}`);
      return JSON.stringify({
        ts: typeof row.ts === "string" ? row.ts : new Date().toISOString(),
        phase: typeof row.phase === "string" ? row.phase : null,
        bot: typeof row.bot === "string" ? row.bot : null,
        toolCallId: typeof row.toolCallId === "string" ? row.toolCallId : null,
        auditSerializeError: msg,
      });
    }
  };

  function safeLog(message: string): void {
    try {
      log(message);
    } catch {
      /* a broken logger must not break the hook */
    }
  }

  const write = (row: Record<string, unknown>): void => {
    const line = serialize(row);
    if (!outage && queue.length === 0) {
      try {
        append(file, line + "\n");
        return;
      } catch (err) {
        enqueue(line);
        recordFailure(err);
        return;
      }
    }
    // Recovery attempt: gap row, then the queue, then this row, in one append.
    // This row joins the queue only if the attempt fails, so a successful
    // recovery never pushes a queued row out.
    const o = outage!;
    const recoveredRows = queue.length + 1;
    const gap = JSON.stringify({
      ts: new Date().toISOString(),
      phase: "audit_write_error",
      failedWrites: o.failedWrites,
      recoveredRows,
      lostRows: o.lostRows,
      firstError: o.firstError,
      firstErrorAt: o.firstErrorAt,
      lastError: o.lastError,
      lastErrorAt: o.lastErrorAt,
      totalFailedWrites: totals.failedWrites,
      totalLostRows: totals.lostRows,
    });
    // A failed append can leave half a line behind. Start the batch on a new
    // line so that the gap row is not glued to it.
    const lead = endsWithNewline(file) ? "" : "\n";
    try {
      append(file, lead + [gap, ...queue, line].join("\n") + "\n");
    } catch (err) {
      enqueue(line);
      recordFailure(err);
      return;
    }
    safeLog(
      `oasis-reviewer: audit write recovered after ${o.failedWrites} failed writes: ${recoveredRows} rows written, ${o.lostRows} rows lost`,
    );
    queue.length = 0;
    outage = null;
  };

  function recordFailure(err: unknown): void {
    const msg = errorText(err);
    const at = new Date().toISOString();
    totals.failedWrites++;
    if (!outage) outage = { failedWrites: 0, lostRows: 0, firstError: msg, firstErrorAt: at, lastError: msg, lastErrorAt: at };
    outage.failedWrites++;
    outage.lastError = msg;
    outage.lastErrorAt = at;
    if (shouldLog(outage.failedWrites)) {
      safeLog(
        `oasis-reviewer: audit write failed (${msg}); failed writes in this outage: ${outage.failedWrites}, since start: ${totals.failedWrites}; rows queued: ${queue.length}, lost: ${outage.lostRows}`,
      );
    }
  }

  function enqueue(line: string): void {
    if (queue.length >= queueMax) {
      queue.shift();
      totals.lostRows++;
      if (outage) outage.lostRows++;
    }
    queue.push(line);
  }

  return {
    write,
    stats: () => ({ ...totals, queued: queue.length }),
  };
}
