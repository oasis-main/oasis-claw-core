import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  decide,
  DEFAULT_DECIDER_TIMEOUT_MS,
  deciderModeFrom,
  deciderTimeoutFrom,
  injectionState,
  inputDigest,
  INJECTION_QUESTIONS,
  summarize,
  toolCallState,
  TOOL_CALL_QUESTIONS,
} from "./decider.js";

// CLAW-118: the decider is SHADOW-only. These tests pin the two properties the
// shadow depends on: the client never throws (a dead sidecar costs a log row,
// never a tool call), and the questions stay inside Laya's limits.

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  return new Promise((r) => server!.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`)));
}

describe("deciderModeFrom", () => {
  it("is off unless explicitly shadow", () => {
    expect(deciderModeFrom(undefined)).toBe("off");
    expect(deciderModeFrom("enforce")).toBe("off"); // no enforce mode exists
    expect(deciderModeFrom("SHADOW")).toBe("shadow");
  });
});

// T6 (training-data review 2026-11-07): one timeout value. The code default
// was 8,000 ms while compose set 60,000 ms.
describe("deciderTimeoutFrom", () => {
  it("has one default, equal to the value both compose files set", () => {
    expect(DEFAULT_DECIDER_TIMEOUT_MS).toBe(60_000);
    expect(deciderTimeoutFrom(undefined)).toBe(60_000);
    expect(deciderTimeoutFrom("")).toBe(60_000);
  });

  it("takes a positive number of ms from the env value", () => {
    expect(deciderTimeoutFrom("1500")).toBe(1500);
    expect(deciderTimeoutFrom("2500.7")).toBe(2500);
  });

  it("NEGATIVE CONTROL: zero, negative and junk values fall back, never pass through", () => {
    // The old `Number(x) || 8000` let "-5" through as a -5 ms timeout.
    for (const raw of ["0", "-5", "abc", "Infinity", "NaN"]) expect(deciderTimeoutFrom(raw)).toBe(60_000);
  });
});

// T4: digests of the untruncated inputs.
describe("inputDigest", () => {
  it("is the sha256 and length of the full text", () => {
    const text = "x".repeat(10_000);
    expect(inputDigest(text)).toEqual({ sha256: createHash("sha256").update(text).digest("hex"), chars: 10_000 });
    expect(inputDigest("").chars).toBe(0);
  });
});

describe("question schemas", () => {
  for (const [name, qs] of Object.entries({ TOOL_CALL_QUESTIONS, INJECTION_QUESTIONS })) {
    it(`${name} stays inside the sidecar's limits`, () => {
      const entries = Object.entries(qs);
      expect(entries.length).toBeLessThanOrEqual(8);
      expect(qs.verdict.type).toBe("choice");
      for (const [, q] of entries) {
        expect(q.instructions.length).toBeGreaterThan(0);
        if (q.type === "choice") expect(Object.keys(q.criteria as object).length).toBeLessThanOrEqual(20);
        if (q.type === "score") expect((q.criteria as string[]).length).toBeGreaterThanOrEqual(2);
      }
    });
  }

  it("tool-call verdict options mirror Layer 2", () => {
    expect(Object.keys(TOOL_CALL_QUESTIONS.verdict.criteria as object).sort()).toEqual(["allow", "deny", "escalate"]);
  });
});

describe("state builders", () => {
  it("clips long fields so the state fits the 1024-token context", () => {
    const s = toolCallState({
      botKey: "vega",
      toolName: "exec",
      family: "exec",
      subject: "x".repeat(5000),
      params: "p".repeat(50_000),
      operatorRequest: "r".repeat(50_000),
    });
    expect(JSON.stringify(s).length).toBeLessThan(3000);
    expect(s.params.endsWith("…")).toBe(true);
  });

  it("records which fields the limits cut, without changing the limits (T4)", () => {
    const clipped: string[] = [];
    const s = toolCallState(
      { botKey: "b", toolName: "t", family: "f", subject: "s".repeat(301), params: "p".repeat(1501), operatorRequest: "r".repeat(800) },
      clipped,
    );
    expect(clipped).toEqual(["target", "params"]); // request is exactly at its 800-char limit
    expect(s.target.length).toBe(301); // 300 + "…"
    expect(s.params.length).toBe(1501); // 1500 + "…"
    expect(s.operator_request.length).toBe(800);

    const inj: string[] = [];
    injectionState({ botKey: "b", incidentType: "i", detail: "d".repeat(1001), suspiciousContent: "ok", operatorRequest: "r".repeat(801) }, inj);
    expect(inj).toEqual(["detail", "operator_request"]);

    // Without the array the builders behave exactly as before.
    expect(toolCallState({ botKey: "b", toolName: "t", family: "f", subject: "", params: "p".repeat(1501) }).params.length).toBe(1501);
  });

  it("marks missing operator context explicitly", () => {
    expect(toolCallState({ botKey: "b", toolName: "t", family: "f", subject: "", params: "" }).operator_request).toBe(
      "(none captured)",
    );
    expect(injectionState({ botKey: "b", incidentType: "i", detail: "", suspiciousContent: "" }).detail).toBe("(none)");
  });
});

describe("decide", () => {
  it("round-trips answers and never routes through a proxy env", async () => {
    process.env.HTTP_PROXY = "http://127.0.0.1:9"; // would fail if honoured
    try {
      let seen: unknown;
      const url = await serve((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
          seen = JSON.parse(b);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ answers: { verdict: { type: "choice", choice: "allow", probabilities: { allow: 0.9 } } }, ms: 40, model: "m", revision: "r" }));
        });
      });
      const r = await decide(url, { bot: "b" }, TOOL_CALL_QUESTIONS, 2000);
      expect(r.error).toBeUndefined();
      expect(r.timeoutMs).toBe(2000);
      expect(r.answers?.verdict.choice).toBe("allow");
      expect(r.modelMs).toBe(40);
      expect((seen as { questions: object }).questions).toEqual(TOOL_CALL_QUESTIONS);
    } finally {
      delete process.env.HTTP_PROXY;
    }
  });

  it("reports a non-200 as an error, not answers", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "questions must be a non-empty object" }));
    });
    const r = await decide(url, {}, {}, 2000);
    expect(r.answers).toBeNull();
    expect(r.error).toContain("HTTP 400");
  });

  it("times out without throwing and says so", async () => {
    const url = await serve(() => {
      /* never answers */
    });
    const r = await decide(url, { bot: "b" }, TOOL_CALL_QUESTIONS, 100);
    expect(r.answers).toBeNull();
    expect(r.timedOut).toBe(true);
    expect(r.timeoutMs).toBe(100);
  });

  it("survives an unreachable sidecar and a bad url", async () => {
    const dead = await decide("http://127.0.0.1:1", { bot: "b" }, TOOL_CALL_QUESTIONS, 1000);
    expect(dead.answers).toBeNull();
    expect(dead.error).toBeTruthy();
    const bad = await decide("not a url", { bot: "b" }, TOOL_CALL_QUESTIONS, 1000);
    expect(bad.error).toContain("bad decider url");
    expect(dead.timeoutMs).toBe(1000);
    expect(bad.timeoutMs).toBe(1000);
  });
});

describe("summarize", () => {
  it("flattens the verdict and one number per other question", () => {
    const s = summarize({
      verdict: { type: "choice", choice: "escalate", probabilities: { allow: 0.2, deny: 0.1, escalate: 0.7 }, answer_confidence: 0.66 },
      beyond_request: { type: "noul", noul: 0.81 },
      risk: { type: "score", score: 2.1 },
    });
    expect(s).toMatchObject({ decVerdict: "escalate", decVerdictP: 0.7, decVerdictConfidence: 0.66, dec_beyond_request: 0.81, dec_risk: 2.1 });
  });

  it("null answers give a null verdict", () => {
    expect(summarize(null)).toEqual({ decVerdict: null });
  });
});
