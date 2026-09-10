import fs from "node:fs";
import path from "node:path";
import { openDriver, pgToSqliteDdl, type Driver, type OpenOptions, type Row } from "./driver";
import type { EventKind, NewEvent, RunEvent, RunMode } from "../core/events";

export type RunStatus = "running" | "completed" | "failed" | "crashed";

export interface RunRow {
  id: string;
  scenario: string;
  mode: RunMode;
  config_label: string;
  status: RunStatus;
  created_at: string;
}

export interface SideEffectRow {
  idem_key: string;
  run_id: string;
  step: number;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  created_at: string;
}

export interface NaiveSideEffectRow {
  id: number;
  run_id: string;
  step: number;
  tool: string;
  args: Record<string, unknown>;
  args_hash: string;
  created_at: string;
}

export interface EvalRunRow {
  id: number;
  change_label: string;
  started_at: string;
  endpoint_pass: number;
  endpoint_total: number;
  traj_flagged: number;
  verdict: "PASS" | "BLOCKED";
}

export interface EvalResultRow {
  eval_run_id: number;
  task_id: string;
  endpoint_ok: boolean;
  path_exact: boolean;
  edit_dist: number;
  extra_calls: number;
  wrong_recover: boolean;
  tokens: number;
}

export interface CrashExperimentRow {
  id: number;
  scenario: string;
  n: number;
  started_at: string;
  summary: unknown;
}

const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;
const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const bool = (v: unknown) => v === true || v === 1 || v === "t";

/**
 * Thin, domain-shaped access layer. Every SQL statement in the project lives
 * here; it is dialect-neutral apart from what driver.ts rewrites.
 */
export class Store {
  constructor(readonly driver: Driver) {}

  static async open(opts?: OpenOptions): Promise<Store> {
    const store = new Store(await openDriver(opts));
    await store.migrate();
    return store;
  }

  async migrate(): Promise<void> {
    const file = path.resolve(import.meta.dirname, "../../migrations/001_init.sql");
    const sql = fs.readFileSync(file, "utf8");
    await this.driver.exec(this.driver.kind === "sqlite" ? pgToSqliteDdl(sql) : sql);
  }

  close(): Promise<void> {
    return this.driver.close();
  }

  private q<T extends Row = Row>(sql: string, params?: unknown[]) {
    return this.driver.query<T>(sql, params);
  }

  // ---- runs --------------------------------------------------------------

  async createRun(r: { id: string; scenario: string; mode: RunMode; configLabel: string }): Promise<void> {
    await this.q(`INSERT INTO runs (id, scenario, mode, config_label) VALUES ($1, $2, $3, $4)`, [
      r.id,
      r.scenario,
      r.mode,
      r.configLabel,
    ]);
  }

  async setRunStatus(id: string, status: RunStatus): Promise<void> {
    await this.q(`UPDATE runs SET status = $2 WHERE id = $1`, [id, status]);
  }

  async getRun(id: string): Promise<RunRow | undefined> {
    const rows = await this.q(`SELECT * FROM runs WHERE id = $1`, [id]);
    return rows[0] ? toRun(rows[0]) : undefined;
  }

  // ---- events ------------------------------------------------------------

  async appendEvent(runId: string, e: NewEvent): Promise<RunEvent> {
    // seq is allocated inside the INSERT so two writers can never both claim
    // the same slot; the (run_id, seq) primary key would reject the loser.
    const rows = await this.q(
      `INSERT INTO events (run_id, seq, step, kind, data)
       SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4 FROM events WHERE run_id = $1
       RETURNING seq, ts`,
      [runId, e.step, e.kind, json(e.data)],
    );
    return { run_id: runId, seq: Number(rows[0].seq), step: e.step, kind: e.kind, data: e.data, ts: ts(rows[0].ts) } as RunEvent;
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    const rows = await this.q(`SELECT * FROM events WHERE run_id = $1 ORDER BY seq`, [runId]);
    return rows.map(
      (r) =>
        ({
          run_id: String(r.run_id),
          seq: Number(r.seq),
          step: Number(r.step),
          kind: r.kind as EventKind,
          data: parse(r.data),
          ts: ts(r.ts),
        }) as RunEvent,
    );
  }

  // ---- side-effect ledgers ----------------------------------------------

  /**
   * Exactly-once primitive. Returns the row that owns this idem_key: either
   * the one just inserted, or the one a previous (possibly crashed) attempt
   * already wrote — in which case the side effect is NOT performed again.
   */
  async recordSideEffect(r: {
    idemKey: string;
    runId: string;
    step: number;
    tool: string;
    args: Record<string, unknown>;
    result: unknown;
  }): Promise<{ inserted: boolean; result: unknown }> {
    const inserted = await this.q(
      `INSERT INTO side_effects (idem_key, run_id, step, tool, args, result)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idem_key) DO NOTHING
       RETURNING result`,
      [r.idemKey, r.runId, r.step, r.tool, json(r.args), json(r.result)],
    );
    if (inserted[0]) return { inserted: true, result: parse(inserted[0].result) };
    const existing = await this.q(`SELECT result FROM side_effects WHERE idem_key = $1`, [r.idemKey]);
    return { inserted: false, result: parse(existing[0].result) };
  }

  async listSideEffects(runId: string): Promise<SideEffectRow[]> {
    const rows = await this.q(`SELECT * FROM side_effects WHERE run_id = $1 ORDER BY step`, [runId]);
    return rows.map((r) => ({
      idem_key: String(r.idem_key),
      run_id: String(r.run_id),
      step: Number(r.step),
      tool: String(r.tool),
      args: parse(r.args),
      result: parse(r.result),
      created_at: ts(r.created_at),
    }));
  }

  async countAllSideEffects(): Promise<number> {
    const a = await this.q(`SELECT COUNT(*) AS n FROM side_effects`);
    const b = await this.q(`SELECT COUNT(*) AS n FROM naive_side_effects`);
    return Number(a[0].n) + Number(b[0].n);
  }

  async insertNaiveSideEffect(r: {
    runId: string;
    step: number;
    tool: string;
    args: Record<string, unknown>;
    argsHash: string;
  }): Promise<void> {
    await this.q(`INSERT INTO naive_side_effects (run_id, step, tool, args, args_hash) VALUES ($1, $2, $3, $4, $5)`, [
      r.runId,
      r.step,
      r.tool,
      json(r.args),
      r.argsHash,
    ]);
  }

  async listNaiveSideEffects(runId: string): Promise<NaiveSideEffectRow[]> {
    const rows = await this.q(`SELECT * FROM naive_side_effects WHERE run_id = $1 ORDER BY id`, [runId]);
    return rows.map((r) => ({
      id: Number(r.id),
      run_id: String(r.run_id),
      step: Number(r.step),
      tool: String(r.tool),
      args: parse(r.args),
      args_hash: String(r.args_hash),
      created_at: ts(r.created_at),
    }));
  }

  // ---- experiments -------------------------------------------------------

  async insertCrashExperiment(scenario: string, n: number, summary: unknown): Promise<number> {
    const rows = await this.q(`INSERT INTO crash_experiments (scenario, n, summary) VALUES ($1, $2, $3) RETURNING id`, [
      scenario,
      n,
      json(summary),
    ]);
    return Number(rows[0].id);
  }

  async listCrashExperiments(limit = 20): Promise<CrashExperimentRow[]> {
    const rows = await this.q(`SELECT * FROM crash_experiments ORDER BY id DESC LIMIT $1`, [limit]);
    return rows.map((r) => ({
      id: Number(r.id),
      scenario: String(r.scenario),
      n: Number(r.n),
      started_at: ts(r.started_at),
      summary: parse(r.summary),
    }));
  }

  async insertEvalRun(r: Omit<EvalRunRow, "id" | "started_at">, results: Omit<EvalResultRow, "eval_run_id">[]): Promise<number> {
    const rows = await this.q(
      `INSERT INTO eval_runs (change_label, endpoint_pass, endpoint_total, traj_flagged, verdict)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [r.change_label, r.endpoint_pass, r.endpoint_total, r.traj_flagged, r.verdict],
    );
    const id = Number(rows[0].id);
    for (const x of results) {
      await this.q(
        `INSERT INTO eval_results (eval_run_id, task_id, endpoint_ok, path_exact, edit_dist, extra_calls, wrong_recover, tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, x.task_id, x.endpoint_ok, x.path_exact, x.edit_dist, x.extra_calls, x.wrong_recover, x.tokens],
      );
    }
    return id;
  }

  async listEvalRuns(limit = 200): Promise<EvalRunRow[]> {
    const rows = await this.q(`SELECT * FROM eval_runs ORDER BY id DESC LIMIT $1`, [limit]);
    return rows.map((r) => ({
      id: Number(r.id),
      change_label: String(r.change_label),
      started_at: ts(r.started_at),
      endpoint_pass: Number(r.endpoint_pass),
      endpoint_total: Number(r.endpoint_total),
      traj_flagged: Number(r.traj_flagged),
      verdict: r.verdict as "PASS" | "BLOCKED",
    }));
  }

  async listEvalResults(evalRunIds: number[]): Promise<EvalResultRow[]> {
    if (evalRunIds.length === 0) return [];
    const placeholders = evalRunIds.map((_, i) => `$${i + 1}`).join(", ");
    const rows = await this.q(`SELECT * FROM eval_results WHERE eval_run_id IN (${placeholders}) ORDER BY task_id`, evalRunIds);
    return rows.map((r) => ({
      eval_run_id: Number(r.eval_run_id),
      task_id: String(r.task_id),
      endpoint_ok: bool(r.endpoint_ok),
      path_exact: bool(r.path_exact),
      edit_dist: Number(r.edit_dist),
      extra_calls: Number(r.extra_calls),
      wrong_recover: bool(r.wrong_recover),
      tokens: Number(r.tokens),
    }));
  }
}

function toRun(r: Row): RunRow {
  return {
    id: String(r.id),
    scenario: String(r.scenario),
    mode: r.mode as RunMode,
    config_label: String(r.config_label),
    status: r.status as RunStatus,
    created_at: ts(r.created_at),
  };
}
