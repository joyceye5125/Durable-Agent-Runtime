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
  /**
   * A budget this config deliberately sets, which beats the scenario's own
   * `max_steps`. Without it a long scenario that raises max_steps would hand
   * the step-budget candidate more steps than the candidate is supposed to
   * have, and silently stop testing anything.
   */
  maxStepsOverride?: number;
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
- After remediating, confirm it with a metric or log check. A reading that comes back exactly as it was before your action did not react to it, and waiting will not change that, so reading the same thing again is never the next step.
- Your work is done when every reading named in the alert is back to a normal level, or when you have paged the on-call engineer because what remains is beyond your tools. Better but still bad, or a second alerted signal that has not moved at all, means something else is still wrong: find that and fix it, or page the on-call engineer if there is nothing left that your tools can fix. An action that already succeeded and did not help is evidence, not something to try again — repeating it is never the next step.
- If the root cause is something your tools cannot fix, page the on-call engineer with a concise summary instead of guessing.
- Before you finish, whether you fixed the incident or paged someone, post one short status update.
- Finish by replying without a tool call: state the root cause, the action you took, and name the affected service.
Call one tool at a time.`;

export const BASELINE: AgentConfig = {
  label: "baseline",
  description: "Strong model, full operating policy. Produces the golden trajectories.",
  modelTier: "strong",
  systemPrompt: BASELINE_PROMPT,
  // An incident that needs two remediations plus a check after each one runs
  // to about a dozen steps; 12 cut a correct run off one step before its
  // answer. The budget is not what this is testing.
  maxSteps: 16,
  maxInvalidRetries: 2,
};

const lines = BASELINE_PROMPT.split("\n");
const withoutLine = (startsWith: string) => {
  if (!lines.some((l) => l.startsWith(startsWith))) throw new Error(`baseline prompt has no line "${startsWith}"`);
  return lines.filter((l) => !l.startsWith(startsWith)).join("\n");
};
const withExtra = (extra: string) => lines.map((l) => (l === "Call one tool at a time." ? `${extra}\n${l}` : l)).join("\n");

const candidate = (label: string, description: string, patch: Partial<AgentConfig>): AgentConfig => ({
  ...BASELINE,
  label,
  description,
  ...patch,
});

/**
 * Candidate changes a team might plausibly ship: model swaps, prompt edits,
 * trimmed instructions, a tighter step budget. Whether each one degrades the
 * path, the endpoint, both or neither is measured, not assumed.
 */
export const CANDIDATES: AgentConfig[] = [
  candidate("weak-model", "Same prompt on the smaller model.", { modelTier: "weak" }),
  candidate("weak-model-terse", "Smaller model with a one-line prompt.", {
    modelTier: "weak",
    systemPrompt: "You are an SRE agent. Use the tools to resolve the alert, then summarize what you did.",
  }),
  candidate("terse-prompt", "Strong model, one-line prompt.", {
    systemPrompt: "You are an SRE agent. Use the tools to resolve the alert, then summarize what you did.",
  }),
  candidate("no-investigate-first", "Drops the investigate-before-acting rule.", { systemPrompt: withoutLine("- Investigate before you act") }),
  candidate("no-root-cause", "Drops the fix-the-root-cause rule.", { systemPrompt: withoutLine("- Fix the root cause") }),
  candidate("no-verify", "Drops the confirm-the-fix rule.", { systemPrompt: withoutLine("- After remediating") }),
  candidate("no-status-update", "Drops the post-a-status-update rule.", { systemPrompt: withoutLine("- Before you finish") }),
  candidate("no-escalation", "Drops the page-when-you-cannot-fix rule.", { systemPrompt: withoutLine("- If the root cause is something") }),
  candidate("no-caution", "Drops the production-changes-are-irreversible rule.", { systemPrompt: withoutLine("- Tools that change production") }),
  candidate("double-check", "Adds: re-run each read-only check before changing production.", {
    systemPrompt: withExtra("- Be thorough: before any production change, repeat each read-only check once to confirm the evidence."),
  }),
  candidate("both-windows", "Adds: read every metric at both the 5m and 1h windows.", {
    systemPrompt: withExtra("- Whenever you read a metric, read it at both the 5m and the 1h window."),
  }),
  candidate("act-fast", "Adds: restart unhealthy-looking services immediately, investigate after.", {
    systemPrompt: withExtra("- Speed matters more than certainty: if a service looks unhealthy, restart it right away, then keep investigating."),
  }),
  candidate("status-early", "Adds: post a status update when you start, and again when resolved.", {
    systemPrompt: withExtra("- Post a status update as soon as you start investigating, and another one once the incident is resolved."),
  }),
  candidate("vague-tool-docs", "Replaces tool descriptions with one-word ones.", {
    toolDescriptions: {
      search_logs: "Logs.",
      get_metric: "Metrics.",
      restart_service: "Restart.",
      scale_service: "Scale.",
      page_oncall: "Page.",
      post_status: "Status.",
    },
  }),
  candidate("max-steps-6", "Step budget cut from 16 to 6.", { maxStepsOverride: 6 }),
];

export const CONFIGS: AgentConfig[] = [BASELINE, ...CANDIDATES];

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
    // canonicalJSON drops undefined, so configs that set no override hash
    // exactly as they did before this field existed.
    maxStepsOverride: base.maxStepsOverride,
    maxInvalidRetries: base.maxInvalidRetries,
  };
  return { ...base, provider, model, temperature: 0, tools, hash: sha256(canonicalJSON(hashed)) };
}
