import { useEffect, useState } from "react";
import { api, type Meta } from "./api";
import { RunLab } from "./RunLab";

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.meta().then(setMeta, (e: Error) => setError(e.message));
  }, []);

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
    </main>
  );
}
