import { useEffect, useState } from "react";
import { api, sleep, type Meta, type Results } from "./api";
import { ConclusionBar } from "./ConclusionBar";
import { EvalTable } from "./EvalTable";
import { RunLab } from "./RunLab";

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [busy, setBusy] = useState<"crash" | "eval" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api.meta().then(setMeta, (e: Error) => setError(e.message));
    (async () => {
      // Right after a fresh boot the server measures once from the recordings.
      for (;;) {
        const r = await api.results();
        if (!alive) return;
        setResults(r);
        if (!r.seeding) return;
        await sleep(1500);
      }
    })().catch((e: Error) => setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  const rerunCrash = async () => {
    setBusy("crash");
    setError("");
    try {
      await api.runCrashExperiment();
      setResults(await api.results());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const rerunEval = async () => {
    setBusy("eval");
    setError("");
    try {
      const r = await api.runEval();
      if (r.errors.length) setError(r.errors.map((e) => `${e.label}: ${e.error}`).join("; "));
      setResults((prev) => (prev ? { ...prev, eval: r.table } : prev));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <main>
      <header className="top">
        <div>
          <h1>Durable Agent Runtime</h1>
          <p className="muted">
            An event-sourced LLM agent runtime: crash it mid-tool-call and the side effect still happens exactly once.
          </p>
        </div>
        {meta && (
          <div className="badges mono">
            <span className={`badge ${meta.llmMode}`} title={meta.llmMode === "replay" ? "recorded model output, no API calls" : "calling the model"}>
              {meta.llmMode.toUpperCase()}
            </span>
            <span className="badge">{meta.db}</span>
          </div>
        )}
      </header>
      {error && <div className="notice err">{error}</div>}
      <ConclusionBar results={results} busy={busy} onCrash={rerunCrash} onEval={rerunEval} />
      {meta && <RunLab meta={meta} autoDemo={!!results && !results.seeding && !busy} />}
      <EvalTable table={results?.eval ?? null} busy={busy === "eval"} onRerun={rerunEval} />
    </main>
  );
}
