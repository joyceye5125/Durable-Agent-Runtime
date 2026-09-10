import { canonicalJSON, sha256 } from "../core/canonical";
import { toolSpecs, type ToolSpec } from "../tools/registry";

export type Provider = "anthropic" | "openai";

export interface AgentConfig {
  label: string;
  description: string;
  modelTier: "strong" | "weak";
  systemPrompt: string;
  toolDescriptions?: Record<string, string>;
  maxSteps: number;
  maxInvalidRetries: number;
}

export interface ResolvedConfig extends AgentConfig {
  provider: Provider;
  model: string;
  /** Always 0: in divergence replay the config change must be the only variable, not sampling noise. */
  temperature: 0;
  tools: ToolSpec[];
  hash: string;
}

// Sampling must be controllable (temperature=0), which rules out models that
// reject sampling parameters. Override with STRONG_MODEL / WEAK_MODEL.
const DEFAULT_MODELS: Record<Provider, { strong: string; weak: string }> = {
  anthropic: { strong: "claude-sonnet-4-5", weak: "claude-haiku-4-5" },
  openai: { strong: "gpt-4.1", weak: "gpt-4.1-mini" },
};

/**
 * General operating policy only. It deliberately contains no per-incident
 * procedure, tool order or expected answer: trajectory eval is meaningful only
 * if the model is free to choose a worse path.
 */
export const BASELINE_PROMPT = `You are an autonomous on-call SRE agent responding to a production alert. You can act only through the tools provided.

How to work:
- Investigate before you act. Use the read-only tools to gather evidence for the root cause.
- Fix the root cause, not the symptom, with the smallest remediation that addresses it.
- Tools that change production (restart_service, scale_service, page_oncall, post_status) cannot be undone. Use one only when the evidence supports it, and never repeat an action that already succeeded.
- After remediating, confirm the fix with a metric or log check.
- If the root cause is something your tools cannot fix, page the on-call engineer with a concise summary instead of guessing.
- Once the incident is handled, post one short status update.
- Finish by replying without a tool call: state the root cause, the action you took, and name the affected service.
Call one tool at a time.`;

export const BASELINE: AgentConfig = {
  label: "baseline",
  description: "Strong model, full operating policy. Produces the golden trajectories.",
  modelTier: "strong",
  systemPrompt: BASELINE_PROMPT,
  maxSteps: 12,
  maxInvalidRetries: 2,
};

export const CONFIGS: AgentConfig[] = [BASELINE];

export function getConfig(label: string): AgentConfig {
  const c = CONFIGS.find((x) => x.label === label);
  if (!c) throw new Error(`unknown config "${label}"`);
  return c;
}

export function detectProvider(): Provider {
  const explicit = process.env.LLM_PROVIDER;
  if (explicit === "anthropic" || explicit === "openai") return explicit;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  throw new Error("live mode needs ANTHROPIC_API_KEY or OPENAI_API_KEY");
}

export function resolveConfig(label: string, provider: Provider, modelOverride?: string): ResolvedConfig {
  const base = getConfig(label);
  const envModel = base.modelTier === "strong" ? process.env.STRONG_MODEL : process.env.WEAK_MODEL;
  const model = modelOverride ?? envModel ?? DEFAULT_MODELS[provider][base.modelTier];
  const tools = toolSpecs(base.toolDescriptions);
  const hashed = {
    provider,
    model,
    temperature: 0,
    systemPrompt: base.systemPrompt,
    tools,
    maxSteps: base.maxSteps,
    maxInvalidRetries: base.maxInvalidRetries,
  };
  return { ...base, provider, model, temperature: 0, tools, hash: sha256(canonicalJSON(hashed)) };
}
