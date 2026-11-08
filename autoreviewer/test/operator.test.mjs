import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanOperatorName, operatorName, operatorNameCaps, operatorNameStart } from "../src/operator.mjs";

afterEach(() => {
  delete process.env.OASIS_OPERATOR_NAME;
});

test("the name is generic with no setting", () => {
  assert.equal(operatorName(), "the operator");
  assert.equal(operatorNameStart(), "The operator");
  assert.equal(operatorNameCaps(), "THE OPERATOR");
});

test("the instance value applies at each position in a sentence", () => {
  process.env.OASIS_OPERATOR_NAME = "Alex";
  assert.equal(operatorName(), "Alex");
  assert.equal(operatorNameStart(), "Alex");
  assert.equal(operatorNameCaps(), "ALEX");
});

test("a value that is not a plain name is ignored", () => {
  for (const bad of ["", "operator", "a: b", "<b>", "x".repeat(41)]) assert.equal(cleanOperatorName(bad), "");
  assert.equal(cleanOperatorName("Dr. O'Neil"), "Dr. O'Neil");
});
