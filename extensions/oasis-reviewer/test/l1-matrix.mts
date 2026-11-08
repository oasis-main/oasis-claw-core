// Deterministic Layer-1 coverage for the oasis-reviewer (CLAW-074/078).
//
// WHY THIS EXISTS: a 2026-07-29 outage was a Layer-1 false POSITIVE
// (`\bopenclaw\b` matching the .openclaw path in every gog command) that shadow
// mode could not surface — shadow logs a verdict, it never shows you the job it
// would have killed. This pins the whole allow/deny/escalate matrix so the next
// such regression fails here instead of in a cron job at 8am.
//
// .mts on purpose: the policy import is dynamic (path-parameterized), which needs
// ESM output — tsx emits cjs for .ts and rejects top-level await.
//
// The cases are DEPLOYMENT data: each case names a real bot key and a real path
// of that deployment, so they live in a private JSON file next to the private
// policy overlay, not in this repository. Each entry is
//   { "bot", "want": "allow"|"deny"|"escalate", "family": "exec"|"file"|"web"|"other",
//     "tool", "params", "note" }
//
// RUN IT (inside any bot container — needs the baked policy + tsx):
//   docker exec -i <container> sh -c 'cat > /tmp/l1-matrix.mts' \
//     < extensions/oasis-reviewer/test/l1-matrix.mts
//   docker exec -i <container> sh -c 'cat > /tmp/l1-cases.json' < <private case file>
//   docker exec -e OASIS_REVIEWER_MATRIX_CASES=/tmp/l1-cases.json <container> node \
//     /usr/local/lib/node_modules/tsx/dist/cli.mjs /tmp/l1-matrix.mts
//
// NOTE: `docker cp` into these containers SILENTLY FAILS (read_only rootfs) —
// pipe via stdin into the /tmp tmpfs as above.
//
// Override paths to run against a checkout instead:
//   OASIS_REVIEWER_SRC=./extensions/oasis-reviewer  (dir holding src/ + policy/)
//
// One run covers the whole deployment: each case resolves that bot's policy by
// key, so per-bot scoping is exercised without spending a bot turn.

const ROOT = process.env.OASIS_REVIEWER_SRC ?? "/app/extensions/oasis-reviewer";

const { evaluateHard, loadPolicyFile, resolveHardPolicy } = await import(`${ROOT}/src/policy.ts`);

// This matrix asserts DEPLOYMENT posture: it checks each real bot's per-bot
// rules, which are private and therefore not in the committed policy. The
// tracked policy ships the fleet baseline with `per_bot` empty; a deployment
// merges its private overlay over it (scripts/reviewer-policy-merge.py) and
// points this at the result. Without that overlay there is nothing per-bot to
// assert, so the matrix reports why it cannot run instead of failing — a fresh
// clone has no fleet to test.
const POLICY_PATH = process.env.OASIS_REVIEWER_POLICY ?? `${ROOT}/policy/reviewer-policy.json`;
const POLICY = loadPolicyFile(POLICY_PATH);

if (Object.keys(POLICY?.hard?.per_bot ?? {}).length === 0) {
  console.log(
    `Layer-1 matrix: SKIPPED — no per-bot policy in ${POLICY_PATH}.\n` +
      "  This test needs a merged policy that includes per-bot rules. Generate one with:\n" +
      "    scripts/reviewer-policy-merge.py <base> <private-overlay> <out>\n" +
      "  then re-run with OASIS_REVIEWER_POLICY=<out>.",
  );
  process.exit(0);
}

type Case = {
  bot: string;
  want: "allow" | "deny" | "escalate";
  family: "exec" | "file" | "web" | "other";
  tool: string;
  params: Record<string, unknown>;
  note: string;
};

const { existsSync, readFileSync } = await import("node:fs");
const CASES_PATH = process.env.OASIS_REVIEWER_MATRIX_CASES ?? "";
if (!CASES_PATH || !existsSync(CASES_PATH)) {
  console.log(
    `Layer-1 matrix: SKIPPED — no case file (OASIS_REVIEWER_MATRIX_CASES=${CASES_PATH || "<unset>"}).\n` +
      "  The cases name the bots and paths of one deployment, so they are kept with\n" +
      "  that deployment's private policy overlay. Point OASIS_REVIEWER_MATRIX_CASES at them.",
  );
  process.exit(0);
}
const CASES: Case[] = JSON.parse(readFileSync(CASES_PATH, "utf8"));

let pass = 0;
const fails: string[] = [];
const byBot: Record<string, { p: number; f: number }> = {};

for (const c of CASES) {
  const policy = resolveHardPolicy(POLICY, c.bot);
  const d = evaluateHard({ family: c.family, toolName: c.tool, params: c.params, derivedPaths: undefined }, policy);
  const ok = d.verdict === c.want;
  byBot[c.bot] ??= { p: 0, f: 0 };
  if (ok) {
    pass++;
    byBot[c.bot].p++;
  } else {
    byBot[c.bot].f++;
    fails.push(
      `  FAIL [${c.bot}] want=${c.want} got=${d.verdict} (${d.principle})\n` +
        `       ${c.note}\n` +
        `       input: ${JSON.stringify(c.params).slice(0, 110)}`,
    );
  }
}

console.log(`Layer-1 matrix: ${pass}/${CASES.length} passed\n`);
for (const [bot, s] of Object.entries(byBot).sort()) {
  console.log(`  ${bot.padEnd(12)} ${String(s.p).padStart(2)} pass  ${s.f ? String(s.f) + " FAIL" : ""}`);
}
if (fails.length) {
  console.log("\n" + fails.join("\n"));
  process.exit(1);
}
console.log("\nALL PASS");
