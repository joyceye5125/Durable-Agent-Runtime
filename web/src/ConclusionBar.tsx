import type { Results } from "./api";

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : `${Number.isInteger(v) ? v : v.toFixed(1)}%`);

export function ConclusionBar({
  results,
  busy,
  onCrash,
  onEval,
}: {
  results: Results | null;
  busy: "crash" | "eval" | null;
  onCrash: () => void;
  onEval: () => void;
}) {
  const crash = results?.crash[0]?.summary;
  const table = results?.eval;
  const candidates = table?.changes.filter((c) => c.label !== "baseline") ?? [];
  const evaluated = candidates.filter((c) => c.status === "evaluated");

  return (
    <section className="cards">
      <div className="card">
        <div className="card-head">
          <span className="label">C1 · crash recovery</span>
          <button disabled={!!busy || results?.seeding || !crash} onClick={onCrash}>
            {busy === "crash" ? "running…" : "Run again"}
          </button>
        </div>
        {crash ? (
          <>
            <div className="stat">
              <b className="good">{pct(crash.durable.correctPct)}</b>
              <span>
                correct resume, <b className={crash.durable.duplicateSideEffects === 0 ? "good" : "bad"}>{crash.durable.duplicateSideEffects}</b>{" "}
                duplicate side effects
              </span>
            </div>
            <div className="sub">
              Naive baseline repeated one in <b className="bad">{pct(crash.naive.duplicateRateWhenExposedPct)}</b> of the {crash.naive.exposed}{" "}
              crashes that landed after a side effect had already happened.
            </div>
            <div
              className="meta mono muted"
              title={`${crash.naive.duplicateRows} extra actions · ${pct(crash.naive.duplicateRatePct)} of all ${crash.naive.measured} trials${crash.seed === null ? "" : ` · seed ${crash.seed}`}`}
            >
              {crash.n} crashes ({crash.coverage === "exhaustive" ? "every W1–W4 × tool-call point, no sampling" : `sampled, seed ${crash.seed}`}) ·{" "}
              {crash.scenario} ·{" "}
              {crash.malformed.allBlocked ? `${crash.malformed.cases.length} malformed outputs, none reached a tool` : "SOME MALFORMED OUTPUT REACHED A TOOL"}
            </div>
          </>
        ) : (
          <div className="sub muted">
            {results?.seeding
              ? "measuring from the committed recordings…"
              : "Not measured yet — needs the crash-scenario recording (npm run record-crash-paths)."}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <span className="label">C4 · trajectory eval</span>
          <button disabled={!!busy || results?.seeding || !table?.tasks.length} onClick={onEval}>
            {busy === "eval" ? "running…" : "Run again"}
          </button>
        </div>
        {table && evaluated.length > 0 ? (
          <>
            <div className="stat">
              <b className={table.missedByEndpoint > 0 ? "bad" : "good"}>{table.missedByEndpoint}</b>
              <span>
                of {evaluated.length} config changes passed the endpoint eval and were blocked by the trajectory eval
              </span>
            </div>
            <div className="sub">
              <b>{table.pathOnlyRows}</b> task runs kept a correct final answer on a worse path.
            </div>
            <div className="meta mono muted">
              {table.tasks.length} tasks with reviewed golden trajectories
              {candidates.length > evaluated.length && <> · {candidates.length - evaluated.length} candidates not recorded</>}
            </div>
          </>
        ) : (
          <div className="sub muted">
            {results?.seeding
              ? "measuring from the committed recordings…"
              : "Not measured yet — needs golden trajectories and candidate recordings (npm run record-golden, npm run record)."}
          </div>
        )}
      </div>
    </section>
  );
}
