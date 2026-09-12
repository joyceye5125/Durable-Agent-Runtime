import { Fragment, useState } from "react";
import type { EvalTable as Table } from "./api";

export function EvalTable({ table, busy, onRerun }: { table: Table | null; busy: boolean; onRerun: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const n = table?.tasks.length ?? 0;
  // Before the candidates are recorded every row would repeat the same "not
  // recorded" cell; say it once instead.
  const anyEvaluated = !!table?.changes.some((c) => c.status === "evaluated");
  return (
    <section className="section">
      <div className="section-head row">
        <div>
          <h2>Endpoint eval vs trajectory eval</h2>
          <p className="muted">
            One row per config change, replayed on {n || "the"} tasks against the golden trajectory. Highlighted rows keep every answer
            correct while the path got worse.
          </p>
        </div>
        <button disabled={busy || !n} onClick={onRerun}>
          {busy ? "running…" : "Re-run eval"}
        </button>
      </div>
      {table && n > 0 && !anyEvaluated && (
        <div className="notice">
          No candidate recording yet — nothing has been measured. These are the {table.changes.length - 1} config changes that will be, once{" "}
          <code>npm run record -- --candidates</code> has run.
        </div>
      )}
      {table && table.provisionalGolden.length > 0 && (
        <div className="notice">
          {table.provisionalGolden.length}/{n} golden trajectories did not come from a reviewed baseline run of this exact scenario —
          still a prediction, or left behind by an edit to the task or world (<code>npm run record-golden -- --all</code> replaces them).
        </div>
      )}
      {!table ? null : n === 0 ? (
        <div className="notice">
          No task has a golden trajectory yet, so there is nothing to compare against. Record and review them with{" "}
          <code>npm run record-golden -- --pilot</code>, then <code>npm run record -- --candidates</code> (see README).
        </div>
      ) : (
        <div className="table-wrap">
          <table className="mono eval">
            <thead>
              <tr>
                <th>change</th>
                <th>endpoint pass</th>
                <th>mean edit dist</th>
                <th>extra calls</th>
                <th>wrong→recover</th>
                <th>path-only regressions</th>
                <th>endpoint eval</th>
                <th>trajectory eval</th>
              </tr>
            </thead>
            <tbody>
              {table.changes.map((c) => {
                if (c.status !== "evaluated") {
                  return (
                    <tr key={c.label} className="unrecorded">
                      <td title={c.description}>{c.label}</td>
                      <td colSpan={7}>
                        {anyEvaluated && <>not recorded{c.missing?.length ? ` (${c.missing.length}/${n} tasks missing)` : ""} — </>}
                        {c.description}
                      </td>
                    </tr>
                  );
                }
                const missed = c.label !== "baseline" && c.endpointVerdict === "PASS" && c.trajectoryVerdict === "BLOCKED";
                return (
                  <Fragment key={c.label}>
                    <tr className={`clickable ${missed ? "missed" : ""} ${c.label === "baseline" ? "base" : ""}`} onClick={() => setOpen(open === c.label ? null : c.label)}>
                      <td title={c.description}>
                        {c.label}
                        <div className="desc">{c.description}</div>
                      </td>
                      <td>
                        {c.endpointPass}/{c.total}
                      </td>
                      <td>{c.meanEditDist?.toFixed(2)}</td>
                      <td>{c.extraCalls}</td>
                      <td>{c.wrongRecover}</td>
                      <td>{c.pathOnlyRegressions}</td>
                      <td className={c.endpointVerdict === "PASS" ? "ok" : "bad"}>{c.endpointVerdict}</td>
                      <td className={c.trajectoryVerdict === "PASS" ? "ok" : "bad"}>
                        {c.trajectoryVerdict}
                        {missed && <div className="tag">missed by endpoint eval</div>}
                      </td>
                    </tr>
                    {open === c.label && (
                      <tr className="detail">
                        <td colSpan={8}>
                          <table>
                            <thead>
                              <tr>
                                <th>task</th>
                                <th>endpoint</th>
                                <th>path exact</th>
                                <th>edit</th>
                                <th>extra</th>
                                <th>wrong→recover</th>
                                <th>tokens</th>
                              </tr>
                            </thead>
                            <tbody>
                              {c.rows?.map((r) => (
                                <tr key={r.task} className={r.path_regressed ? "missed" : ""}>
                                  <td>{r.task}</td>
                                  <td className={r.endpoint_ok ? "ok" : "bad"}>{r.endpoint_ok ? "ok" : "FAIL"}</td>
                                  <td>{r.path_exact ? "yes" : "no"}</td>
                                  <td>{r.edit_dist}</td>
                                  <td>{r.extra_calls}</td>
                                  <td>{r.wrong_recover ? "yes" : ""}</td>
                                  <td>{r.tokens}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
