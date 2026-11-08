// Tests for the Access edits, step 5 part 1 (2026-11-06). Run with:
//   node --test scripts/tests/claw-observatory*.test.mjs
// The root is a software P-256 key, as in claw-authority.test.mjs.
//
// Load-bearing properties:
//   1. The access stream: a hub key can sign a tightening only; a widening
//      needs a root. Verify recomputes the direction, so a hub-signed add
//      never enters the log.
//   2. A role.yaml edit changes the one alsoAllow line and nothing else, and
//      refuses a layout it cannot edit safely.
//   3. A write root is a path under /reach/ off the fleet's plumbing; the
//      last write root cannot be removed (an empty list means no scope).
//   4. The merge is the same as scripts/reviewer-policy-merge.py.
//   5. An edit is signed BEFORE the file changes, writes the mounted files
//      in place, keeps the old text, and refuses a stale page, a Level C
//      widening, and a role.yaml that the bot's parser reads otherwise.
//      Nothing changes when Touch ID does not answer.
//   6. The route: a POST needs the token and this page's Origin.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appendEvent, initAuthority, keySigner, loadAuthority, loadHubSigner } from "../claw-authority.mjs";
import { checkRequest, createObservatoryServer } from "../claw-observatory.mjs";
import {
  GENERATED_NOTE,
  accessEditState,
  applyAccessEdit,
  editRoleAlsoAllow,
  editWriteRoots,
  mergeReviewerPolicy,
  policyFiles,
  policyText,
  roleAlsoAllow,
  writeRootProblem,
} from "../claw-observatory-access-edit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (t) => crypto.createHash("sha256").update(t).digest("hex");
const tmp = (p = "access-edit-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const p256 = () => keySigner(crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);

const ROLE = `# Vega role (test)
role: vega
phase: live

tools:
  profile: coding
  alsoAllow: [sleep_deep, browser]   # extra tools

exec:
  allow:
    - ls
    - cat
  dormant: {}
`;

const BASE = { _doc: "generic", botAliases: {}, constitution: { fleet: { rules: ["be careful"] }, per_bot: {} }, hard: { fleet: { deny: ["rm -rf /"] }, per_bot: {} } };
const OVERLAY = {
  botAliases: { "Mr. Vega": "vega", "Van Deneb": "vandeneb" },
  constitution: { per_bot: { vega: { note: "markets" }, vandeneb: { note: "red team" } } },
  hard: {
    per_bot: {
      vega: { allowWriteRoots: ["/reach/exp", "/reach/claw-comms"], denyWriteOutsideAllow: true },
      vandeneb: { allowWriteRoots: ["/reach/bounty-hunter"], denyWriteOutsideAllow: true },
    },
  },
};

const inspectFor = (repo, { name, bot, levelC = false }) => ({
  Name: `/oasis-claw-${bot}`,
  Config: {
    Env: [
      `OASIS_AGENT_NAME=${name}`,
      `OASIS_EXEC_SECURITY=${levelC ? "allowlist" : "full"}`,
      "OASIS_EXEC_MODE=full",
      "OASIS_EXEC_ASK=off",
      "OASIS_REVIEWER_MODE=enforce",
      "OASIS_REVIEWER_L2=enforce",
      ...(levelC ? ["OASIS_SANDBOX_SSH_SOCKET=/run/sbx.sock"] : []),
      "OASIS_GATEWAY_TOKEN=SECRET-TOKEN-VALUE",
    ],
  },
  Mounts: [{ Type: "bind", Source: path.join(repo, "bots", bot, "role.yaml"), Destination: "/app/role.yaml", RW: false }],
});

async function setup() {
  const repo = tmp("access-repo-");
  for (const bot of ["vega", "vandeneb"]) {
    fs.mkdirSync(path.join(repo, "bots", bot), { recursive: true });
    fs.writeFileSync(path.join(repo, "bots", bot, "role.yaml"), ROLE.replace("role: vega", `role: ${bot}`));
  }
  const files = policyFiles(repo);
  fs.mkdirSync(path.dirname(files.base), { recursive: true });
  fs.mkdirSync(path.dirname(files.out), { recursive: true });
  fs.writeFileSync(files.base, `${JSON.stringify(BASE, null, 2)}\n`);
  fs.writeFileSync(files.overlay, policyText(OVERLAY));
  fs.writeFileSync(files.out, policyText(mergeReviewerPolicy(BASE, OVERLAY)));
  const authorityDir = tmp("access-authority-");
  const root = p256();
  await initAuthority(authorityDir, root);
  const historyDir = tmp("access-history-");
  const inspects = {
    vega: inspectFor(repo, { name: "Mr. Vega", bot: "vega" }),
    vandeneb: inspectFor(repo, { name: "Van Deneb", bot: "vandeneb", levelC: true }),
  };
  const ctxFor = (bot, over = {}) => ({
    repoRoot: repo,
    files,
    inspect: inspects[bot],
    container: `oasis-claw-${bot}`,
    running: true,
    parseRole: async (text) => ({ tools: { alsoAllow: roleAlsoAllow(text).items } }),
    authorityDir,
    rootSigner: async () => root,
    historyDir,
    ...over,
  });
  const state = (bot) => accessEditState({ inspect: inspects[bot], repoRoot: repo, files });
  return { repo, files, authorityDir, root, hub: loadHubSigner(authorityDir), historyDir, inspects, ctxFor, state };
}

const accessEvents = (dir) => loadAuthority(dir).streams.access.events;

// ── 1. the access stream ─────────────────────────────────────────────────────

test("ACCESS STREAM: a hub signs a tightening only; a widening needs a root", async () => {
  const s = await setup();
  const body = (op) => ({ bot: "vega", setting: "tools.alsoAllow", op, value: "browser", file: "bots/vega/role.yaml", before: "a".repeat(64), after: "b".repeat(64) });
  const entry = (b) => ({ kind: "access.change", scope: `agent:${b.bot}`, body: b });
  await appendEvent(s.authorityDir, "access", entry(body("remove")), s.hub);
  await assert.rejects(appendEvent(s.authorityDir, "access", entry(body("add")), s.hub), /a widening needs the operator's root key/);
  await appendEvent(s.authorityDir, "access", entry(body("add")), s.root);
  await assert.rejects(appendEvent(s.authorityDir, "access", entry({ ...body("add"), setting: "exec.level" }), s.root), /the setting is one of/);
  await assert.rejects(appendEvent(s.authorityDir, "access", { ...entry(body("remove")), scope: "agent:other" }, s.hub), /names its bot/);
  await assert.rejects(appendEvent(s.authorityDir, "access", entry({ ...body("remove"), before: "x" }), s.hub), /hash before and after/);
  const auth = loadAuthority(s.authorityDir);
  assert.equal(auth.ok, true);
  assert.deepEqual(auth.streams.access.events.map((e) => e.body.op), ["remove", "add"]);
});

// ── 2. role.yaml ─────────────────────────────────────────────────────────────

test("role.yaml: an edit changes the one alsoAllow line, keeps its comment, and reads back", () => {
  const add = editRoleAlsoAllow(ROLE, "add", "file_fetch");
  assert.deepEqual(add.items, ["sleep_deep", "browser", "file_fetch"]);
  const before = ROLE.split("\n");
  const after = add.text.split("\n");
  assert.equal(after.length, before.length);
  assert.deepEqual(after.map((l, i) => l !== before[i]).filter(Boolean).length, 1, "exactly one line changed");
  assert.match(add.text, /^ {2}alsoAllow: \[sleep_deep, browser, file_fetch\] {2}# extra tools$/m);
  const remove = editRoleAlsoAllow(ROLE, "remove", "browser");
  assert.deepEqual(remove.items, ["sleep_deep"]);
  assert.deepEqual(editRoleAlsoAllow(editRoleAlsoAllow(ROLE, "remove", "browser").text, "remove", "sleep_deep").items, []);
});

test("role.yaml: refuse a layout it cannot edit safely, a duplicate, and a bad name", () => {
  assert.match(editRoleAlsoAllow(ROLE, "add", "browser").error, /already/);
  assert.match(editRoleAlsoAllow(ROLE, "remove", "message").error, /is not in/);
  assert.match(editRoleAlsoAllow(ROLE, "add", "Bad Name").error, /a tool name/);
  assert.match(editRoleAlsoAllow(ROLE.replace("[sleep_deep, browser]", "\n    - sleep_deep"), "add", "x").error, /not a one-line/);
  assert.match(editRoleAlsoAllow(ROLE.replace("[sleep_deep, browser]", '["sleep_deep"]'), "add", "x").error, /quoted or unusual/);
  assert.match(editRoleAlsoAllow(`${ROLE}\ntools:\n  alsoAllow: [a]\n`, "add", "x").error, /more than one tools block/);
  assert.match(roleAlsoAllow("role: x\n").error, /no top-level tools/);
});

// ── 3. write roots ───────────────────────────────────────────────────────────

test("write roots: under /reach/, off the plumbing; the last root stays", () => {
  for (const bad of ["/reach", "/tmp", "/reach/", "/reach/a/../b", "/reach/fleet", "/reach/authority/x", "/reach/mail", "reach/x", "/reach/a b"]) {
    assert.ok(writeRootProblem(bad), `${bad} must be refused`);
  }
  for (const good of ["/reach/fleet/status/vega", "/reach/new-work", "/reach/oasis-x/notes"]) assert.equal(writeRootProblem(good), null, good);
  const add = editWriteRoots(OVERLAY, "vega", "add", "/reach/new-work");
  assert.deepEqual(add.roots, ["/reach/exp", "/reach/claw-comms", "/reach/new-work"]);
  assert.deepEqual(OVERLAY.hard.per_bot.vega.allowWriteRoots, ["/reach/exp", "/reach/claw-comms"], "the input is not changed");
  assert.match(editWriteRoots(OVERLAY, "vandeneb", "remove", "/reach/bounty-hunter").error, /last write root/);
  assert.match(editWriteRoots(OVERLAY, "nobody", "add", "/reach/x").error, /no hard.per_bot.nobody/);
});

// ── 4. the merge ─────────────────────────────────────────────────────────────

test("the merge is the script's: the same note, overlay per_bot over base, the same refusals", () => {
  const script = fs.readFileSync(path.join(HERE, "..", "reviewer-policy-merge.py"), "utf8");
  const m = script.match(/"_generated": \(\s*"([^"]*)"\s*"([^"]*)"\s*\)/);
  assert.ok(m, "the script's _generated note");
  assert.equal(GENERATED_NOTE, m[1] + m[2]);
  const merged = mergeReviewerPolicy(BASE, OVERLAY);
  assert.deepEqual(Object.keys(merged), ["_doc", "_generated", "botAliases", "constitution", "hard"]);
  assert.deepEqual(merged.hard.fleet, BASE.hard.fleet);
  assert.deepEqual(merged.hard.per_bot.vega, OVERLAY.hard.per_bot.vega);
  assert.throws(() => mergeReviewerPolicy({ constitution: {}, hard: { fleet: {} } }, OVERLAY), /constitution.fleet/);
  assert.throws(() => mergeReviewerPolicy(BASE, { hard: { per_bot: {} } }), /zero per-bot/);
});

// ── 5. applying an edit ──────────────────────────────────────────────────────

test("EDIT: an add is root-signed first, then role.yaml changes in place; a remove is hub-signed", async () => {
  const s = await setup();
  const file = path.join(s.repo, "bots", "vega", "role.yaml");
  const inode = fs.statSync(file).ino;
  const st = s.state("vega");
  assert.deepEqual(st.tools.items, ["sleep_deep", "browser"]);
  const r = await applyAccessEdit("vega", { setting: "tools.alsoAllow", op: "add", value: "file_fetch", baseHash: st.tools.hash, reason: "fetch docs" }, s.ctxFor("vega"));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.event.signedBy, "root");
  assert.equal(fs.statSync(file).ino, inode, "written in place: a single-file bind mount sees it");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /alsoAllow: \[sleep_deep, browser, file_fetch\]/);
  const [e] = accessEvents(s.authorityDir);
  assert.equal(e.signer.key, s.root.key);
  assert.equal(e.body.before, st.tools.hash);
  assert.equal(e.body.after, sha256(text));
  assert.equal(e.body.reason, "fetch docs");
  const kept = fs.readdirSync(path.join(s.historyDir, "vega"));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(s.historyDir, "vega", kept[0]), "utf8"), ROLE, "the replaced text is kept");

  const rm = await applyAccessEdit("vega", { setting: "tools.alsoAllow", op: "remove", value: "browser", baseHash: sha256(text) }, s.ctxFor("vega", { rootSigner: async () => assert.fail("a tightening needs no Touch ID") }));
  assert.equal(rm.ok, true, rm.error);
  assert.equal(rm.event.signedBy, "hub");
  assert.equal(accessEvents(s.authorityDir)[1].signer.key, s.hub.key);
});

test("EDIT: a write root changes the overlay and the merged policy in place, in sync", async () => {
  const s = await setup();
  const inode = fs.statSync(s.files.out).ino;
  const st = s.state("vega");
  assert.equal(st.writeRoots.scoped, true);
  const r = await applyAccessEdit("vega", { setting: "reviewer.writeRoots", op: "add", value: "/reach/new-work", baseHash: st.writeRoots.hash }, s.ctxFor("vega"));
  assert.equal(r.ok, true, r.error);
  const overlay = JSON.parse(fs.readFileSync(s.files.overlay, "utf8"));
  assert.deepEqual(overlay.hard.per_bot.vega.allowWriteRoots, ["/reach/exp", "/reach/claw-comms", "/reach/new-work"]);
  assert.equal(fs.readFileSync(s.files.out, "utf8"), policyText(mergeReviewerPolicy(BASE, overlay)));
  assert.equal(fs.statSync(s.files.out).ino, inode, "the mounted policy is written in place");
  assert.deepEqual(s.state("vega").writeRoots.roots, ["/reach/exp", "/reach/claw-comms", "/reach/new-work"]);
});

test("EDIT REFUSED: a stale page, a Level C widening, a parser that disagrees, no Touch ID; nothing changes", async () => {
  const s = await setup();
  const file = path.join(s.repo, "bots", "vega", "role.yaml");
  const hash = s.state("vega").tools.hash;
  const req = { setting: "tools.alsoAllow", op: "add", value: "file_fetch", baseHash: hash };

  const stale = await applyAccessEdit("vega", { ...req, baseHash: "0".repeat(64) }, s.ctxFor("vega"));
  assert.equal(stale.status, 409);
  assert.match(stale.error, /changed since the page read it/);

  const vh = s.state("vandeneb");
  assert.equal(vh.widen.allowed, false);
  const widen = await applyAccessEdit("vandeneb", { ...req, baseHash: vh.tools.hash }, s.ctxFor("vandeneb"));
  assert.equal(widen.status, 403);
  const tighten = await applyAccessEdit("vandeneb", { setting: "tools.alsoAllow", op: "remove", value: "browser", baseHash: vh.tools.hash }, s.ctxFor("vandeneb"));
  assert.equal(tighten.ok, true, "a Level C bot may still be tightened");

  const parser = await applyAccessEdit("vega", req, s.ctxFor("vega", { parseRole: async () => ({ tools: { alsoAllow: ["sleep_deep"] } }) }));
  assert.match(parser.error, /parser does not read the edit/);

  const noTouch = await applyAccessEdit("vega", req, s.ctxFor("vega", { rootSigner: async () => ({ ...s.root, sign: async () => { throw new Error("oasis-root-key stopped after 180 s with no answer (no Touch ID?)"); } }) }));
  assert.match(noTouch.error, /not signed: .*no Touch ID/);

  const lastRoot = await applyAccessEdit("vandeneb", { setting: "reviewer.writeRoots", op: "remove", value: "/reach/bounty-hunter", baseHash: s.state("vandeneb").writeRoots.hash }, s.ctxFor("vandeneb"));
  assert.match(lastRoot.error, /last write root/);

  assert.equal(fs.readFileSync(file, "utf8"), ROLE, "vega role.yaml is unchanged");
  assert.deepEqual(accessEvents(s.authorityDir).map((e) => `${e.body.bot} ${e.body.op}`), ["vandeneb remove"], "only the one tightening was signed");
});

test("EDIT REFUSED: an overlay out of sync with the merged policy", async () => {
  const s = await setup();
  fs.writeFileSync(s.files.out, policyText(BASE));
  const st = s.state("vega");
  assert.match(st.writeRoots.error, /run make reviewer-policy first/);
  const r = await applyAccessEdit("vega", { setting: "reviewer.writeRoots", op: "add", value: "/reach/x", baseHash: "0".repeat(64) }, s.ctxFor("vega"));
  assert.equal(r.status, 409);
});

// ── 6. the route ─────────────────────────────────────────────────────────────

test("server: GET /api/access carries the edit state; POST /api/access/<bot>/edit signs and writes; no Origin, no write", async () => {
  const s = await setup();
  const ctx = {
    port: 0,
    token: "t".repeat(43),
    discover: async () => ({
      bots: ["vega", "vandeneb"].map((k) => ({ key: k, container: `oasis-claw-${k}`, running: true, state: "running", controlUi: { url: null, via: "none" }, board: null })),
      proxy: null,
    }),
    swarm: { port: 1, url: "http://127.0.0.1:1/" },
    inspectFor: (container) => s.inspects[container.replace("oasis-claw-", "")] ?? null,
    readAccessConfig: async () => ({ config: { toolsProfile: "coding", alsoAllow: [], execMode: "full", sandbox: {}, skipBootstrap: true }, approvals: null, persona: null }),
    readRoleDeclared: async () => ({ error: "not read in this test" }),
    readPolicy: async () => null,
    repoRoot: s.repo,
    policyFiles: s.files,
    authorityDir: s.authorityDir,
    rootSigner: async () => s.root,
    accessHistoryDir: s.historyDir,
    parseRoleInBot: async (_c, text) => ({ tools: { alsoAllow: roleAlsoAllow(text).items } }),
  };
  const server = createObservatoryServer(ctx);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  ctx.port = server.address().port;
  const call = (pathname, method = "GET", body = null, { origin = true } = {}) =>
    new Promise((resolve, reject) => {
      const headers = { host: `127.0.0.1:${ctx.port}`, "x-observatory-token": ctx.token };
      if (method !== "GET" && origin) headers.origin = `http://127.0.0.1:${ctx.port}`;
      if (body) headers["content-type"] = "application/json";
      const req = http.request({ host: "127.0.0.1", port: ctx.port, path: pathname, method, headers, agent: false }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text, json: JSON.parse(text || "null") }));
      });
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  try {
    const g = await call("/api/access");
    assert.equal(g.status, 200);
    const vega = g.json.bots.find((b) => b.key === "vega");
    assert.deepEqual(vega.edit.tools.items, ["sleep_deep", "browser"]);
    assert.equal(vega.edit.widen.allowed, true);
    assert.equal(g.json.bots.find((b) => b.key === "vandeneb").edit.widen.allowed, false);
    assert.ok(!g.text.includes("SECRET-TOKEN-VALUE"));
    const body = { setting: "tools.alsoAllow", op: "add", value: "file_fetch", baseHash: vega.edit.tools.hash };
    assert.equal((await call("/api/access/vega/edit", "POST", body, { origin: false })).status, 403);
    assert.equal((await call("/api/access/vega/edit")).status, 405);
    assert.equal((await call("/api/access/ghost/edit", "POST", body)).status, 404);
    const ok = await call("/api/access/vega/edit", "POST", body);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.restart.container, "oasis-claw-vega");
    const again = await call("/api/access");
    assert.deepEqual(again.json.bots.find((b) => b.key === "vega").edit.tools.items, ["sleep_deep", "browser", "file_fetch"], "the edit state is read fresh");
  } finally {
    await new Promise((r) => server.close(r));
  }
  const req = (method, url) => ({ method, url, headers: { host: "127.0.0.1:18780", origin: "http://127.0.0.1:18780" } });
  assert.equal(checkRequest(req("PUT", "/api/access/vega/edit"), 18780)?.status, 405);
  assert.equal(checkRequest(req("POST", "/api/access"), 18780)?.status, 405, "the read route still takes no write");
  assert.equal(checkRequest(req("POST", "/api/access/vega/edit"), 18780), null);
});
