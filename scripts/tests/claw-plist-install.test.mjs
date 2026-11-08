// A tracked launchd plist uses __HOME__, so every install line must fill it in.
// launchd refuses a plist that still holds the placeholder (exit 78).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const plists = readdirSync(new URL("..", import.meta.url)).filter((n) => /^com\.oasis-x\..*\.plist$/.test(n));

test("no Makefile line copies a plist as it is", () => {
  const makefile = read("Makefile");
  assert.equal(/cp\s+scripts\/com\.oasis-x\.[a-z-]+\.plist/.test(makefile), false);
});

test("every plist that the Makefile installs is filled in by sed", () => {
  const makefile = read("Makefile");
  const installed = plists.filter((name) => makefile.includes(`scripts/${name}`));
  assert.ok(installed.length >= 8, `found ${installed.length}`);
  for (const name of installed) {
    const line = makefile.split("\n").find((l) => l.includes(`scripts/${name}`) && l.includes("sed "));
    assert.ok(line, name);
    assert.match(line, /^\t@sed 's\|__HOME__\|\$\(HOME\)\|g' scripts\/[a-z.-]+\.plist > "\$\([A-Z_]+\)"$/, name);
  }
});

test("no tracked plist holds a real home folder", () => {
  for (const name of plists) assert.equal(/\/Users\/[A-Za-z]/.test(read(`scripts/${name}`)), false, name);
});
