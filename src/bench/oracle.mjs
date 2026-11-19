// Built-in oracle arm: copies <taskDir>/reference over the workspace.
import fs from "node:fs";
import path from "node:path";
import { overlay } from "./util.mjs";
const [, , taskDir, cwd] = process.argv;
if (!taskDir || !cwd) { console.error("usage: oracle.mjs <taskDir> <cwd>"); process.exit(2); }
const ref = path.join(taskDir, "reference");
if (!fs.existsSync(ref)) { console.error("no reference/ in task"); process.exit(1); }
overlay(ref, cwd);
console.log("ORACLE DONE");
