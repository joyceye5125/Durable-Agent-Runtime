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
  const endpointCaught = evaluated.filter((c) => c.endpointVerdict === "BLOCKED").length;
  const trajCaught = evaluated.filter((c) => c.trajectoryVerdict === "BLOCKED").length;

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
            <div className="big mono">
              {crash.n} crashes → <b className="good">{pct(crash.durable.correctPct)}</b> correct resume ·{" "}
              <b className={crash.durable.duplicateSideEffects === 0 ? "good" : "bad"}>{crash.durable.duplicateSideEffects}</b> duplicate side
              effects
            </div>
            <div className="sub mono">
              naive baseline: <b className="bad">{pct(crash.naive.duplicateRateWhenExposedPct)}</b> of the {crash.naive.exposed} trials that
              crashed after a side effect repeated one ({crash.naive.duplicateRows} extra actions · {pct(crash.naive.duplicateRatePct)} of all{" "}
              {crash.naive.measured} trials)
              {crash.naive.unrecorded > 0 && <> · {crash.naive.unrecorded} unrecorded, excluded</>}
            </div>
            <div className="sub mono muted">
              malformed model output: {crash.malformed.cases.length} injections, {crash.malformed.allBlocked ? "none reached a tool" : "SOME REACHED A TOOL"} ·
              scenario {crash.scenario} · seed {crash.seed} · {results?.crash[0]?.started_at.slice(0, 19).replace("T", " ")}
            </div>
          </>
        ) : (
          <div className="sub muted">
            {results?.seeding ? "measuring from the committed recordings…" : "Not measured yet: needs the baseline recording of the crash scenario (npm run record-crash-paths)."}
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
            <div className="big mono">
              {evaluated.length} candidate changes → endpoint eval missed <b className="bad">{table.missedByEndpoint}</b> · trajectory eval caught{" "}
              <b className="good">{table.missedByEndpoint}</b>
            </div>
            <div className="sub mono">
              {table.pathOnlyRows} task runs kept a correct answer on a worse path · endpoint eval blocked {endpointCaught}/{evaluated.length} changes,
              trajectory eval {trajCaught}/{evaluated.length}
            </div>
            <div className="sub mono muted">
              {table.tasks.length} tasks with reviewed golden trajectories
              {candidates.length > evaluated.length && <> · {candidates.length - evaluated.length} candidates not recorded</>}
            </div>
          </>
        ) : (
          <div className="sub muted">
            {results?.seeding
              ? "measuring from the committed recordings…"
              : "Not measured yet: needs reviewed golden trajectories and candidate recordings (npm run record-golden, npm run record)."}
          </div>
        )}
      </div>
    </section>
  );
}
