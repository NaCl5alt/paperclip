/**
 * "Test Connection" probe for the agy adapter.
 *
 * Checks, in order: agy is on PATH, it reports a version, and it can list
 * models (which requires working authentication). Each check reports its own
 * status so a failure names the thing to fix.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentTestStatus,
} from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";

import { ADAPTER_TYPE, AGY_INSTALL_HINT } from "./constants.js";
import { parseAgyModelsOutput } from "./models.js";

const execFileAsync = promisify(execFile);

function worstStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestStatus {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const command = asString(ctx.config.command, "agy");

  if (ctx.executionTarget && ctx.executionTarget.kind !== "local") {
    // Remote probing would need to run inside the target; say so rather than
    // reporting a host-local result that does not describe the run environment.
    checks.push({
      code: "agy_remote_target_unverified",
      level: "warn",
      message: `This adapter only probes the Paperclip host. The configured ${ctx.environmentName ?? "remote"} environment was not tested.`,
      hint: "Confirm agy is installed and authenticated inside the remote environment, or run this agent on the local target.",
    });
  }

  let versionOk = false;
  try {
    const { stdout } = await execFileAsync(command, ["--version"], { timeout: 20_000 });
    const version = stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
    versionOk = version.length > 0;
    checks.push({
      code: "agy_command_found",
      level: "info",
      message: `Found ${command}${version ? ` (version ${version})` : ""}.`,
    });
  } catch (err) {
    checks.push({
      code: "agy_command_missing",
      level: "error",
      message: `Could not run "${command} --version".`,
      detail: describeError(err),
      hint: AGY_INSTALL_HINT,
    });
  }

  if (versionOk) {
    try {
      const { stdout } = await execFileAsync(command, ["models"], {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const discovered = parseAgyModelsOutput(stdout);
      if (discovered.length > 0) {
        checks.push({
          code: "agy_models_listed",
          level: "info",
          message: `Authenticated — agy reports ${discovered.length} available models.`,
          detail: discovered
            .slice(0, 5)
            .map((model) => model.id)
            .join(", "),
        });
      } else {
        checks.push({
          code: "agy_models_empty",
          level: "warn",
          message: "agy ran but returned no models.",
          hint: "This usually means agy is not signed in. Run `agy` interactively once and complete login.",
        });
      }
    } catch (err) {
      checks.push({
        code: "agy_models_failed",
        level: "error",
        message: "agy could not list models, which usually means authentication is missing or expired.",
        detail: describeError(err),
        hint: "Run `agy` interactively on this machine and complete the Antigravity login, then re-test.",
      });
    }

    const configuredModel = asString(ctx.config.model, "").trim();
    if (configuredModel.length > 0 && configuredModel !== "auto") {
      checks.push({
        code: "agy_model_configured",
        level: "info",
        message: `Agent is pinned to model "${configuredModel}".`,
      });
    }
  }

  return {
    adapterType: ADAPTER_TYPE,
    status: worstStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
