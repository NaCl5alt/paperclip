/**
 * `agy-paperclip-adapter` — Paperclip adapter for the Antigravity CLI.
 *
 * Paperclip's external adapter loader imports this module's default entry and
 * calls `createServerAdapter()`, expecting a `ServerAdapterModule` back. See
 * `@paperclipai/server/dist/adapters/plugin-loader.js`.
 */

import type { AdapterRuntimeCommandSpec, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";

import { agentConfigurationDoc } from "./agent-configuration-doc.js";
import { getConfigSchema } from "./config-schema.js";
import { ADAPTER_LABEL, ADAPTER_TYPE } from "./constants.js";
import { execute } from "./execute.js";
import { DEFAULT_AGY_MODEL, listAgyModels, modelProfiles, models, refreshAgyModels } from "./models.js";
import { sessionCodec, sessionManagement } from "./session.js";
import { listSkills, syncSkills } from "./skills.js";
import { testEnvironment } from "./test-environment.js";

function getRuntimeCommandSpec(config: Record<string, unknown>): AdapterRuntimeCommandSpec {
  const command = asString(config.command, "agy") || "agy";
  return {
    command,
    detectCommand: command,
    // agy ships as a single large binary rather than an npm package, so there is
    // no safe generic install snippet to emit here.
    installCommand: null,
  };
}

/**
 * Factory the Paperclip external adapter loader calls. It must be exported from
 * the package's main entry under exactly this name.
 */
export function createServerAdapter(): ServerAdapterModule {
  return {
    type: ADAPTER_TYPE,
    execute,
    testEnvironment,
    sessionCodec,
    sessionManagement,
    models,
    listModels: () => listAgyModels(),
    refreshModels: () => refreshAgyModels(),
    modelProfiles,
    getConfigSchema,
    getRuntimeCommandSpec,
    agentConfigurationDoc,
    listSkills,
    syncSkills,
    // Paperclip may mint a local agent JWT so the agent can call the control plane.
    supportsLocalAgentJwt: true,
    // External adapters must opt in explicitly; this adapter reads
    // config.instructionsFilePath and prepends the bundle to the run prompt.
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    // agy scans a skills directory rather than reading config, so Paperclip must
    // materialize runtime skill entries on disk before syncSkills can link them.
    requiresMaterializedRuntimeSkills: true,
  };
}

export default createServerAdapter;

export { ADAPTER_LABEL, ADAPTER_TYPE, DEFAULT_AGY_MODEL, agentConfigurationDoc, models, modelProfiles };
export { execute } from "./execute.js";
export { testEnvironment } from "./test-environment.js";
export { getConfigSchema } from "./config-schema.js";
export { sessionCodec, sessionManagement } from "./session.js";
export {
  listSkills,
  syncSkills,
  describeRunSkillSync,
  resolveAgySkillRoot,
  sanitizeAgentIdSegment,
  AGY_WORKSPACE_SKILL_SUBPATH,
  SKILL_SYNC_LOG_PREFIX,
} from "./skills.js";
export type { AgySkillRoot, AgySkillScope, RunSkillSync } from "./skills.js";
export { buildAgyArgs, describeAgyArgs, resolveAgyPrintTimeoutSec } from "./args.js";
export {
  parseAgyJsonl,
  isAgySuccessResult,
  detectAgyAuthRequired,
  detectAgyQuotaExhausted,
  isAgyTransientNetworkError,
  isAgySessionUnrecoverableError,
  describeAgyFailure,
} from "./parse.js";
export type { AgyParsedStream, AgyToolInvocation } from "./parse.js";
