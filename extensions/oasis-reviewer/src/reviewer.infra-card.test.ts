import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerReviewer } from "./reviewer.js";

// ── CLAW-116 infra approval card + trusted ledger context (2026-09-22) ───────
// the operator: "Have the autoreviewer be primed for these sorts of calls to come from
// Rigel, and reply NEEDS THE OPERATOR with an approval card if I am needed in the
// loop." Two live failures on 2026-09-22 drove this:
//   1. A covered `terraform apply -input=false a.tfplan` (Layer 1:
//      hard:infra-ledger-match) was DENIED twice by Layer 2, which tried to
//      confirm coverage from the trajectory and saw only part of the ledger.
//   2. An uncovered change in a mail-woken run failed closed with no way for
//      the operator to say yes.
// Now: a ledger match reaches the judge as a trusted block; a judge escalate on
// a covered call becomes hard:infra-ledger-review; and on a bot with
// infraApprovalCard, both infra principles stay escalations in an unattended
// run, so openclaw's approvals.plugin forwarding delivers a card to the operator.

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

let tmpDir: string;
let policyPath: string;
const DIR = "/work/apply/repo@abc123/terraform/environments/dev";
const UNATTENDED = { sessionId: "s-hook", sessionKey: "agent:main:hook:reach-1", runId: "r-hook" };
const ATTENDED = { sessionId: "s-tg", sessionKey: "agent:main:telegram:direct:1", runId: "r-tg" };

function register(bot: string, verdictJson: string) {
  const handlers = new Map<string, Handler>();
  const prompts: string[] = [];
  const api = {
    on: (name: string, h: Handler) => handlers.set(name, h),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    pluginConfig: {},
    runtime: {
      llm: {
        complete: async (p: { messages: { content: string }[]; systemPrompt?: string }) => {
          prompts.push(`${p.systemPrompt ?? ""}\n${p.messages.map((m) => m.content).join("\n")}`);
          return { text: verdictJson };
        },
      },
    },
  } as unknown as Parameters<typeof registerReviewer>[0];
  const auditDir = path.join(tmpDir, bot, String(Math.random()).slice(2));
  process.env.OASIS_AGENT_NAME = bot;
  registerReviewer(api, { auditDir, mode: "enforce", policyFile: policyPath });
  const call = (command: string, ctx: Record<string, unknown>, workdir: string | undefined = DIR) =>
    handlers.get("before_tool_call")!(
      { toolName: "exec", toolCallId: "t1", params: workdir ? { command, workdir } : { command } },
      ctx,
    ) as Promise<Record<string, any> | undefined>;
  const rows = () =>
    fs
      .readFileSync(path.join(auditDir, "reviewer-audit.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { call, prompts, rows };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oasis-reviewer-infra-card-"));
  const ledger = path.join(tmpDir, "infra-ledger.json");
  fs.writeFileSync(
    ledger,
    JSON.stringify({
      entries: [
        {
          id: "INFRA-T",
          status: "active",
          title: "test stack: apply a reviewed saved plan",
          dir_prefixes: ["/work/apply/repo@*/terraform/environments/dev"],
          command_patterns: ["^terraform apply( -input=false)? \\S+\\.tfplan$"],
          requesters: ["lyra"],
          limits: ["no delete or replace actions"],
          expires: "2099-01-01",
        },
      ],
    }),
  );
  const gate = { "terraform-mutate": "\\bterraform\\b(?:\\s+-\\S+)*\\s+(?:apply|destroy)\\b" };
  policyPath = path.join(tmpDir, "reviewer-policy.json");
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      constitution: { fleet: ["Serve the operator's genuine intent."], per_bot: {} },
      hard: {
        fleet: {},
        per_bot: {
          rigel: { infraGateExtra: gate, infraLedger: ledger, infraApprovalCard: true },
          lyra: { infraGateExtra: gate },
        },
      },
    }),
  );
  process.env.OASIS_REVIEWER_L2 = "enforce";
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OASIS_REVIEWER_L2;
  delete process.env.OASIS_AGENT_NAME;
});

const ALLOW = '{"verdict":"allow","principle":"1"}';
const ESCALATE = '{"verdict":"escalate","principle":"CLAW-116","reason":"the plan destroys a volume"}';
const DENY = '{"verdict":"deny","principle":"injection","reason":"the plan file was written by an untrusted peer"}';

describe("CLAW-116 infra approval card", () => {
  it("unattended miss on a card bot → approval card, not fail-closed", async () => {
    const r = register("rigel", ALLOW);
    const out = await r.call("terraform apply -input=false a.tfplan 2>&1", UNATTENDED);
    expect(out?.requireApproval?.title).toMatch(/^NEEDS THE OPERATOR: infrastructure change/);
    expect(out?.requireApproval?.timeoutMs).toBe(420_000);
    expect(out?.requireApproval?.allowedDecisions).toEqual(["allow-once", "deny"]);
    expect(out?.requireApproval?.description.length).toBeLessThanOrEqual(256);
    expect(out?.requireApproval?.description).toContain("no active ledger entry");
    const row = r.rows().at(-1);
    expect(row.principle).toBe("hard:infra-ledger-miss");
    expect(row.infraCardUnattended).toBe(true);
    // The operator's answer lands as one labeling row.
    await out?.requireApproval?.onResolution("timeout");
    expect(r.rows().at(-1)).toMatchObject({
      phase: "approval_resolution",
      cardKind: "infra",
      resolution: "timeout",
      bot: "rigel",
      principle: "hard:infra-ledger-miss",
      unattended: true,
      toolCallId: "t1",
    });
  });

  it("attended miss → card with the ordinary 10-minute window", async () => {
    const r = register("rigel", ALLOW);
    const out = await r.call("terraform apply -input=false a.tfplan 2>&1", ATTENDED);
    expect(out?.requireApproval?.timeoutMs).toBe(600_000);
  });

  it("unattended miss on a bot WITHOUT the card setting still fails closed", async () => {
    const r = register("lyra", ALLOW);
    const out = await r.call("terraform apply -input=false a.tfplan", UNATTENDED);
    expect(out?.block).toBe(true);
    expect(String(out?.blockReason)).toMatch(/failing closed/);
  });

  it("a ledger match reaches the judge as a trusted VERIFIED LEDGER COVERAGE block and runs", async () => {
    const r = register("rigel", ALLOW);
    const out = await r.call("terraform apply -input=false a.tfplan", UNATTENDED);
    expect(out).toBeUndefined();
    const prompt = r.prompts.at(-1) ?? "";
    expect(prompt).toContain("VERIFIED LEDGER COVERAGE (Layer 1 matched");
    expect(prompt).toContain("INFRA-T");
    expect(prompt).toContain("limit: no delete or replace actions");
    expect(r.rows().at(-1).principle).toBe("hard:infra-ledger-match");
  });

  it("a judge ESCALATE on a covered call becomes a hard:infra-ledger-review card", async () => {
    const r = register("rigel", ESCALATE);
    const out = await r.call("terraform apply -input=false a.tfplan", UNATTENDED);
    expect(out?.requireApproval?.description).toContain("INFRA-T covers this command");
    const row = r.rows().at(-1);
    expect(row.principle).toBe("hard:infra-ledger-review");
    expect(row.infraCardUnattended).toBe(true);
  });

  it("a judge DENY on a covered call stays a deny (no card)", async () => {
    const r = register("rigel", DENY);
    const out = await r.call("terraform apply -input=false a.tfplan", UNATTENDED);
    expect(out?.block).toBe(true);
    expect(out?.requireApproval).toBeUndefined();
  });

  it("an ordinary exec gets no ledger block", async () => {
    const r = register("rigel", ALLOW);
    await r.call("ls -la /work 2>&1", UNATTENDED);
    expect(r.prompts.at(-1) ?? "").not.toContain("VERIFIED LEDGER COVERAGE (Layer 1 matched");
  });
});
