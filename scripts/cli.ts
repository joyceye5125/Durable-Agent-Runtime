/**
 * Offline workflow for producing everything the web app replays.
 *
 *   npm run record-golden -- --scenario <id> | --pilot | --all   baseline run -> you review -> golden written to YAML
 *   npm run record -- --config <label,...> | --candidates        record candidate configs on every golden task
 *   npm run record-crash-paths                                   record what naive restarts see after each crash point
 *   npm run experiment -- crash [--n 200] [--seed 1]             run experiment 1 on recordings, persist the result
 *   npm run experiment -- eval                                   run experiment 4 on recordings, persist the result
 *
 * Both experiments print the sentence that belongs in the README results
 * table; --write-readme puts it there, so the table is never typed by hand.
 *
 * record-* commands call the real model (ANTHROPIC_API_KEY or OPENAI_API_KEY)
 * and write recordings/; responses already recorded for an identical request
 * are reused, so re-running is cheap.
 */
import fs from "node:fs";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { canonicalJSON } from "../server/core/canonical";
import { fold, trajectoryOf } from "../server/core/events";
import { runCrashExperiment } from "../server/experiments/crash";
import { MALFORMED_KINDS, MalformedInjectingLLM } from "../server/experiments/malformed";
import { latestEvalTable, runEvalExperiment } from "../server/eval/experiment";
import { endpointOk } from "../server/eval/trajectory";
import { CANDIDATES, getConfig } from "../server/llm/configs";
import { hasRecording, openAgentLLM, recordingPath, type LlmMode } from "../server/llm/recording";
import { CRASH_WINDOWS } from "../server/runtime/crash";
import { buildRuntime, createRun, prepareResume, type AgentFactory } from "../server/runtime/runs";
import { actionIdentity, isSideEffecting } from "../server/tools/registry";
import { goldenIsUsable } from "../server/eval/golden";
import { listScenarioIds, loadScenario, writeGolden } from "../server/scenarios";
import { Store } from "../server/store/store";

/** Run these first to validate the pipeline before recording all 30. */
const PILOT = [
  "incident_disk_full",
  "incident_bad_deploy",
  "incident_memory_leak",
  "incident_traffic_spike",
  "incident_db_connections",
  "incident_cert_expiry",
  "incident_dependency_hang",
  "incident_cache_and_capacity",
];

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const live: AgentFactory = (label, task) => openAgentLLM(label, task, "live");
const agentFor = (mode: LlmMode): AgentFactory => (label, task) => openAgentLLM(label, task, mode);

function requireKey() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    console.error("This command calls the model: set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
    process.exit(1);
  }
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const queue = items.slice();
  await Promise.all(
    Array.from({ length: Math.max(1, n) }, async () => {
      for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x);
    }),
  );
}

/**
 * Replaces one claim's cell in the README results table. The text written is
 * exactly what the experiment printed, so the table can only ever contain
 * numbers that were measured.
 */
function writeReadmeCell(claim: "C1" | "C4", result: string): void {
  // fileURLToPath, not URL.pathname: a path containing a space comes back percent-encoded.
  const file = fileURLToPath(new URL("../README.md", import.meta.url));
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const i = lines.findIndex((l) => l.startsWith(`| **${claim}** |`));
  if (i < 0) {
    console.log(`\n(could not find the ${claim} row in README.md; copy the cell above by hand)`);
    return;
  }
  const cells = lines[i].split("|");
  cells[cells.length - 2] = ` ${result} `;
  lines[i] = cells.join("|");
  fs.writeFileSync(file, lines.join("\n"));
  console.log(`\n✓ wrote the ${claim} result into README.md`);
}

/**
 * Properties that make a trajectory unusable as a yardstick, whatever a human
 * thinks of it. A failed call never happened, so it would put a phantom action
 * in the reference; a repeated action makes "the candidate repeated an action"
 * unmeasurable. Judgment about whether the run is sensible stays with the
 * person; these two are decidable, so they are decided here.
 */
function corruptionInGolden(calls: Array<{ tool: string; args: Record<string, unknown>; outcome: string }>): string[] {
  const problems: string[] = [];
  const failed = calls.filter((c) => c.outcome === "failed");
  if (failed.length) {
    problems.push(`${failed.length} call(s) the tool rejected (${failed.map((c) => c.tool).join(", ")}): an action that never happened cannot be part of the reference path`);
  }
  const counts = new Map<string, number>();
  for (const c of calls.filter((c) => isSideEffecting(c.tool))) {
    const key = actionIdentity(c.tool, c.args);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeated = [...counts].filter(([, n]) => n > 1);
  if (repeated.length) {
    problems.push(`repeated action(s) ${repeated.map(([k, n]) => `${k} ×${n}`).join(", ")}: a reference that repeats an action cannot measure a candidate that repeats one`);
  }
  return problems;
}

const short = (v: unknown, n = 110) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

async function recordGolden(store: Store) {
  const ids = flag("all")
    ? listScenarioIds("eval").filter((id) => !goldenIsUsable(loadScenario(id)))
    : flag("pilot")
      ? PILOT
      : [opt("scenario") ?? ""];
  if (!ids[0]) throw new Error("pass --scenario <id>, --pilot or --all");
  if (!process.stdin.isTTY) throw new Error("golden trajectories need a human decision: run this in an interactive terminal");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const failed: string[] = [];
  for (const id of ids) {
    try {
      await reviewOne(id);
    } catch (e) {
      const error = (e as Error).message;
      failed.push(id);
      console.log(`\n━━ ${id}\n✗ ${error}`);
      // Nothing after a quota wall can succeed; keep what is already recorded.
      if (/quota|daily|per day|TPD|billing/i.test(error)) {
        console.log("Stopping here: this looks like a quota or daily limit. Re-run later; recorded turns are kept.");
        break;
      }
    }
  }
  rl.close();
  if (failed.length) {
    console.log(`\n${failed.length} scenario(s) could not be recorded: ${failed.join(", ")}`);
    process.exitCode = 1;
  }

  async function reviewOne(id: string) {
    const scenario = loadScenario(id);
    if (flag("fresh") && hasRecording("baseline", id)) fs.rmSync(recordingPath("baseline", id));
    const mode: LlmMode = hasRecording("baseline", id) && !flag("live") ? "replay" : "live";
    if (mode === "live") requireKey();
    const agent = agentFor(mode);
    const runId = await createRun(store, { scenario: id, mode: "durable" }, { agent });
    await (await buildRuntime(store, runId, { agent })).drive();
    const state = fold(await store.listEvents(runId));
    const ledger = await store.listSideEffects(runId);
    const calls = trajectoryOf(state);

    console.log(`\n━━ ${id}  (${mode === "live" ? "recorded just now" : "from existing recording"})`);
    console.log(`task: ${scenario.task}\n`);
    for (const st of state.steps) {
      if (!st) continue;
      if (st.outcome?.kind === "rejected") console.log(`  ${String(st.step).padStart(2)}  REJECTED ${st.llm?.tool_name}: ${st.outcome.reason}`);
      else if (st.invoked) {
        const out = st.outcome?.kind === "committed" ? short(st.outcome.result) : st.outcome?.kind === "failed" ? `ERROR ${st.outcome.error}` : "";
        console.log(`  ${String(st.step).padStart(2)}  ${st.invoked.tool_name}(${canonicalJSON(st.invoked.args)})\n        → ${out}`);
      }
    }
    console.log(`\nfinal answer: ${state.finalAnswer ?? `<none: ${state.status} ${state.error ?? ""}>`}`);
    const ok = endpointOk(scenario, { status: state.status, finalAnswer: state.finalAnswer, ledger });
    console.log(`endpoint check: ${ok ? "PASS" : "FAIL"}  (mentions ${scenario.endpoint.answer_mentions.join(", ")}; required effects ${scenario.endpoint.required_effects.map((e) => e.tool).join(", ")})`);
    if (!ok) {
      console.log("✗ Baseline did not solve this task, so it has no golden trajectory. Fix the scenario or the baseline prompt");
      console.log("  (without leaking the solution into the prompt), then re-run with --fresh.");
      return;
    }
    const corrupt = corruptionInGolden(calls);
    if (corrupt.length) {
      console.log(`✗ Not offered as a golden:\n  - ${corrupt.join("\n  - ")}`);
      console.log("  A golden is the yardstick every candidate is scored against; these make the score mean nothing.");
      return;
    }
    const answer = (await rl.question(`Accept these ${calls.length} calls as the golden trajectory for ${id}? [y/N] `)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      writeGolden(id, calls.map((c) => ({ tool: c.tool, args: c.args })), state.finalAnswer ?? "");
      console.log(`✓ wrote golden_trajectory to scenarios/${id}.yaml`);
    } else {
      console.log("skipped");
    }
  }
}

async function recordConfigs(store: Store) {
  requireKey();
  const labels = flag("candidates") ? CANDIDATES.map((c) => c.label) : (opt("config") ?? "").split(",").filter(Boolean);
  if (!labels.length) throw new Error("pass --config <label,...> or --candidates");
  labels.forEach(getConfig);
  const tasks = opt("scenario") ? [opt("scenario")!] : listScenarioIds("eval").filter((id) => goldenIsUsable(loadScenario(id)));
  if (!tasks.length) throw new Error("no task has a reviewed golden trajectory yet; run record-golden first");
  const jobs = labels.flatMap((label) => tasks.map((task) => ({ label, task })));
  let done = 0;
  let stopped = "";
  const failures: Array<{ label: string; task: string; error: string }> = [];
  await pool(jobs, Number(opt("concurrency") ?? 2), async ({ label, task }) => {
    if (stopped) return;
    try {
      if (flag("fresh") && hasRecording(label, task)) fs.rmSync(recordingPath(label, task));
      const runId = await createRun(store, { scenario: task, mode: "durable", configLabel: label }, { agent: live });
      const out = await (await buildRuntime(store, runId, { agent: live })).drive();
      const n = trajectoryOf(fold(await store.listEvents(runId))).length;
      // A run can end "failed" without throwing — the loop catches the error
      // and logs RUN_FAILED. Printing only the status hides why, and a run
      // that failed at its first call leaves no recording to read back.
      const why = out.status === "failed" ? ` — ${out.error}` : "";
      console.log(`[${++done}/${jobs.length}] ${label.padEnd(20)} ${task.padEnd(32)} ${out.status} (${n} calls)${why}`);
    } catch (e) {
      // One job must not abandon the rest: every response already paid for is
      // on disk, and re-running resumes from there. A quota wall is different
      // — nothing after it can succeed, so stop instead of burning retries.
      const error = (e as Error).message;
      failures.push({ label, task, error });
      if (/quota|daily|per day|TPD|billing/i.test(error)) stopped = error;
      console.log(`[${++done}/${jobs.length}] ${label.padEnd(20)} ${task.padEnd(32)} FAILED ${error.slice(0, 90)}`);
    }
  });

  const incomplete = labels.filter((l) => tasks.some((t) => !hasRecording(l, t)));
  console.log(`\n${labels.length - incomplete.length}/${labels.length} configs fully recorded on all ${tasks.length} tasks.`);
  if (incomplete.length) console.log(`still incomplete (the eval table skips these): ${incomplete.join(", ")}`);
  if (stopped) {
    console.log(`\nStopped early — this looks like a quota or daily limit:\n  ${stopped}`);
    console.log("Every response already recorded is kept; re-run the same command later and it resumes.");
  } else if (failures.length) {
    console.log(`\n${failures.length} run(s) failed; re-run the same command to retry just those.`);
  }
  if (failures.length) process.exitCode = 1;
}

async function recordCrashPaths(store: Store) {
  requireKey();
  const scenario = opt("scenario") ?? listScenarioIds("crash")[0];
  const refId = await createRun(store, { scenario, mode: "durable" }, { agent: live });
  const ref = await (await buildRuntime(store, refId, { agent: live })).drive();
  const refState = fold(await store.listEvents(refId));
  const toolCalls = trajectoryOf(refState).length;
  console.log(`reference run: ${ref.status}, ${toolCalls} tool calls`);
  if (ref.status !== "completed") {
    const why = "error" in ref ? ref.error : ref.status;
    throw new Error(`baseline does not complete the crash scenario: ${why}`);
  }

  // A naive restart after a crash can see a world its first attempt already
  // changed, so it asks the model new questions. Record every crash point.
  for (let index = 0; index < toolCalls; index++) {
    for (const window of CRASH_WINDOWS) {
      const id = await createRun(store, { scenario, mode: "naive" }, { agent: live });
      await (await buildRuntime(store, id, { agent: live, crash: { window, target: { kind: "tool_call", index } } })).drive();
      await prepareResume(store, id);
      const out = await (await buildRuntime(store, id, { agent: live })).drive();
      console.log(`naive crash at call ${index} ${window}: ${out.status}`);
    }
  }
  const firstEffect = refState.steps.findIndex((s) => s?.invoked && ["restart_service", "scale_service", "page_oncall", "post_status"].includes(s.invoked.tool_name));
  for (const kind of MALFORMED_KINDS) {
    const injected: AgentFactory = (label, task) => {
      const base = live(label, task);
      return { config: base.config, llm: new MalformedInjectingLLM(base.llm, kind, Math.max(0, firstEffect), 1) };
    };
    const id = await createRun(store, { scenario, mode: "durable" }, { agent: injected });
    const out = await (await buildRuntime(store, id, { agent: injected })).drive();
    console.log(`malformed ${kind} then self-correct: ${out.status}`);
  }
}

async function experiment(store: Store) {
  const which = args[0];
  if (which === "crash") {
    const summary = await runCrashExperiment(store, {
      n: opt("n") ? Number(opt("n")) : undefined,
      seed: opt("seed") ? Number(opt("seed")) : undefined,
      scenario: opt("scenario"),
    });
    await store.insertCrashExperiment(summary.scenario, summary.n, summary);
    const d = summary.durable;
    const nv = summary.naive;
    const how =
      summary.coverage === "exhaustive"
        ? `every crash point once (${CRASH_WINDOWS.length} windows × ${summary.reference.toolCalls} tool calls = ${summary.n})`
        : `${summary.n} sampled crash points, seed ${summary.seed}`;
    console.log(`crash experiment on ${summary.scenario}: ${how}`);
    console.log(`durable: ${d.correct}/${d.trials} correct resumes (${d.correctPct.toFixed(1)}%), ${d.duplicateSideEffects} duplicate side effects`);
    console.log(
      `naive:   ${nv.trialsWithDuplicates}/${nv.exposed} trials that crashed after a side effect repeated one (${nv.duplicateRateWhenExposedPct?.toFixed(1) ?? "n/a"}%), ${nv.duplicateRows} duplicate rows, ${nv.unrecorded} unrecorded`,
    );
    for (const w of CRASH_WINDOWS) {
      const s = summary.byWindow[w];
      console.log(
        `  ${w}: durable ${s.durableCorrect}/${s.trials} correct  ·  naive repeated a side effect in ${s.naiveTrialsWithDuplicates}/${s.naiveExposed} of the trials that crashed after one`,
      );
    }
    console.log(`malformed outputs blocked before any side effect: ${summary.malformed.allBlocked ? "yes" : "NO"}`);
    const coverage =
      summary.coverage === "exhaustive"
        ? `${summary.n} crashes — every W1–W4 × tool-call point once, no sampling`
        : `${summary.n} sampled crashes, seed ${summary.seed}`;
    const cell = `${coverage} → **${d.correctPct.toFixed(1)}%** correct resume, **${d.duplicateSideEffects}** duplicate side effects. Naive baseline: **${nv.duplicateRateWhenExposedPct?.toFixed(1) ?? "n/a"}%** of the ${nv.exposed} crashes that landed after a side effect repeated one (${nv.duplicateRows} extra actions; ${nv.duplicateRatePct?.toFixed(1) ?? "n/a"}% of all ${nv.measured}${nv.unrecorded ? `, ${nv.unrecorded} unrecorded excluded` : ""}).`;
    console.log(`\nREADME C1 result cell:\n${cell}`);
    if (flag("write-readme")) writeReadmeCell("C1", cell);
    for (const c of summary.malformed.cases) console.log(`  ${c.kind}/${c.variant}: ${c.status}, rejected ${c.rejected}, side effects from rejected steps ${c.sideEffectRowsFromRejectedSteps}`);
  } else if (which === "eval") {
    const run = await runEvalExperiment(store);
    const table = await latestEvalTable(store);
    if (table.tasks.length === 0) {
      console.log("No scenario has a golden trajectory yet: run `npm run record-golden -- --pilot` first.");
      return;
    }
    console.log(`tasks with golden: ${table.tasks.length}; without: ${table.tasksWithoutGolden.length}`);
    console.log("change".padEnd(22), "endpoint".padEnd(9), "edit".padEnd(6), "extra".padEnd(6), "wrong→ok".padEnd(9), "path-only".padEnd(10), "endpoint-eval / trajectory-eval");
    for (const c of table.changes) {
      if (c.status !== "evaluated") {
        console.log(c.label.padEnd(22), c.missing?.length ? `not recorded (${c.missing.length} tasks missing)` : (c.error ?? "not recorded"));
        continue;
      }
      console.log(
        c.label.padEnd(22),
        `${c.endpointPass}/${c.total}`.padEnd(9),
        c.meanEditDist!.toFixed(2).padEnd(6),
        String(c.extraCalls).padEnd(6),
        String(c.wrongRecover).padEnd(9),
        String(c.pathOnlyRegressions).padEnd(10),
        `${c.endpointVerdict} / ${c.trajectoryVerdict}`,
      );
    }
    for (const c of run.changes.filter((x) => x.status === "error")) console.log(`error in ${c.label}: ${c.error}`);
    console.log(`\ncandidates the endpoint eval passes but the trajectory eval blocks: ${table.missedByEndpoint}`);
    console.log(`rows with a correct endpoint and a regressed path: ${table.pathOnlyRows}`);
    const evaluated = table.changes.filter((c) => c.label !== "baseline" && c.status === "evaluated");
    const cell = `${evaluated.length}${evaluated.length === CANDIDATES.length ? "" : ` of ${CANDIDATES.length}`} candidate changes on ${table.tasks.length} tasks → endpoint eval missed **${table.missedByEndpoint}**, trajectory eval caught **${table.missedByEndpoint}**. ${table.pathOnlyRows} task runs kept a correct answer on a worse path.${table.provisionalGolden.length ? ` (${table.provisionalGolden.length} golden trajectories still provisional.)` : ""}`;
    if (evaluated.length === 0) {
      console.log("\nNo candidate has been recorded yet, so nothing was measured. README left alone.");
      console.log("Record one with: npm run record -- --config <label>");
      return;
    }
    if (table.provisionalGolden.length > 0) {
      // Scoring against a predicted golden measures agreement with a guess,
      // not divergence from a real baseline run. It must never reach the table.
      console.log(`\n${table.provisionalGolden.length}/${table.tasks.length} golden trajectories are not from a reviewed baseline run of this exact scenario.`);
      console.log("Numbers scored against those are not a result: replace them with reviewed baseline runs first");
      console.log("  npm run record-golden -- --all        (README left alone until then)");
      return;
    }
    console.log(`\nREADME C4 result cell:\n${cell}`);
    if (flag("write-readme")) writeReadmeCell("C4", cell);
  } else {
    throw new Error("usage: npm run experiment -- crash|eval");
  }
}

const store = await Store.open({ log: () => {} });
const command = process.env.npm_lifecycle_event ?? "";
try {
  if (command === "record-golden") await recordGolden(store);
  else if (command === "record") await recordConfigs(store);
  else if (command === "record-crash-paths") await recordCrashPaths(store);
  else if (command === "experiment") await experiment(store);
  else throw new Error(`run through npm: record-golden | record | record-crash-paths | experiment`);
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await store.close();
}
