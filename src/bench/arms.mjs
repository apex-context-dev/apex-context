// Built-in demo arms. They need no API key. Real arms come from --arms-file.
import path from "node:path";
import { normalizeArm } from "./tasks.mjs";

const SRC = path.dirname(new URL(import.meta.url).pathname);
export const BENCH_SRC = SRC;

export const builtinArms = () => Object.fromEntries([
  { name: "oracle", description: "Applies the task's reference/ solution, then says DONE. Upper bound; proves the pipeline.", command: "node {benchSrc}/oracle.mjs {taskDir} {cwd}", claimedDone: { type: "regex", pattern: "^ORACLE DONE" } },
  { name: "noop", description: "Does nothing and says nothing. Lower bound; claimedDone is n/a.", command: "true" },
  { name: "liar", description: "Does nothing and claims DONE. Shows how false-ready is counted.", command: "echo 'DONE: all finished'", claimedDone: { type: "regex", pattern: "DONE" } },
].map((a) => [a.name, normalizeArm(a)]));
