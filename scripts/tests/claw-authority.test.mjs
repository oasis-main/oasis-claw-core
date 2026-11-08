// Tests for the authority hub core (scripts/claw-authority.mjs, 2026-11-02).
// The root is a software P-256 key here: the same ECDSA-SHA256 DER signature
// as the Secure Enclave key, which needs Touch ID. A stand-in for
// oasis-root-key checks the tool protocol.
//
// Load-bearing properties:
//   1. Nothing verifies without the pinned root (no trust on first use), and
//      a changed, dropped or reordered line breaks the chain.
//   2. A hub restricts only its own scope: never the fleet, never below
//      chat-only, always with a trigger and evidence, 24 h at most for a
//      count-rule or X-model restriction. Only a root lifts.
//   3. The rate budget holds a third agent in one hour and reports a storm;
//      it never loosens anything.
//   4. A lift removes the named adds only; key.void removes a key's adds from
//      a time on and stops that hub.
//   5. A root set change needs 2 roots once 2 exist.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BUDGET,
  appendEvent,
  canonical,
  countRuleHits,
  effectiveLevel,
  enclaveSigner,
  evaluateRestrictions,
  fingerprint,
  initAuthority,
  keySigner,
  loadAuthority,
  loadHubSigner,
} from "../claw-authority.mjs";

const T0 = Date.parse("2026-11-02T20:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const EVIDENCE = "a".repeat(64);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "authority-"));
const p256 = () => keySigner(crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);

async function setup({ agents } = {}) {
  const dir = tmp();
  const root = p256();
  let clock = T0;
  const now = () => clock;
  await initAuthority(dir, root, { now, ...(agents ? { agents } : {}) });
  const hub = loadHubSigner(dir);
  return {
    dir,
    root,
    hub,
    at: (t) => (clock = t),
    add: (signer, body, opts = {}) =>
      appendEvent(dir, "restrictions", { kind: "restriction.add", scope: body.target, body }, signer, { now, ...opts }),
    lift: (ids) => appendEvent(dir, "restrictions", { kind: "restriction.lift", scope: "fleet", body: { ids } }, root, { now }),
    control: (kind, body, signer = root, opts = {}) => appendEvent(dir, "control", { kind, scope: "fleet", body }, signer, { now, ...opts }),
    load: () => loadAuthority(dir),
    evaluate: (nowMs = clock) => {
      const auth = loadAuthority(dir);
      return evaluateRestrictions(auth.streams.restrictions.events, auth.trust, nowMs);
    },
  };
}

const auto = (target, extra = {}) => ({ target, level: "chat-only", trigger: "hard-rule", reason: "canary token read", evidence: EVIDENCE, ...extra });

test("canonical: sorted keys, no spaces, integers only", () => {
  assert.equal(canonical({ b: 1, a: [true, null, "x"], c: undefined }), '{"a":[true,null,"x"],"b":1}');
  assert.throws(() => canonical({ a: 1.5 }), /integers only/);
  assert.throws(() => canonical({ a: () => 1 }), /cannot hold/);
});

test("init writes the pin, the hub key (0600) and a genesis that verifies", async () => {
  const s = await setup();
  const auth = s.load();
  assert.equal(auth.ok, true);
  assert.equal(auth.pin, s.root.key);
  assert.deepEqual([...auth.trust.roots.keys()], [s.root.key]);
  assert.deepEqual([...auth.trust.hubs.keys()], [s.hub.key]);
  assert.equal(fs.statSync(path.join(s.dir, "hub.ed25519.pem")).mode & 0o777, 0o600);
  await assert.rejects(() => initAuthority(s.dir, s.root), /already has a control stream/);
});

test("no pin, or a different pin, verifies nothing (no trust on first use)", async () => {
  const s = await setup();
  assert.match(loadAuthority(s.dir, { pin: null }).streams.control.errors[0], /no pinned root/);
  assert.match(loadAuthority(s.dir, { pin: p256().key }).streams.control.errors[0], /not the pinned root/);
});

test("a changed, dropped or reordered line breaks the chain", async () => {
  const s = await setup();
  const a = await s.add(s.root, { target: "agent:vega", level: "read-only", trigger: "operator", reason: "one" });
  await s.add(s.root, { target: "agent:lyra", level: "read-only", trigger: "operator", reason: "two" });
  const file = path.join(s.dir, "streams", "restrictions.jsonl");
  const good = fs.readFileSync(file, "utf8");
  const lines = good.trim().split("\n");

  fs.writeFileSync(file, good.replace('"level":"read-only"', '"level":"fail-closed"'));
  assert.match(s.load().streams.restrictions.errors[0], /id does not match/);
  fs.writeFileSync(file, `${lines[1]}\n`);
  assert.match(s.load().streams.restrictions.errors[0], /seq 1, expected 0/);
  fs.writeFileSync(file, `${lines[1]}\n${lines[0]}\n`);
  assert.equal(s.load().ok, false);
  // A re-signed forgery by an unknown key: a valid chain, the wrong signer.
  const forged = JSON.parse(lines[0]);
  const mallory = p256();
  forged.signer = { key: mallory.key, alg: mallory.alg };
  fs.writeFileSync(file, `${JSON.stringify(forged)}\n`);
  assert.equal(s.load().ok, false);
  fs.writeFileSync(file, good);
  assert.equal(s.load().ok, true);
  assert.equal(s.evaluate().byTarget["agent:vega"].ids[0], a.id);
  await assert.rejects(
    () => {
      fs.writeFileSync(file, good.replace('"reason":"one"', '"reason":"uno"'));
      return s.add(s.root, { target: "agent:rigel", level: "read-only", trigger: "operator", reason: "three" });
    },
    /does not verify/,
    "nothing appends to a broken log",
  );
});

test("a hub restricts only its own scope, never the fleet, never below chat-only", async () => {
  const s = await setup({ agents: ["vega", "lyra"] });
  const ok = await s.add(s.hub, auto("instance:vega@oasis-claw-vega"));
  assert.equal(ok.signer.key, s.hub.key);
  await assert.rejects(() => s.add(s.hub, auto("fleet")), /only a root restricts the fleet/);
  await assert.rejects(() => s.add(s.hub, auto("agent:orion")), /not certified for orion/);
  await assert.rejects(() => s.add(s.hub, auto("agent:vega", { level: "stopped" })), /stops at chat-only/);
  await assert.rejects(() => s.add(s.hub, auto("agent:vega", { trigger: "operator" })), /has a trigger/);
  await assert.rejects(() => s.add(s.hub, auto("agent:vega", { evidence: undefined })), /hash of the event/);
  await assert.rejects(() => s.add(s.hub, auto("agent:vega", { trigger: "count-rule" })), /expires within 24 hours/);
  await assert.rejects(
    () => s.add(s.hub, auto("agent:vega", { trigger: "x-model", expiresAt: new Date(T0 + 25 * HOUR).toISOString() })),
    /expires within 24 hours/,
  );
  await s.add(s.hub, auto("agent:vega", { trigger: "count-rule", expiresAt: new Date(T0 + 24 * HOUR).toISOString() }));
  await assert.rejects(() => appendEvent(s.dir, "restrictions", { kind: "restriction.lift", scope: "fleet", body: { ids: [ok.id] } }, s.hub), /only a root lifts/);
  // The root may do what the hub may not.
  await s.add(s.root, { target: "fleet", level: "stopped", trigger: "operator", reason: "everything off" });
  await assert.rejects(() => s.add(s.root, { target: "agent:vega", level: "read-only", trigger: "hard-rule", reason: "x" }), /trigger operator/);
  // A block signed before the rename keeps its old trigger value, and the chain still accepts it.
  await s.add(s.root, { target: "agent:vega", level: "chat-only", trigger: "a-personal-name", reason: "an old block" });
});

test("TTL: a count-rule restriction ends after 24 h, and shows as expiring 2 h before", async () => {
  const s = await setup();
  await s.add(s.hub, auto("agent:vega", { trigger: "count-rule", expiresAt: new Date(T0 + 24 * HOUR).toISOString() }));
  assert.equal(effectiveLevel(s.evaluate(T0 + HOUR), "vega"), "chat-only");
  assert.equal(s.evaluate(T0 + HOUR).expiring.length, 0);
  assert.equal(s.evaluate(T0 + 23 * HOUR).expiring.length, 1, "the keep-or-let-expire card is due");
  assert.equal(effectiveLevel(s.evaluate(T0 + 24 * HOUR), "vega"), null);
});

test("rate budget: a third agent in one hour is held and reported as a storm", async () => {
  const s = await setup();
  await s.add(s.hub, auto("agent:vega"));
  s.at(T0 + 10 * MIN);
  await s.add(s.hub, auto("agent:lyra"));
  s.at(T0 + 20 * MIN);
  await s.add(s.hub, auto("instance:vega@oasis-claw-vega"), {}); // same agent: within budget
  s.at(T0 + 30 * MIN);
  const third = await s.add(s.hub, auto("agent:rigel"));
  let ev = s.evaluate();
  assert.deepEqual(ev.held.map((h) => h.id), [third.id]);
  assert.equal(effectiveLevel(ev, "rigel"), null, "a held restriction is not in force");
  assert.equal(ev.storms.length, 1);
  assert.equal(ev.storms[0].issuer, s.hub.key);
  // A root restriction is never held.
  await s.add(s.root, { target: "agent:altair", level: "read-only", trigger: "operator", reason: "The operator" });
  assert.equal(effectiveLevel(s.evaluate(), "altair"), "read-only");
  // After the window, the hub can restrict a new agent again.
  s.at(T0 + 10 * MIN + BUDGET.windowMs + 1);
  await s.add(s.hub, auto("agent:vandeneb"));
  ev = s.evaluate();
  assert.equal(effectiveLevel(ev, "vandeneb"), "chat-only");
});

test("a lift removes the named add only; a later add on the same target stays (observed-remove)", async () => {
  const s = await setup();
  const first = await s.add(s.hub, auto("agent:vega"));
  await s.lift([first.id]);
  assert.equal(effectiveLevel(s.evaluate(), "vega"), null);
  s.at(T0 + MIN);
  await s.add(s.hub, auto("agent:vega", { level: "read-only" }));
  assert.equal(effectiveLevel(s.evaluate(), "vega"), "read-only");
});

test("effective level: the strongest of fleet, agent and instance", async () => {
  const s = await setup();
  await s.add(s.hub, auto("instance:orion@oasis-claw-runtime", { level: "fail-closed" }));
  await s.add(s.hub, auto("agent:orion", { level: "read-only" }));
  const ev = s.evaluate();
  assert.equal(effectiveLevel(ev, "orion", "oasis-claw-runtime"), "read-only");
  assert.equal(effectiveLevel(ev, "vega", "oasis-claw-vega"), null);
  await s.add(s.root, { target: "fleet", level: "chat-only", trigger: "operator", reason: "freeze all" });
  assert.equal(effectiveLevel(s.evaluate(), "vega", "oasis-claw-vega"), "chat-only");
});

test("key.void removes a key's adds from a time on and stops that hub", async () => {
  const s = await setup();
  const early = await s.add(s.hub, auto("agent:vega"));
  s.at(T0 + 30 * MIN);
  await s.add(s.hub, auto("agent:lyra"));
  s.at(T0 + 40 * MIN);
  await s.control("key.void", { key: s.hub.key, since: new Date(T0 + 20 * MIN).toISOString() });
  const ev = s.evaluate();
  assert.deepEqual(ev.active.map((r) => r.id), [early.id]);
  s.at(T0 + 50 * MIN);
  await assert.rejects(() => s.add(s.hub, auto("agent:rigel")), /not a root or a valid hub/);
});

test("an expired hub certificate signs nothing; renew-hub restores it", async () => {
  const s = await setup();
  s.at(T0 + 91 * 24 * HOUR);
  await assert.rejects(() => s.add(s.hub, auto("agent:vega")), /not a root or a valid hub/);
  await s.control("hub.cert", { hub: { alg: s.hub.alg, public: s.hub.public, agents: ["*"], expiresAt: new Date(T0 + 150 * 24 * HOUR).toISOString() } });
  await s.add(s.hub, auto("agent:vega"));
  await assert.rejects(
    () => s.control("hub.cert", { hub: { alg: s.hub.alg, public: s.hub.public, agents: ["*"], expiresAt: new Date(T0 + 400 * 24 * HOUR).toISOString() } }),
    /90 days at most/,
  );
});

test("root set: one root adds a second; then a change needs both", async () => {
  const s = await setup();
  const phone = p256();
  const recovery = p256();
  await s.control("root.add", { root: { alg: phone.alg, public: phone.public, label: "iphone" } });
  await assert.rejects(() => s.control("root.add", { root: { alg: recovery.alg, public: recovery.public, label: "recovery" } }), /needs 2 root signatures/);
  await s.control("root.add", { root: { alg: recovery.alg, public: recovery.public, label: "recovery" } }, s.root, { cosigners: [phone] });
  assert.equal(s.load().trust.roots.size, 3);
  await assert.rejects(() => s.control("root.remove", { key: phone.key }, s.root, { cosigners: [p256()] }), /needs 2 root signatures/);
  await s.control("root.remove", { key: phone.key }, recovery, { cosigners: [s.root] });
  assert.deepEqual([...s.load().trust.roots.keys()].sort(), [s.root.key, recovery.key].sort());
  // A hub can never sign control events.
  await assert.rejects(() => s.control("hub.revoke", { key: s.hub.key }, s.hub), /needs a root signature/);
  // An Ed25519 key cannot be a root.
  await assert.rejects(() => s.control("root.add", { root: { alg: "p256", public: s.hub.public } }, s.root, { cosigners: [recovery] }), /P-256/);
});

test("parallel appends get one gap-free chain", async () => {
  const s = await setup();
  await Promise.all(["a", "b", "c", "d", "e", "f"].map((n) => s.add(s.root, { target: `agent:bot-${n}`, level: "read-only", trigger: "operator", reason: n })));
  const auth = s.load();
  assert.equal(auth.ok, true);
  assert.deepEqual(auth.streams.restrictions.events.map((e) => e.seq), [0, 1, 2, 3, 4, 5]);
});

test("count rule: 5 denials in 10 minutes on one instance", () => {
  const d = (min, instance = "oasis-claw-vega", id = `${min}`.padStart(64, "0")) => ({ id, at: T0 + min * MIN, agent: "vega", instance });
  const now = T0 + 10 * MIN;
  assert.deepEqual(countRuleHits([d(1), d(2), d(3), d(4), d(5)], now), [{ agent: "vega", instance: "oasis-claw-vega", count: 5, evidence: d(5).id }]);
  assert.deepEqual(countRuleHits([d(1), d(2), d(3), d(4)], now), []);
  assert.deepEqual(countRuleHits([d(-1), d(2), d(3), d(4), d(5)], now), [], "one denial is older than 10 minutes");
  assert.deepEqual(countRuleHits([d(1), d(2), d(3), d(4, "other"), d(5)], now), [], "two instances are counted apart");
});

test("enclaveSigner speaks the oasis-root-key protocol and refuses a tool that signs something else", async () => {
  const dir = tmp();
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  fs.writeFileSync(path.join(dir, "root.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
  const tool = (lie) => {
    const file = path.join(dir, lie ? "lying-tool.mjs" : "tool.mjs");
    fs.writeFileSync(
      file,
      `#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
const key = crypto.createPrivateKey(fs.readFileSync(${JSON.stringify(path.join(dir, "root.pem"))}, "utf8"));
const pub = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
const out = { alg: "p256", public: pub.toString("base64"), key: "p256:" + crypto.createHash("sha256").update(pub).digest("hex").slice(0, 16) };
if (process.argv[2] === "sign") {
  const msg = fs.readFileSync(0);
  out.id = crypto.createHash("sha256").update(${lie ? 'Buffer.concat([msg, Buffer.from(" ")])' : "msg"}).digest("hex");
  out.sig = crypto.sign("sha256", msg, { key, dsaEncoding: "der" }).toString("base64");
}
console.log(JSON.stringify(out));
`,
      { mode: 0o755 },
    );
    return file;
  };
  const signer = await enclaveSigner(tool(false), path.join(dir, "root.se"));
  assert.equal(signer.key, fingerprint(signer));
  const authDir = tmp();
  await initAuthority(authDir, signer);
  assert.equal(loadAuthority(authDir).ok, true);
  const liar = await enclaveSigner(tool(true), path.join(dir, "root.se"));
  await assert.rejects(() => initAuthority(tmp(), liar), /signed something else/);
});
