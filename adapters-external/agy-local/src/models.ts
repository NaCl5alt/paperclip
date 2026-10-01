/**
 * Model catalogue for the Antigravity CLI.
 *
 * `agy models` prints one tab-separated `id<TAB>label` per line after a
 * "Fetching available models..." banner. Discovery is preferred so newly
 * released models appear without an adapter release; the static list is the
 * offline fallback.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AdapterModel, AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

const execFileAsync = promisify(execFile);

/** Sentinel meaning "let agy pick" — the adapter omits --model entirely. */
export const DEFAULT_AGY_MODEL = "auto";

/** Offline fallback, observed from `agy models` on agy 1.1.28. */
export const models: AdapterModel[] = [
  { id: DEFAULT_AGY_MODEL, label: "Antigravity default (agy chooses)" },
  { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
  { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
  { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
  { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
  { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
  { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Gemini 3.8 Flash (Low)",
    description: "Cheapest Antigravity lane — use for mechanical or high-volume subtasks.",
    adapterConfig: { model: "gemini-3.8-flash-low" },
    source: "adapter_default",
  },
];

/** Parse the tab-separated `agy models` table, ignoring the progress banner. */
export function parseAgyModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    // Skip the "Fetching available models..." style banner and any prose.
    if (!line.includes("\t")) continue;
    const [rawId, ...labelParts] = rawLine.split("\t");
    const id = (rawId ?? "").trim();
    if (id.length === 0 || seen.has(id)) continue;
    const label = labelParts.join(" ").trim();
    seen.add(id);
    parsed.push({ id, label: label.length > 0 ? label : id });
  }
  return parsed;
}

const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
let modelCache: { models: AdapterModel[]; fetchedAt: number } | null = null;

async function discoverModels(command: string): Promise<AdapterModel[]> {
  const { stdout } = await execFileAsync(command, ["models"], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const discovered = parseAgyModelsOutput(stdout);
  if (discovered.length === 0) return [];
  // Keep the "auto" sentinel first so the UI default stays reachable.
  return [{ id: DEFAULT_AGY_MODEL, label: "Antigravity default (agy chooses)" }, ...discovered];
}

export async function listAgyModels(command = "agy"): Promise<AdapterModel[]> {
  const now = Date.now();
  if (modelCache && now - modelCache.fetchedAt < MODEL_CACHE_TTL_MS) {
    return modelCache.models;
  }
  try {
    const discovered = await discoverModels(command);
    if (discovered.length > 0) {
      modelCache = { models: discovered, fetchedAt: now };
      return discovered;
    }
  } catch {
    // agy missing or not authenticated — fall through to the static catalogue.
  }
  return models;
}

export async function refreshAgyModels(command = "agy"): Promise<AdapterModel[]> {
  modelCache = null;
  return listAgyModels(command);
}

/**
 * Map a model id to the upstream model provider, for cost attribution.
 * Antigravity fronts several vendors, so the provider is not always Google.
 */
export function inferModelProvider(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("claude")) return "anthropic";
  if (normalized.startsWith("gpt") || normalized.startsWith("o1") || normalized.startsWith("o3")) {
    return "openai";
  }
  return "google";
}
