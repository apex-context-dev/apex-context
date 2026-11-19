import test from "node:test";
import assert from "node:assert/strict";
import * as users from "../src/users.js";
import { greet } from "../src/app.js";
test("new name exists, old name is gone", () => { assert.equal(typeof users.getUser, "function"); assert.equal(users.getUsr, undefined); });
test("behaviour unchanged", () => { assert.equal(users.getUser(2), "grace"); assert.equal(greet(2), "hello grace"); assert.equal(greet(9), "hello stranger"); });
