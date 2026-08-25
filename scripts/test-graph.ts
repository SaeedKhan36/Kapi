import { validateTaskGraph, readyTasks, TaskGraphSchema, type TaskGraph } from "../packages/protocol/src/index.ts";

const base = { goal: "g", contract: { summary: "s", endpoints: [], tables: [], conventions: [] } };
const t = (id: string, dependsOn: string[] = []) => ({
  id, title: "t-" + id, instruction: "do the thing properly", role: "backend" as const,
  dependsOn, touches: [], acceptance: [],
});

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra ? "  | " + extra : ""}`);
  if (!cond) failures++;
};

// 1. clean DAG (diamond)
const diamond: TaskGraph = { ...base, tasks: [t("a"), t("b", ["a"]), t("c", ["a"]), t("d", ["b", "c"])] };
check("clean diamond has no problems", validateTaskGraph(diamond).length === 0,
  JSON.stringify(validateTaskGraph(diamond)));

// 2. cycle
const cyc: TaskGraph = { ...base, tasks: [t("a", ["c"]), t("b", ["a"]), t("c", ["b"])] };
const cycProbs = validateTaskGraph(cyc);
check("3-node cycle detected", cycProbs.some(p => p.kind === "cycle"), JSON.stringify(cycProbs));

// 3. self-cycle
const self: TaskGraph = { ...base, tasks: [t("a", ["a"])] };
check("self-cycle detected", validateTaskGraph(self).some(p => p.kind === "cycle"),
  JSON.stringify(validateTaskGraph(self)));

// 4. dangling dep
const dangling: TaskGraph = { ...base, tasks: [t("a", ["ghost"])] };
check("dangling dep detected", validateTaskGraph(dangling).some(p => p.kind === "unknown-dep"));

// 5. duplicate id
const dup: TaskGraph = { ...base, tasks: [t("a"), t("a")] };
check("duplicate id detected", validateTaskGraph(dup).some(p => p.kind === "duplicate-id"));

// 6. readyTasks gating
check("only 'a' ready initially", readyTasks(diamond, new Set()).map(x => x.id).join() === "a");
check("b,c ready after a", readyTasks(diamond, new Set(["a"])).map(x => x.id).join() === "b,c");
check("d not ready with only b", !readyTasks(diamond, new Set(["a","b"])).some(x => x.id === "d"));
check("d ready after b+c", readyTasks(diamond, new Set(["a","b","c"])).map(x => x.id).join() === "d");

// 7. zod rejects bad ids
check("zod rejects uppercase task id",
  !TaskGraphSchema.safeParse({ ...base, tasks: [{ ...t("A"), id: "BadID" }] }).success);

// 8. large graph terminates (no infinite loop)
const wide: TaskGraph = { ...base, tasks: Array.from({length: 300}, (_, i) => t(`n${i}`, i > 0 ? [`n${i-1}`] : [])) };
const start = Date.now();
check("300-node chain validates fast", validateTaskGraph(wide).length === 0 && Date.now() - start < 1000,
  `${Date.now() - start}ms`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
