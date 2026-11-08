// The operator-name setting on the host side, and the copies of its helper.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cleanOperatorName, operatorName, parseEnvName, resolveOperatorName } from "../lib/operator-name.mjs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const OPEN_COPIES = ["approval-gate", "oasis-reach", "oasis-voice-control"];

test("every extension copy of the helper is the same", () => {
  const first = read(`extensions/${OPEN_COPIES[0]}/src/operator-name.ts`);
  for (const name of OPEN_COPIES) assert.equal(read(`extensions/${name}/src/operator-name.ts`), first, name);
  assert.match(first, /const ALLOW_BOT_VALUE = true;/);
});

test("the reviewer copy differs only in that it refuses a value that the bot wrote", () => {
  const open = read(`extensions/${OPEN_COPIES[0]}/src/operator-name.ts`);
  const reviewer = read("extensions/oasis-reviewer/src/operator-name.ts");
  assert.match(reviewer, /const ALLOW_BOT_VALUE = false;/);
  assert.equal(reviewer.replace("ALLOW_BOT_VALUE = false", "ALLOW_BOT_VALUE = true"), open);
});

test("the sources apply in order", () => {
  const settings = { profile: { name: "Full Name", callThem: "Sam" } };
  assert.equal(resolveOperatorName("Alex", "OASIS_OPERATOR_NAME=Pat\n", settings), "Alex");
  assert.equal(resolveOperatorName(undefined, "OASIS_OPERATOR_NAME=Pat\n", settings), "Pat");
  assert.equal(resolveOperatorName(undefined, "", settings), "Sam");
  assert.equal(resolveOperatorName(undefined, "", { profile: { name: "Full Name" } }), "Full Name");
  assert.equal(resolveOperatorName(undefined, "", undefined), "the operator");
});

test("env files parse in the usual forms", () => {
  assert.equal(parseEnvName('OASIS_OPERATOR_NAME="Pat Lane"\n'), "Pat Lane");
  assert.equal(parseEnvName("export OASIS_OPERATOR_NAME='Pat'\n"), "Pat");
  assert.equal(parseEnvName("OASIS_OPERATOR_NAME=Pat   # a note\n"), "Pat");
  assert.equal(parseEnvName("OASIS_OPERATOR_NAME=\n"), "");
  assert.equal(parseEnvName("OTHER=Pat\n"), "");
});

test("a value that is not a plain name is ignored", () => {
  for (const bad of ["", "operator", "the operator", "a: b", "${x}", "x".repeat(41)]) assert.equal(cleanOperatorName(bad), "");
});

test("tests do not read private files", () => {
  assert.equal(operatorName(), "the operator");
});

test("instance setup documents the setting", () => {
  assert.match(read(".env.example"), /^OASIS_OPERATOR_NAME=$/m);
  assert.match(read("autoreviewer/.env.example"), /^OASIS_OPERATOR_NAME=$/m);
  assert.match(read("autoreviewer/docker-compose.autoreviewer.yml"), /OASIS_OPERATOR_NAME: "\$\{OASIS_OPERATOR_NAME:-\}"/);
});
