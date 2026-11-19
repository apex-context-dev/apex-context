import test from "node:test";
import assert from "node:assert/strict";
import { greet } from "../src/app.js";
test("greet", () => assert.equal(greet(1), "hello ada"));
