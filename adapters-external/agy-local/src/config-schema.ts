/**
 * Declarative config schema. Paperclip renders these fields in the agent
 * settings form, so the adapter needs no React code.
 */

import type { AdapterConfigSchema, ConfigFieldOption } from "@paperclipai/adapter-utils";

import { DEFAULT_AGY_MODEL, listAgyModels } from "./models.js";

export async function getConfigSchema(): Promise<AdapterConfigSchema> {
  // Resolve the live model list here so the dropdown reflects what the
  // installed agy actually offers.
  const discovered = await listAgyModels();
  const modelOptions: ConfigFieldOption[] = discovered.map((model) => ({
    label: model.label,
    value: model.id,
  }));

  return {
    fields: [
      {
        key: "command",
        label: "agy command",
        type: "text",
        default: "agy",
        hint: "Executable name or absolute path to the Antigravity CLI.",
        group: "Runtime",
      },
      {
        key: "model",
        label: "Model",
        type: "combobox",
        options: modelOptions,
        default: DEFAULT_AGY_MODEL,
        hint: "Leave on the default to let agy choose. Antigravity fronts Gemini, Claude and GPT-OSS models.",
        group: "Runtime",
      },
      {
        key: "effort",
        label: "Reasoning effort",
        type: "select",
        options: [
          { label: "Adapter default (unset)", value: "" },
          { label: "Low", value: "low" },
          { label: "Medium", value: "medium" },
          { label: "High", value: "high" },
        ],
        default: "",
        hint:
          "Maps to agy --effort. Ignored for models whose id already encodes an effort tier " +
          "(e.g. gemini-3.8-flash-high) — agy rejects --model plus --effort together, so the " +
          "adapter drops --effort for those. Only \"auto\", claude-sonnet-4-6 and " +
          "claude-opus-4-6-thinking take an explicit effort value today.",
        group: "Runtime",
      },
      {
        key: "cwd",
        label: "Working directory",
        type: "text",
        hint: "Fallback absolute working directory when no Paperclip workspace is attached. Created if missing.",
        group: "Runtime",
      },
      {
        key: "agyAgent",
        label: "agy agent",
        type: "text",
        hint: "Optional named agy agent (agy --agent). Leave blank for the default agent.",
        group: "Runtime",
      },
      {
        key: "sandbox",
        label: "Run agy in its own sandbox",
        type: "toggle",
        default: false,
        hint: "Passes agy --sandbox. Off by default because Paperclip already controls the execution boundary.",
        group: "Runtime",
      },
      {
        key: "disableSlashCommands",
        label: "Disable slash commands and skill expansion",
        type: "toggle",
        default: false,
        hint: "Passes agy --disable-slash-commands. Enable when Paperclip prompt text should never be treated as an agy command.",
        group: "Runtime",
      },
      {
        key: "skillsScope",
        label: "Skills location",
        type: "select",
        default: "agent",
        options: [
          { value: "agent", label: "Per-agent (recommended)" },
          { value: "global", label: "Shared agy config (~/.gemini/config/skills)" },
        ],
        hint:
          "Per-agent keeps each agent's skills in its own directory, delivered with an extra --add-dir. " +
          "Shared writes into agy's global skills directory, visible to every agy agent on this host.",
        group: "Skills",
      },
      {
        key: "skillsRootPath",
        label: "Per-agent skills root",
        type: "text",
        hint:
          "Optional. Overrides the directory that holds this agent's skills; agy reads them from " +
          "<root>/.agents/skills. Ignored when Skills location is set to the shared agy config.",
        group: "Skills",
      },
      {
        key: "instructionsFilePath",
        label: "Instructions file",
        type: "text",
        hint: "Absolute path to a markdown instructions file prepended to every run prompt (AGENTS.md).",
        group: "Prompt",
      },
      {
        key: "promptTemplate",
        label: "Heartbeat prompt template",
        type: "textarea",
        hint: "Overrides the default Paperclip heartbeat prompt. Leave blank to use the standard template.",
        group: "Prompt",
      },
      {
        key: "bootstrapPromptTemplate",
        label: "Bootstrap prompt template",
        type: "textarea",
        hint: "Extra prompt text injected only on the first run of a new conversation.",
        group: "Prompt",
      },
      {
        key: "extraArgs",
        label: "Extra CLI arguments",
        type: "textarea",
        hint: "Additional agy arguments, one per line or space separated.",
        group: "Advanced",
      },
      {
        key: "env",
        label: "Environment variables",
        type: "textarea",
        hint: "KEY=VALUE per line, passed to the agy child process.",
        group: "Advanced",
      },
      {
        key: "timeoutSec",
        label: "Run timeout (seconds)",
        type: "number",
        default: 3600,
        hint: "Paperclip kills the run after this long. agy --print-timeout is derived from it.",
        group: "Advanced",
      },
      {
        key: "graceSec",
        label: "SIGTERM grace period (seconds)",
        type: "number",
        default: 15,
        group: "Advanced",
      },
    ],
  };
}
