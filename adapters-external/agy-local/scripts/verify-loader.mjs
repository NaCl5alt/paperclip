// Simulate exactly what Paperclip's plugin-loader does, then exercise the adapter.
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const pkgDir = path.resolve(process.argv[2] ?? ".");
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));

// resolvePackageEntryPoint()
const exp = pkg.exports?.["."];
const entryPoint = typeof exp === "string" ? exp : (exp?.import ?? exp?.default ?? pkg.main ?? "index.js");
const modulePath = path.resolve(pkgDir, entryPoint);
console.log("entryPoint:", entryPoint);

const mod = await import(pathToFileURL(modulePath).href);

// validateAdapterModule()
if (typeof mod.createServerAdapter !== "function") throw new Error("FAIL: no createServerAdapter export");
const adapter = mod.createServerAdapter();
if (!adapter || !adapter.type) throw new Error("FAIL: invalid module (missing type)");
const { validateAdapterLoginCapability } = await import("@paperclipai/adapter-utils");
validateAdapterLoginCapability(adapter);
console.log("validateAdapterModule: OK  type =", adapter.type);

// Required surface
for (const fn of ["execute", "testEnvironment"]) {
  if (typeof adapter[fn] !== "function") throw new Error(`FAIL: ${fn} is not a function`);
}
console.log("required methods: OK");

// Optional skill-sync surface. agy has a real skill loader, so these must be
// present — without them Paperclip silently delivers no skills to an agy run.
for (const fn of ["listSkills", "syncSkills"]) {
  if (typeof adapter[fn] !== "function") throw new Error(`FAIL: ${fn} is not a function`);
}
if (adapter.requiresMaterializedRuntimeSkills !== true) {
  throw new Error("FAIL: syncSkills needs materialized runtime skill entries on disk");
}
const skillCtx = { agentId: "loader-probe", companyId: "c", adapterType: adapter.type, config: {} };
const skillSnapshot = await adapter.listSkills(skillCtx);
if (skillSnapshot.adapterType !== adapter.type) throw new Error("FAIL: skill snapshot adapterType mismatch");
if (skillSnapshot.mode !== "persistent") throw new Error(`FAIL: unexpected skill mode ${skillSnapshot.mode}`);
console.log("skill hooks: OK | mode =", skillSnapshot.mode, "| entries =", skillSnapshot.entries.length);

// ui-parser extraction (extractUiParserSource)
const uiExp = pkg.exports?.["./ui-parser"];
const uiFile = typeof uiExp === "string" ? uiExp : (uiExp?.import ?? uiExp?.default);
const uiPath = path.resolve(pkgDir, uiFile);
if (!uiPath.startsWith(pkgDir + path.sep)) throw new Error("FAIL: ui-parser escapes package dir");
if (!fs.existsSync(uiPath)) throw new Error("FAIL: ui-parser file missing");
console.log("ui-parser:", uiFile, fs.readFileSync(uiPath, "utf8").length, "bytes; contract", pkg.paperclip?.adapterUiParser);

// Live config schema (hits `agy models`)
const schema = await adapter.getConfigSchema();
const modelField = schema.fields.find((f) => f.key === "model");
console.log("configSchema: fields =", schema.fields.length, "| live model options =", modelField.options.length);

// Live model discovery
const models = await adapter.listModels();
console.log("listModels:", models.length, "->", models.slice(0, 4).map((m) => m.id).join(", "));

// Live environment probe
const test = await adapter.testEnvironment({ companyId: "c", adapterType: adapter.type, config: {} });
console.log("testEnvironment:", test.status);
for (const c of test.checks) console.log(`  [${c.level}] ${c.code}: ${c.message}`);

console.log("\nSMOKE OK");
