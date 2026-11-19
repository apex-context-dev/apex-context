import test from "node:test";
import assert from "node:assert/strict";
import { sumFirst } from "../src/sum.js";
test("sums the first n", () => { assert.equal(sumFirst([1, 2, 3, 4], 2), 3); assert.equal(sumFirst([5], 1), 5); });
test("n larger than the array", () => assert.equal(sumFirst([1, 2], 10), 3));
