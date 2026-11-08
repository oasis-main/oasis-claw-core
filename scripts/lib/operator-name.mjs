// The name that host-side text uses for the human who runs this instance.
//
// Without a setting the text says "the operator". The order of the sources:
//   1. OASIS_OPERATOR_NAME in the environment
//   2. OASIS_OPERATOR_NAME in the .env file at the root of this repo
//   3. "What to call them", then "Name", in the Fleet Observatory settings
//   4. "the operator"
//
// A name is a label and gives no authority.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GENERIC = "the operator";
const SAFE_NAME = /^\p{L}[\p{L}\p{M} .'’-]{0,39}$/u;
const TTL_MS = 60_000;
const REPO_ENV = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");

export function cleanOperatorName(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return SAFE_NAME.test(text) && !/^(the )?operator$/i.test(text) ? text : "";
}

/** The value of OASIS_OPERATOR_NAME in the text of an env file, or "". */
export function parseEnvName(text) {
  const found = /^[ \t]*(?:export[ \t]+)?OASIS_OPERATOR_NAME[ \t]*=[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^#\r\n]*))/m.exec(text);
  return cleanOperatorName(found ? (found[1] ?? found[2] ?? found[3]) : "");
}

/** Pure, for tests: the name from the three sources. */
export function resolveOperatorName(environmentValue, envFileText, settings) {
  return (
    cleanOperatorName(environmentValue) ||
    parseEnvName(envFileText) ||
    cleanOperatorName(settings?.profile?.callThem) ||
    cleanOperatorName(settings?.profile?.name) ||
    GENERIC
  );
}

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

function settingsPath() {
  const dir = process.env.OASIS_OBSERVATORY_STATE_DIR || join(homedir(), "Library", "Application Support", "oasis-x", "observatory");
  return join(dir, "settings.json");
}

let cache;

function privateSources() {
  if (process.env.VITEST || process.env.NODE_TEST_CONTEXT) return { env: "", settings: undefined };
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache;
  let settings;
  try {
    settings = JSON.parse(read(settingsPath()) || "null") ?? undefined;
  } catch {
    settings = undefined;
  }
  cache = { at: now, env: read(REPO_ENV), settings };
  return cache;
}

export function operatorName() {
  const { env, settings } = privateSources();
  return resolveOperatorName(process.env.OASIS_OPERATOR_NAME, env, settings);
}

/** The name at the start of a sentence. */
export function operatorNameStart() {
  const name = operatorName();
  return name === GENERIC ? "The operator" : name;
}

/** The name in a heading in capital letters. */
export function operatorNameCaps() {
  return operatorName().toUpperCase();
}
