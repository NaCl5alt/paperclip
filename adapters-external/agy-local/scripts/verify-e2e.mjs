/** End-to-end: drive adapter.execute() the way Paperclip's heartbeat does. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServerAdapter } from "../dist/index.js";

const adapter = createServerAdapter();
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-e2e-"));
console.log("workspace:", cwd);

function makeCtx({ runId, prompt, sessionParams }) {
  const logs = [];
  let meta = null;
  return {
    logs,
    getMeta: () => meta,
    ctx: {
      runId,
      agent: { id: "agent-1", companyId: "company-1", name: "E2E", adapterType: adapter.type, adapterConfig: {} },
      runtime: { sessionId: null, sessionParams, sessionDisplayId: null, taskKey: null },
      config: { promptTemplate: prompt, timeoutSec: 300, model: "auto" },
      context: { paperclipWorkspace: { cwd, source: "project_primary" }, taskId: "issue-1", wakeReason: "issue_assigned" },
      onLog: async (stream, chunk) => { logs.push([stream, chunk]); },
      onMeta: async (m) => { meta = m; },
    },
  };
}

// ── Run 1: fresh conversation, must write into the workspace cwd ────────────
const run1 = makeCtx({
  runId: "run-1",
  prompt: "Create a file named e2e-marker.txt in your current working directory containing exactly APPLE. Then reply with the absolute path you wrote.",
  sessionParams: null,
});
const r1 = await adapter.execute(run1.ctx);
console.log("\n--- RUN 1 ---");
console.log("exitCode:", r1.exitCode, "| errorMessage:", r1.errorMessage, "| errorCode:", r1.errorCode);
console.log("sessionParams:", JSON.stringify(r1.sessionParams));
console.log("usage:", JSON.stringify(r1.usage), "| usageBasis:", r1.usageBasis);
console.log("provider:", r1.provider, "| biller:", r1.biller, "| billingType:", r1.billingType);
console.log("summary:", r1.summary);
console.log("meta.commandArgs:", JSON.stringify(run1.getMeta()?.commandArgs));

const markerPath = path.join(cwd, "e2e-marker.txt");
const landedInWorkspace = fs.existsSync(markerPath);
console.log("\nWORKSPACE BINDING:", landedInWorkspace ? "PASS — file landed in workspace" : "FAIL — file NOT in workspace");
if (landedInWorkspace) console.log("  contents:", JSON.stringify(fs.readFileSync(markerPath, "utf8")));
console.log("  workspace listing:", fs.readdirSync(cwd).join(", ") || "(empty)");

// ── Run 2: resume the same conversation, prove continuity ───────────────────
const run2 = makeCtx({
  runId: "run-2",
  prompt: "What single word did you just write into e2e-marker.txt? Reply with only that word.",
  sessionParams: r1.sessionParams,
});
const r2 = await adapter.execute(run2.ctx);
console.log("\n--- RUN 2 (resume) ---");
console.log("exitCode:", r2.exitCode, "| errorMessage:", r2.errorMessage);
console.log("resumed conversation:", r2.sessionParams?.conversationId === r1.sessionParams?.conversationId ? "PASS — same conversation id" : `DIFFERENT (${r2.sessionParams?.conversationId})`);
console.log("--conversation passed:", run2.getMeta()?.commandArgs?.includes("--conversation") ? "yes" : "NO");
console.log("summary:", r2.summary);
console.log("recalled APPLE:", /apple/i.test(String(r2.resultJson?.response ?? r2.summary ?? "")) ? "PASS — model recalled prior turn" : "did not recall");

// ── Run 3: stale conversation id must not be resumed (cwd mismatch) ─────────
const run3 = makeCtx({
  runId: "run-3",
  prompt: "Reply with only: OK",
  sessionParams: { conversationId: r1.sessionParams.conversationId, cwd: "/some/other/place" },
});
const r3 = await adapter.execute(run3.ctx);
console.log("\n--- RUN 3 (cwd mismatch) ---");
console.log("refused to resume:", run3.getMeta()?.commandArgs?.includes("--conversation") ? "FAIL — resumed anyway" : "PASS — started fresh conversation");
console.log("warned operator:", run3.logs.some(([, c]) => c.includes("will not be resumed")) ? "PASS" : "no warning logged");
console.log("new conversation id differs:", r3.sessionParams?.conversationId !== r1.sessionParams?.conversationId ? "PASS" : "FAIL");

fs.rmSync(cwd, { recursive: true, force: true });
console.log("\nE2E DONE");
