import { useEffect, useState } from "react";
import { api, type Meta, type Results } from "./api";
import { EvalTable } from "./EvalTable";
import { RunLab } from "./RunLab";

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [busy, setBusy] = useState<"eval" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.meta().then(setMeta, (e: Error) => setError(e.message));
    api.results().then(setResults, (e: Error) => setError(e.message));
  }, []);

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
            An LLM agent crashes after a tool already changed the world but before the result was logged. Resume naively and the
            side effect happens twice. This runtime makes it happen once — and evaluates agents by the path they took, not just the
            answer.
          </p>
        </div>
        {meta && (
          <div className="badges mono">
            <span className={`badge ${meta.llmMode}`}>
              {meta.llmMode === "replay" ? "REPLAY · recorded model output · no API calls" : "LIVE · calling the model"}
            </span>
            <span className="badge">db: {meta.db}</span>
          </div>
        )}
      </header>
      {error && <div className="notice err">{error}</div>}
      {meta && <RunLab meta={meta} autoDemo />}
      <EvalTable table={results?.eval ?? null} busy={busy === "eval"} onRerun={rerunEval} />
    </main>
  );
}
