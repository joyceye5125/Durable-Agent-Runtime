# Durable Agent Runtime

**If an LLM agent crashes after a tool has changed the world but before the result was logged, a naive resume performs that side effect twice. This runtime makes it happen exactly once, and it evaluates agents by the path they took as well as the answer they gave.**

## Results

Both claims are experiments you can run, not assertions in a README. The numbers come from `npm run experiment`, which replays committed recordings; the cells stay empty until that has run against real recorded model output.

| | Claim | How it is measured | Result |
|---|---|---|---|
| **C1** | Crash the agent in any of the four commit windows and a durable resume reproduces the crash-free run with no repeated side effect. A from-scratch baseline repeats them. | 200 seeded crashes spread over W1–W4 on a 10-call incident. Each trial resumes a durable run and a naive run from the same crash point, then compares the final answer and the side-effect ledger against a crash-free reference. | _pending recording_ |
| **C4** | Trajectory-level eval catches config changes that keep every final answer correct while the path degrades. Endpoint-level eval passes them. | 15 candidate changes (model swaps, prompt edits, a smaller step budget) × 30 incidents, each replayed against the same deterministic tools and scored against a reviewed golden trajectory. | _pending recording_ |

Two things are worth separating. That one `idem_key` can produce at most one ledger row is structural, not statistical: it is the table's primary key, and `test/resume-after-crash-uses-only-the-event-log.test.ts` pins it for all four windows without needing a model. What the experiment measures is whether the whole loop preserves that under crashes, and how often the from-scratch baseline duplicates — the second number is purely empirical and depends on where the crashes land.

**Status:** the golden trajectories in `scenarios/` are currently provisional predictions (`golden_source: predicted`), pending replacement by reviewed baseline runs via `npm run record-golden -- --all`. The tests, the runtime and the eval pipeline are complete and run today; what is missing is the recorded model output that turns the pipeline into numbers.

## Reproduce in 60 seconds

Open the Repl. There is no API key to set and nothing to configure. The page runs in **replay mode**, where every model response comes from `recordings/`. The badge in the top-right corner says so.

1. **Top cards.** On a fresh database the server runs both experiments once on boot. Click **Run again** on either card to re-run it (the crash experiment uses a new random seed each time).
2. **Middle, the W3 demo.** It starts on its own once the cards are ready. The same long incident runs twice, first `durable` and then `naive`. Each run crashes at **W3** on `page_oncall`: the page has already been sent, but the log never recorded it. Then both runs resume. Watch the right-hand ledger in each panel. The durable ledger keeps one row per page, and its W3 row is marked as reused through `ON CONFLICT`. The naive ledger gains red `DUPLICATE` rows: the on-call engineer got paged twice.
3. **Manual controls.** Pick a mode, a window (W1–W4) and a target, press **Start**, press **Crash** while the run is going, then press **Resume**.
4. **Bottom table.** Each row is one candidate change. The highlighted rows pass the endpoint eval and are blocked by the trajectory eval. Click a row to see its per-task scores.

## Design

### A run is an append-only event log

```
RUN_STARTED → LLM_RESPONDED → TOOL_INVOKED → TOOL_COMMITTED → LLM_RESPONDED → … → RUN_COMPLETED
                               (intent)       (result)
                  └─ TOOL_REJECTED (invalid call, never executed)   TOOL_FAILED   RUN_FAILED
```

The `events` table is the only authority on what a run has done. `Runtime` keeps nothing of its own. Its in-memory state is `fold(events)`, and it chooses the next action from that fold: call the LLM, dispatch a tool call that was logged but never started, re-invoke a call that was started but never committed, or finish. Starting a run, resuming it after a crash and replaying it all go through this one code path (`server/core/events.ts`, `server/runtime/runtime.ts`).

### Two-phase tool calls plus an idempotency key

```
idem_key = sha256(run_id | step | tool | canonicalJSON(args))

  LLM picks tool ──W1── append TOOL_INVOKED{idem_key} ──W2── tool runs ──W3── append TOOL_COMMITTED ──W4──
                                                              │
                                   INSERT INTO side_effects … ON CONFLICT (idem_key) DO NOTHING RETURNING *
                                   (conflict = already happened → return the stored result, do nothing)
```

On resume, any step that has `TOOL_INVOKED` but no `TOOL_COMMITTED` is re-invoked with the **same** key. A crash in W3 means the ledger row already exists, so the re-invocation hits `ON CONFLICT` and returns the stored result. A crash in W2 means the row doesn't exist yet, so the tool runs once. The naive baseline has no ledger and no log recovery: it restarts the task and writes `naive_side_effects` on every execution.

Before anything is logged, every model tool call goes through the tool registry and a schema check. A hallucinated tool, invalid JSON or arguments that fail the schema produce `TOOL_REJECTED` with a structured reason, and that reason goes back to the model. No `TOOL_INVOKED` is written and no tool runs. After `max_invalid_retries` (2) consecutive rejections, the run fails cleanly.

The mock tools are pure functions of the scenario file plus this run's side-effect ledger. That means world state lives in the database. For example, once `restart_service(session-cache)` is in the ledger, later `get_metric` reads return recovered values.

### Two kinds of replay

```
faithful:    events ──▶ Runtime (LLM = logged responses, tools = logged results) ──▶ events'   assert events' == events
divergence:  scenario + recorded model output for config X ──▶ Runtime (real deterministic tools) ──▶ trajectory_X vs golden
```

- **Faithful replay** (`GET /api/runs/:id/replay?faithful=true`) re-drives the real loop against the log. No model is called and no tool runs. It then diffs the events it produced against the originals. When they match, the loop is shown to be a pure function of its inputs, which is the property both resume and eval depend on.
- **Divergence replay** is how the eval runs. Each candidate config runs every task against the same deterministic tools, so any difference from the golden trajectory can only come from the config change.

### Trajectory scoring

A trajectory is the ordered list of executed tool calls, with canonical (key-sorted) args, plus the final answer.

| metric | meaning |
|---|---|
| `endpoint_ok` | run completed, final answer mentions the key facts, and the required remediation is in the side-effect ledger |
| `path_exact` | identical calls and args to the golden trajectory |
| `edit_dist` | Levenshtein distance to golden over call tokens. Side-effecting calls are compared on the args that identify the action (which service, how many replicas); read-only calls and free-text messages by tool name only, so rewording a query or a page is not a regression. |
| `extra_calls` | calls not in the LCS alignment with golden (redundant or repeated) |
| `wrong_recover` | a side-effecting call that golden never makes, followed later by one it does |

**Path regression** means `endpoint_ok` is true and at least one of these holds: `edit_dist > 0`, `extra_calls > 0` or `wrong_recover`. This is exactly the case an endpoint eval can't see.

## Honest boundaries

- **Exactly-once holds here because the mock side effect *is* the ledger insert.** Against a real external system, exactly-once is only as strong as that system's own idempotency: you forward `idem_key` as its idempotency key, or you reconcile. Without that, this design gives you at-least-once with deduplication on our side.
- **The crashes are injected at the application layer.** Throwing `CrashInjected` at W1–W4 is not a real `kill -9` or a power loss. It doesn't model torn writes or un-fsynced commits, which are the database's durability job. To keep the test honest, a crashed `Runtime` refuses further use, and every resume builds a new instance from the database alone. `test/resume-after-crash-uses-only-the-event-log.test.ts` also closes the DB connection before resuming.
- **Determinism comes from recordings, not from the model.** `temperature=0` does not guarantee identical outputs. Replay is deterministic because model responses are read back from `recordings/`, keyed by the exact request. A request that was never recorded is a loud error, never a fallback.
- **A naive restart can see a world its first attempt already changed** (for example, latency that has already recovered), so it can take a different path. Those conversations are recorded by `npm run record-crash-paths`. Any trial whose conversation is missing is reported as *unrecorded* and excluded; it is never guessed. The naive duplicate rate depends on where the crashes land and on how the model reacts, so it is a measurement, not a constant.
- **The trajectory eval compares against one golden path.** A different path that is equally good still counts as a difference. Comparing read-only calls by tool name only reduces this effect but doesn't remove it. That's why every golden trajectory is a reviewed baseline run and not a hand-written ideal.
- Single tenant, one run at a time, no auth. The value here is the reliability of a single run, not orchestration.

## How this differs from Temporal and LangGraph

Temporal and LangGraph are general workflow engines. Temporal gets durable execution by requiring deterministic workflow code; LangGraph checkpoints graph state. This project goes narrower, into the parts that are specific to LLM agents:

- **The control flow is chosen by a non-deterministic model.** Resume and replay therefore treat the model's output as a logged input, instead of requiring the code to be deterministic.
- **Regression detection works on the trajectory, not only the endpoint.**
- **Hallucinated or malformed tool calls are isolated before they can cause a side effect.**

## Producing the numbers

Recordings are produced by real runs. They are never written by hand. You need an `ANTHROPIC_API_KEY` (defaults: `claude-sonnet-4-5` as the strong model and `claude-haiku-4-5` as the weak one) or an `OPENAI_API_KEY` (defaults: `gpt-4.1` / `gpt-4.1-mini`). Both pairs accept `temperature=0`. You can override them with `STRONG_MODEL` and `WEAK_MODEL`.

```bash
npm install
export ANTHROPIC_API_KEY=...            # or OPENAI_API_KEY

# 1. Golden trajectories: the baseline runs live, you read the trajectory, you answer y/N.
#    Refused when the baseline did not solve the task (fix the scenario, never leak the answer into the prompt).
npm run record-golden -- --pilot       # 8 tasks first, to validate the pipeline
npm run record-golden -- --all         # the rest

# 2. Candidate changes on every task that has a golden trajectory
npm run record -- --candidates --concurrency 4

# 3. Crash scenario: the reference run, every naive crash point, malformed-output recoveries
npm run record-crash-paths

# 4. Measure (replay mode, no key used) and persist; this prints the numbers for the Results table
npm run experiment -- crash --n 200
npm run experiment -- eval

git add recordings scenarios && git commit -m "Record baseline, candidates and crash paths"
```

A recording stores the config hash it was made with. Editing a prompt later makes the old recording stale, and replay refuses to use it rather than mixing configs.

## Running it

```bash
npm install
npm start          # builds the page and serves on :3000 (PORT to override)
npm run dev        # server with Vite middleware
npm test           # vitest; set TEST_DATABASE_URL to run the same tests on Postgres
npm run typecheck
```

`DATABASE_URL` selects PostgreSQL (the Replit database). If it is unset, the server falls back to a local SQLite file at `data/runtime.sqlite` and says so on startup. Migrations run automatically on boot and are idempotent.

## Tests

| test | invariant |
|---|---|
| `idempotency-same-key-executes-side-effect-once` | the same `idem_key` executed twice leaves exactly one `side_effects` row |
| `resume-after-crash-uses-only-the-event-log` | for W1–W4, a crashed run resumed by a new Runtime on a new DB connection ends with the crash-free result and ledger; naive W3 duplicates |
| `invalid-tool-calls-never-reach-tools` | hallucinated tool, bad JSON or schema violation: no `TOOL_INVOKED`, no side effect; too many retries fail cleanly |
| `run-state-is-a-fold-of-the-event-log` | a run's full state and trajectory can be rebuilt from its events alone |
| `faithful-replay-reproduces-the-log` | re-driving a crashed and resumed run from its log reproduces it event for event |
| `trajectory-eval-flags-path-regressions-endpoint-eval-misses` | redundant and wrong-then-recover paths are blocked by the trajectory eval and passed by the endpoint eval |

The tests drive the real runtime with a scripted model stand-in (`test/helpers/harness.ts`). It exists only in tests and never produces recordings.

## Layout

```
migrations/001_init.sql      schema (Postgres dialect; SQLite rewrite lives in server/store/driver.ts)
server/core/events.ts        event types, fold, next-action derivation
server/runtime/              Runtime (agent loop), crash injection, DB-backed tool executor
server/tools/registry.ts     tool schemas, validation, deterministic mock tools
server/llm/                  provider adapters, recording/replay, baseline + 15 candidate configs
server/experiments/crash.ts  experiment 1 (C1) + malformed-output batch
server/eval/                 trajectory scoring, experiment 4 (C4)
server/replay.ts             faithful replay
scenarios/*.yaml             30 eval incidents + 1 long crash incident
recordings/<config>/<task>.json   committed model output
scripts/cli.ts               record-golden, record, record-crash-paths, experiment
web/src/                     the page (React, hand-written CSS)
```
