import fs from "node:fs";
import path from "node:path";
import { canonicalJSON, sha256 } from "../core/canonical";
import { providerLLM } from "./providers";
import { detectProvider, resolveConfig, type Provider, type ResolvedConfig } from "./configs";
import type { LLM, LlmRequest, LlmResponse } from "./types";

export const RECORDINGS_DIR = path.resolve(import.meta.dirname, "../../recordings");

export interface RecordingFile {
  config_label: string;
  task_id: string;
  provider: Provider;
  model: string;
  config_hash: string;
  recorded_at: string;
  /** Every response the real model produced for this (config, task), keyed by the exact request that elicited it. */
  entries: Array<{ key: string; turn: number; response: LlmResponse }>;
}

export class NotRecordedError extends Error {
  constructor(label: string, task: string) {
    super(`config "${label}" has not been recorded for task "${task}" (missing recordings/${label}/${task}.json)`);
  }
}

export class RecordingStaleError extends Error {}
export class RecordingMissError extends Error {}

export function recordingPath(label: string, task: string): string {
  return path.join(RECORDINGS_DIR, label, `${task}.json`);
}

export function hasRecording(label: string, task: string): boolean {
  return fs.existsSync(recordingPath(label, task));
}

export function loadRecording(label: string, task: string): RecordingFile {
  const file = recordingPath(label, task);
  if (!fs.existsSync(file)) throw new NotRecordedError(label, task);
  return JSON.parse(fs.readFileSync(file, "utf8")) as RecordingFile;
}

/** The recording key is the full request: same config + same conversation => same key. */
export function requestKey(configHash: string, req: LlmRequest): string {
  return sha256(canonicalJSON({ config_hash: configHash, messages: req.messages }));
}

/**
 * Serves responses from a committed recording and never contacts a model.
 * A request that was never recorded is an error, not a fallback: returning
 * anything else would be fabricating model output.
 */
export class ReplayLLM implements LLM {
  constructor(private file: RecordingFile) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const key = requestKey(this.file.config_hash, req);
    const hit = this.file.entries.find((e) => e.key === key);
    if (!hit) {
      throw new RecordingMissError(
        `no recorded response for this request (config "${this.file.config_label}", task "${this.file.task_id}", turn ${req.messages.length}); the conversation diverged from what was recorded — re-record in live mode`,
      );
    }
    return hit.response;
  }
}

/** Live mode: forwards to the real model and appends every response to the recording file. */
export class RecordingLLM implements LLM {
  private file: RecordingFile;

  constructor(
    private inner: LLM,
    config: ResolvedConfig,
    task: string,
  ) {
    const existing = hasRecording(config.label, task) ? loadRecording(config.label, task) : undefined;
    const reusable = existing && existing.config_hash === config.hash;
    this.file = {
      config_label: config.label,
      task_id: task,
      provider: config.provider,
      model: config.model,
      config_hash: config.hash,
      recorded_at: new Date().toISOString(),
      entries: reusable ? existing.entries : [],
    };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const key = requestKey(this.file.config_hash, req);
    const cached = this.file.entries.find((e) => e.key === key);
    if (cached) return cached.response;
    const response = await this.inner.complete(req);
    this.file.entries.push({ key, turn: req.messages.length, response });
    this.file.recorded_at = new Date().toISOString();
    const out = recordingPath(this.file.config_label, this.file.task_id);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(this.file, null, 2) + "\n");
    return response;
  }
}

export type LlmMode = "replay" | "live";

export function llmMode(): LlmMode {
  return process.env.LLM_MODE === "live" ? "live" : "replay";
}

/**
 * Resolves the agent config and the model behind it for one (config, task).
 * In replay mode the provider and model come from the recording itself, so
 * no key is needed, and a config edited since recording is refused.
 */
export function openAgentLLM(label: string, task: string, mode: LlmMode = llmMode()): { config: ResolvedConfig; llm: LLM } {
  if (mode === "live") {
    const config = resolveConfig(label, detectProvider());
    return { config, llm: new RecordingLLM(providerLLM(config), config, task) };
  }
  const file = loadRecording(label, task);
  const config = resolveConfig(label, file.provider, file.model);
  if (config.hash !== file.config_hash) {
    throw new RecordingStaleError(
      `config "${label}" changed since recordings/${label}/${task}.json was recorded; re-record it in live mode`,
    );
  }
  return { config, llm: new ReplayLLM(file) };
}
