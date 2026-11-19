import test from "node:test";
import assert from "node:assert/strict";
import { double } from "../src/math.js";
test("double", () => assert.equal(double(4), 8));
