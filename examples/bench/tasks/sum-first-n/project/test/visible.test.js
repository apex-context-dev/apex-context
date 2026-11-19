import test from "node:test";
import assert from "node:assert/strict";
import { sumFirst } from "../src/sum.js";
test("sum of zero elements is 0", () => assert.equal(sumFirst([4, 5], 0), 0));
