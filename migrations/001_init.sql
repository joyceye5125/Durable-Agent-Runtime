-- Written in PostgreSQL dialect. The SQLite fallback rewrites the handful of
-- type names it lacks (see server/store/driver.ts); nothing else differs.

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  scenario     TEXT NOT NULL,
  mode         TEXT NOT NULL,                    -- 'durable' | 'naive'
  config_label TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running',  -- running|completed|failed|crashed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only authoritative run state. Append-only, never updated.
-- (runs.status above is a denormalised cache for listing; it is never read
-- back to decide what a run does next.)
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq    BIGINT NOT NULL,
  step   INT NOT NULL,
  kind   TEXT NOT NULL,
  data   JSONB NOT NULL,
  ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS events_run_step ON events (run_id, step);

-- Where exactly-once lands: one row per logical side effect, keyed by idem_key.
-- `args` is kept so mock read-tools can derive world state from the ledger
-- instead of from process memory.
CREATE TABLE IF NOT EXISTS side_effects (
  idem_key   TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  step       INT NOT NULL,
  tool       TEXT NOT NULL,
  args       JSONB NOT NULL,
  result     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Naive baseline only: no idempotency key, every execution inserts a row,
-- which is exactly what exposes duplicates.
CREATE TABLE IF NOT EXISTS naive_side_effects (
  id         BIGSERIAL PRIMARY KEY,
  run_id     TEXT NOT NULL,
  step       INT NOT NULL,
  tool       TEXT NOT NULL,
  args       JSONB NOT NULL,
  args_hash  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crash_experiments (
  id         BIGSERIAL PRIMARY KEY,
  scenario   TEXT NOT NULL,
  n          INT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  summary    JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id             BIGSERIAL PRIMARY KEY,
  change_label   TEXT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  endpoint_pass  INT,
  endpoint_total INT,
  traj_flagged   INT,
  verdict        TEXT                            -- PASS | BLOCKED
);

CREATE TABLE IF NOT EXISTS eval_results (
  eval_run_id   BIGINT REFERENCES eval_runs(id),
  task_id       TEXT NOT NULL,
  endpoint_ok   BOOLEAN NOT NULL,
  path_exact    BOOLEAN NOT NULL,
  edit_dist     INT NOT NULL,
  extra_calls   INT NOT NULL,
  wrong_recover BOOLEAN NOT NULL,
  tokens        INT NOT NULL,
  PRIMARY KEY (eval_run_id, task_id)
);
