import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  DraftNumberInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime.";

const recoveryFallbackHint =
  "Optional. When a run of this agent fails on a transient upstream (usage / rate-limit) condition, recovery is handed to the selected agent instead of the default manager/creator/executive owner. Candidates are active agents in the same company. Leave unset to keep the default recovery behavior.";


export function ClaudeLocalConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return (
    <>
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
      <LocalWorkspaceRuntimeFields
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
        eff={eff}
        mode={mode}
        adapterType={adapterType}
        models={models}
      />
    </>
  );
}

export function ClaudeLocalAdvancedFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  agents,
  selfAgentId,
}: AdapterConfigFieldsProps) {
  const rawEngine = isCreate
    ? values!.claudeEngine ?? "auto"
    : eff("adapterConfig", "engine", String(config.engine ?? "auto"));
  const engine = rawEngine === "acp" || rawEngine === "cli" ? rawEngine : "auto";
  const acpSelected = engine === "acp";
  const agentList = agents ?? [];
  const candidates = agentList.filter(
    (a) =>
      a.id !== selfAgentId &&
      a.status !== "terminated",
  );
  const recoveryFallbackValue = isCreate
    ? values!.recoveryFallbackAgentId ?? ""
    : eff(
        "adapterConfig",
        "recoveryFallbackAgentId",
        String(config.recoveryFallbackAgentId ?? ""),
      );
  const commitRecoveryFallback = (next: string) =>
    isCreate
      ? set!({ recoveryFallbackAgentId: next || undefined })
      : mark("adapterConfig", "recoveryFallbackAgentId", next || undefined);

  // Surface stored values the backend recovery guard would not honor. New
  // selections are always valid because the dropdown only offers
  // non-self, non-terminated candidates — these checks only fire on a
  // previously-saved value that has since become invalid.
  const selectedAgent = agentList.find((a) => a.id === recoveryFallbackValue);
  let recoveryFallbackWarning: string | null = null;
  if (recoveryFallbackValue) {
    if (recoveryFallbackValue === selfAgentId) {
      recoveryFallbackWarning =
        "An agent cannot be its own recovery fallback. Pick a different agent.";
    } else if (!selectedAgent) {
      recoveryFallbackWarning =
        "The configured fallback agent no longer exists; recovery will fall back to the default owner.";
    } else if (selectedAgent.status === "terminated") {
      recoveryFallbackWarning =
        "The configured fallback agent is terminated and will be ignored by recovery.";
    }
  }
  const showStaleFallbackOption =
    Boolean(recoveryFallbackValue) &&
    !candidates.some((a) => a.id === recoveryFallbackValue);

  return (
    <>
      <Field label="Execution engine" hint="Auto uses ACP when prerequisites pass and falls back to Claude CLI with diagnostics.">
        <select
          className={inputClass}
          value={engine}
          onChange={(e) => {
            const value = e.target.value === "acp" ? "acp" : e.target.value === "cli" ? "cli" : "auto";
            isCreate
              ? set!({ claudeEngine: value })
              : mark("adapterConfig", "engine", value === "auto" ? undefined : value);
          }}
        >
          <option value="auto">Auto (ACP preferred)</option>
          <option value="cli">Claude CLI</option>
          <option value="acp">ACP</option>
        </select>
      </Field>
      {acpSelected && (
        <>
          <Field
            label="ACP server command"
            hint="Optional override for the Claude ACP server command. Defaults to the package-local claude-agent-acp binary."
          >
            <DraftInput
              value={
                isCreate
                  ? values!.claudeAcpAgentCommand ?? ""
                  : eff("adapterConfig", "agentCommand", String(config.agentCommand ?? ""))
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ claudeAcpAgentCommand: v })
                  : mark("adapterConfig", "agentCommand", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="claude-agent-acp"
            />
          </Field>
          <Field label="ACP session mode" hint="Persistent keeps ACP session state between runs. One-shot starts fresh each run.">
            <select
              className={inputClass}
              value={
                isCreate
                  ? values!.claudeAcpMode ?? "persistent"
                  : eff("adapterConfig", "mode", String(config.mode ?? "persistent"))
              }
              onChange={(e) => {
                const value = e.target.value === "oneshot" ? "oneshot" : "persistent";
                isCreate
                  ? set!({ claudeAcpMode: value })
                  : mark("adapterConfig", "mode", value);
              }}
            >
              <option value="persistent">Persistent</option>
              <option value="oneshot">One-shot</option>
            </select>
          </Field>
          <Field
            label="ACP non-interactive permissions"
            hint="Fallback if the ACP agent asks for input outside an interactive session."
          >
            <select
              className={inputClass}
              value={
                isCreate
                  ? values!.claudeAcpNonInteractivePermissions ?? "deny"
                  : eff("adapterConfig", "nonInteractivePermissions", String(config.nonInteractivePermissions ?? "deny"))
              }
              onChange={(e) => {
                const value = e.target.value === "fail" ? "fail" : "deny";
                isCreate
                  ? set!({ claudeAcpNonInteractivePermissions: value })
                  : mark("adapterConfig", "nonInteractivePermissions", value);
              }}
            >
              <option value="deny">Deny</option>
              <option value="fail">Fail</option>
            </select>
          </Field>
          <Field
            label="ACP state directory"
            hint="Optional ACP session state directory. Defaults to Paperclip-managed company/agent scoped storage."
          >
            <div className="flex items-center gap-2">
              <DraftInput
                value={
                  isCreate
                    ? values!.claudeAcpStateDir ?? ""
                    : eff("adapterConfig", "stateDir", String(config.stateDir ?? ""))
                }
                onCommit={(v) =>
                  isCreate
                    ? set!({ claudeAcpStateDir: v })
                    : mark("adapterConfig", "stateDir", v || undefined)
                }
                immediate
                className={inputClass}
                placeholder="/path/to/acp-state"
              />
              <ChoosePathButton />
            </div>
          </Field>
          <Field
            label="ACP warm process idle ms"
            hint="Defaults to 0, which closes the ACP process after each run while retaining persistent session state."
          >
            {isCreate ? (
              <input
                type="number"
                className={inputClass}
                value={values!.claudeAcpWarmHandleIdleMs ?? 0}
                onChange={(e) => set!({ claudeAcpWarmHandleIdleMs: Number(e.target.value) })}
              />
            ) : (
              <DraftNumberInput
                value={eff(
                  "adapterConfig",
                  "warmHandleIdleMs",
                  Number(config.warmHandleIdleMs ?? 0),
                )}
                onCommit={(v) => mark("adapterConfig", "warmHandleIdleMs", v || 0)}
                immediate
                className={inputClass}
              />
            )}
          </Field>
        </>
      )}
      <ToggleField
        label="Enable Chrome"
        hint={help.chrome}
        checked={
          isCreate
            ? values!.chrome
            : eff("adapterConfig", "chrome", config.chrome === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ chrome: v })
            : mark("adapterConfig", "chrome", v)
        }
      />
      <ToggleField
        label="Skip permissions"
        hint={help.dangerouslySkipPermissions}
        checked={
          isCreate
            ? values!.dangerouslySkipPermissions
            : eff(
                "adapterConfig",
                "dangerouslySkipPermissions",
                config.dangerouslySkipPermissions !== false,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "dangerouslySkipPermissions", v)
        }
      />
      <Field label="Max turns per run" hint={help.maxTurnsPerRun}>
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={values!.maxTurnsPerRun}
            onChange={(e) => set!({ maxTurnsPerRun: Number(e.target.value) })}
          />
        ) : (
          <DraftNumberInput
            value={eff(
              "adapterConfig",
              "maxTurnsPerRun",
              Number(config.maxTurnsPerRun ?? 1000),
            )}
            onCommit={(v) => mark("adapterConfig", "maxTurnsPerRun", v || 1000)}
            immediate
            className={inputClass}
          />
        )}
      </Field>
      <Field label="Recovery fallback agent" hint={recoveryFallbackHint}>
        <select
          value={recoveryFallbackValue}
          onChange={(e) => commitRecoveryFallback(e.target.value)}
          className={inputClass}
        >
          <option value="">Unset (default recovery owner)</option>
          {candidates.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          {showStaleFallbackOption && (
            <option value={recoveryFallbackValue}>
              {selectedAgent
                ? `${selectedAgent.name} (invalid selection)`
                : `${recoveryFallbackValue} (unknown agent)`}
            </option>
          )}
        </select>
        {recoveryFallbackWarning ? (
          <p className="mt-1 text-xs text-amber-400">{recoveryFallbackWarning}</p>
        ) : candidates.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            No other agents are available in this company yet.
          </p>
        ) : recoveryFallbackValue && selectedAgent ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Current: {selectedAgent.name}
          </p>
        ) : null}
      </Field>
    </>
  );
}
