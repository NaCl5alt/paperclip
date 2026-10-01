/**
 * The adapter type id. This is the value stored on agent rows, so changing it
 * orphans every agent already configured against this adapter.
 */
export const ADAPTER_TYPE = "agy_local";

export const ADAPTER_LABEL = "Antigravity CLI (agy)";

/** Idempotent shell snippet for provisioning agy in a fresh remote runtime. */
export const AGY_INSTALL_HINT =
  "Install the Antigravity CLI so that `agy` is on PATH, then run `agy install` to configure shell paths.";
