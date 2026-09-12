import { canonicalJSON, sha256 } from "../core/canonical";
import { effectMatches, type Scenario, type World } from "../scenarios";

type Prop =
  | { type: "string"; description: string; minLength?: number; enum?: string[] }
  | { type: "integer"; description: string; minimum?: number; maximum?: number };

export interface ObjectSchema {
  type: "object";
  properties: Record<string, Prop>;
  required: string[];
  additionalProperties: false;
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: ObjectSchema;
}

/** A tool reported a domain error (e.g. unknown service). Recorded as TOOL_FAILED and shown to the LLM. */
export class ToolError extends Error {}

interface ToolDef {
  name: string;
  description: string;
  sideEffect: boolean;
  schema: ObjectSchema;
  /**
   * Pure function of (args, current world). Determinism here is what lets a
   * trajectory difference be attributed to the LLM alone.
   */
  run(args: Record<string, unknown>, world: World): unknown;
}

const str = (description: string, extra: Partial<Extract<Prop, { type: "string" }>> = {}): Prop => ({
  type: "string",
  description,
  minLength: 1,
  ...extra,
});

function requireService(world: World, name: string): void {
  if (!world.services.includes(name)) {
    throw new ToolError(`no such service "${name}". Known services: ${world.services.join(", ")}`);
  }
}

const TOOLS: ToolDef[] = [
  {
    name: "search_logs",
    description: "Search recent production logs. Returns the best-matching log lines for the query keywords. Read-only.",
    sideEffect: false,
    schema: {
      type: "object",
      properties: { query: str("Keywords to search for, e.g. a service name, error text or path") },
      required: ["query"],
      additionalProperties: false,
    },
    run(args, world) {
      // Service names are hyphenated (order-worker) while metric names use
      // underscores (order_worker_replicas), and a search for one spelling
      // must not miss the other: both sides are split on every separator.
      const words = (s: string) =>
        s
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length >= 2);
      const tokens = words(String(args.query));
      const scored = world.logs
        .map((line, i) => {
          const lineWords = words(line);
          return { line, i, score: tokens.filter((t) => lineWords.some((w) => w === t || w.includes(t) || t.includes(w))).length };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .slice(0, 6)
        .sort((a, b) => a.i - b.i);
      if (scored.length === 0) return { matches: [], note: "no log lines matched" };
      return { matches: scored.map((x) => x.line) };
    },
  },
  {
    name: "get_metric",
    description: "Read a time series for a metric over a window. Returns the sampled values, oldest first. Read-only.",
    sideEffect: false,
    schema: {
      type: "object",
      properties: {
        name: str("Metric name, e.g. disk_usage_data or api_error_rate"),
        window: { type: "string", description: "Lookback window", enum: ["5m", "1h", "24h"] },
      },
      required: ["name", "window"],
      additionalProperties: false,
    },
    run(args, world) {
      const name = String(args.name);
      const series = world.metrics[name];
      if (!series) {
        throw new ToolError(`unknown metric "${name}". Available metrics: ${Object.keys(world.metrics).join(", ")}`);
      }
      const values = series[String(args.window)];
      if (!values) {
        throw new ToolError(`metric "${name}" has no data for window ${args.window}. Available: ${Object.keys(series).join(", ")}`);
      }
      return { name, window: args.window, values };
    },
  },
  {
    name: "restart_service",
    description: "Restart all instances of a service. Changes production state.",
    sideEffect: true,
    schema: {
      type: "object",
      properties: { name: str("Service name") },
      required: ["name"],
      additionalProperties: false,
    },
    run(args, world) {
      requireService(world, String(args.name));
      return { status: "restarted", service: args.name };
    },
  },
  {
    name: "scale_service",
    description: "Set the replica count of a service. Changes production state.",
    sideEffect: true,
    schema: {
      type: "object",
      properties: {
        name: str("Service name"),
        replicas: { type: "integer", description: "Target replica count", minimum: 1, maximum: 50 },
      },
      required: ["name", "replicas"],
      additionalProperties: false,
    },
    run(args, world) {
      requireService(world, String(args.name));
      return { status: "scaled", service: args.name, replicas: args.replicas };
    },
  },
  {
    name: "page_oncall",
    description: "Page the human on-call engineer with a message. Notifies a person.",
    sideEffect: true,
    schema: {
      type: "object",
      properties: { message: str("What the engineer needs to know") },
      required: ["message"],
      additionalProperties: false,
    },
    run(args) {
      return { status: "paged", incident: `INC-${sha256(String(args.message)).slice(0, 6)}` };
    },
  },
  {
    name: "post_status",
    description: "Post a public status-page update. Visible to customers.",
    sideEffect: true,
    schema: {
      type: "object",
      properties: { message: str("Status update text") },
      required: ["message"],
      additionalProperties: false,
    },
    run() {
      return { status: "posted" };
    },
  },
];

export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function isSideEffecting(name: string): boolean {
  return getTool(name)?.sideEffect ?? false;
}

export function toolSpecs(descriptionOverrides: Record<string, string> = {}): ToolSpec[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: descriptionOverrides[t.name] ?? t.description,
    input_schema: t.schema,
  }));
}

/** Returns an error message, or null when `value` satisfies the schema. */
export function validateArgs(schema: ObjectSchema, value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be a JSON object";
  const obj = value as Record<string, unknown>;
  for (const key of schema.required) if (!(key in obj)) return `missing required argument "${key}"`;
  for (const [key, v] of Object.entries(obj)) {
    const p = schema.properties[key];
    if (!p) return `unexpected argument "${key}"`;
    if (p.type === "string") {
      if (typeof v !== "string") return `"${key}" must be a string`;
      if (p.minLength && v.length < p.minLength) return `"${key}" must not be empty`;
      if (p.enum && !p.enum.includes(v)) return `"${key}" must be one of ${p.enum.join(", ")}`;
    } else {
      if (typeof v !== "number" || !Number.isInteger(v)) return `"${key}" must be an integer`;
      if (p.minimum !== undefined && v < p.minimum) return `"${key}" must be >= ${p.minimum}`;
      if (p.maximum !== undefined && v > p.maximum) return `"${key}" must be <= ${p.maximum}`;
    }
  }
  return null;
}

export type ValidatedCall = { ok: true; tool: string; args: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Gate between the LLM and anything that can touch the world. A call that
 * fails here is never logged as TOOL_INVOKED and never reaches a tool.
 */
export function validateCall(toolName: string | undefined, rawArgs: string | undefined): ValidatedCall {
  if (!toolName) return { ok: false, reason: "no tool name given" };
  const def = getTool(toolName);
  if (!def) {
    return { ok: false, reason: `unknown tool "${toolName}". Available tools: ${TOOLS.map((t) => t.name).join(", ")}` };
  }
  let args: unknown;
  try {
    args = JSON.parse(rawArgs && rawArgs.trim() ? rawArgs : "{}");
  } catch (e) {
    return { ok: false, reason: `arguments are not valid JSON: ${(e as Error).message}` };
  }
  const err = validateArgs(def.schema, args);
  if (err) return { ok: false, reason: `invalid arguments for ${toolName}: ${err}` };
  return { ok: true, tool: toolName, args: args as Record<string, unknown> };
}

/** Applies every world effect whose trigger appears in the side-effect ledger. */
export function currentWorld(scenario: Scenario, ledger: Array<{ tool: string; args: Record<string, unknown> }>): World {
  const world: World = {
    services: scenario.world.services,
    logs: scenario.world.logs.slice(),
    metrics: { ...scenario.world.metrics },
  };
  for (const eff of scenario.world.effects ?? []) {
    if (!ledger.some((row) => effectMatches(eff.when, row.tool, row.args))) continue;
    for (const [name, series] of Object.entries(eff.metrics ?? {})) {
      world.metrics[name] = { ...world.metrics[name], ...series };
    }
    world.logs.push(...(eff.logs ?? []));
  }
  return world;
}

export function runTool(name: string, args: Record<string, unknown>, world: World): unknown {
  const def = getTool(name);
  if (!def) throw new ToolError(`unknown tool "${name}"`);
  return def.run(args, world);
}

export function argsHash(args: unknown): string {
  return sha256(canonicalJSON(args));
}
