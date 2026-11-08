/**
 * The name that runtime text uses for the human who runs this instance.
 *
 * Without a setting the text says "the operator". The order of the sources:
 *   1. OASIS_OPERATOR_NAME, set at instance setup in the .env of the instance
 *      or of one bot. The host owns this value.
 *   2. The "What to call them" or "Name" line of the bot's own USER.md, which
 *      the bot or the Fleet Observatory settings can write.
 *   3. "the operator".
 *
 * Text that a security decision reads uses source 1 only (ALLOW_BOT_VALUE is
 * false in the oasis-reviewer copy), because a bot must not change what its
 * own reviewer reads. A name is a label and gives no authority.
 *
 * Each extension is its own package, so each has a copy of this file.
 * scripts/tests/claw-operator-name.test.mjs fails when the copies differ.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ALLOW_BOT_VALUE = false;
const GENERIC = "the operator";
const SAFE_NAME = /^\p{L}[\p{L}\p{M} .'’-]{0,39}$/u;
const BOT_VALUE_TTL_MS = 60_000;

/** The value as a safe display name, or "" when it is not one. */
export function cleanOperatorName(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return SAFE_NAME.test(text) && !/^(the )?operator$/i.test(text) ? text : "";
}

/** The name in the text of a USER.md, or "". */
export function parseUserMdName(text: string): string {
  for (const label of ["What to call them", "Name"]) {
    for (const line of text.matchAll(new RegExp(`^[ \\t]*-?[ \\t]*\\*\\*${label}:\\*\\*[ \\t]*(.*)$`, "gm"))) {
      const name = cleanOperatorName(line[1]);
      if (name) return name;
    }
  }
  return "";
}

/** Pure, for tests: the name from an instance value and a USER.md text. */
export function resolveOperatorName(instanceValue: unknown, userMdText: string): string {
  return cleanOperatorName(instanceValue) || (ALLOW_BOT_VALUE ? parseUserMdName(userMdText) : "") || GENERIC;
}

let cache: { at: number; text: string } | undefined;

function userMdText(): string {
  if (!ALLOW_BOT_VALUE || process.env.VITEST || process.env.NODE_TEST_CONTEXT) return "";
  const now = Date.now();
  if (cache && now - cache.at < BOT_VALUE_TTL_MS) return cache.text;
  let text = "";
  try {
    text = readFileSync(join(homedir(), ".openclaw", "workspace", "USER.md"), "utf8");
  } catch {
    // No USER.md: the instance value or the generic text applies.
  }
  cache = { at: now, text };
  return text;
}

export function operatorName(): string {
  return resolveOperatorName(process.env.OASIS_OPERATOR_NAME, userMdText());
}

/** The name at the start of a sentence. */
export function operatorNameStart(): string {
  const name = operatorName();
  return name === GENERIC ? "The operator" : name;
}

/** The name in a heading in capital letters. */
export function operatorNameCaps(): string {
  return operatorName().toUpperCase();
}

/** True when this instance has a personal name for the operator. */
export function hasOperatorName(): boolean {
  return operatorName() !== GENERIC;
}
