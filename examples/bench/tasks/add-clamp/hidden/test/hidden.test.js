import test from "node:test";
import assert from "node:assert/strict";
import { clamp, double } from "../src/math.js";
test("clamp inside, below, above", () => { assert.equal(clamp(5, 0, 10), 5); assert.equal(clamp(-3, 0, 10), 0); assert.equal(clamp(99, 0, 10), 10); });
test("clamp at the edges", () => { assert.equal(clamp(0, 0, 10), 0); assert.equal(clamp(10, 0, 10), 10); });
test("double still works", () => assert.equal(double(3), 6));
