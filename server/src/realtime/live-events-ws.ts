import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import type { DeploymentMode, LiveEvent } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

// Coalesce high-frequency run-log chunks into at most one send per window so the client renderer isn't drowned by per-chunk JSON.parse.
const RUN_LOG_FLUSH_INTERVAL_MS = 150;
// Cap concatenated live bytes per run+stream per flush; oldest whole chunks are dropped since the full log is persisted in the DB.
// A single source chunk is already capped at MAX_LIVE_LOG_CHUNK_BYTES (8KiB) upstream, so this budget always holds several chunks.
const MAX_RUN_LOG_FLUSH_BYTES = 64 * 1024;

// One coalesced source chunk, kept per-segment so the client can reproduce the exact per-line dedupe key of the persisted log.
interface RunLogSegment {
  ts: string;
  chunk: string;
}

interface RunLogBuffer {
  event: LiveEvent;
  segments: RunLogSegment[];
  bytes: number;
  truncated: boolean;
}

// Forwards live events to one socket: run.log chunks are coalesced per (runId, stream); every other event type is sent immediately.
export function createLiveEventForwarder(send: (data: string) => void) {
  const logBuffers = new Map<string, RunLogBuffer>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    flushTimer = null;
    for (const buffer of logBuffers.values()) {
      const merged: LiveEvent = {
        ...buffer.event,
        payload: {
          ...buffer.event.payload,
          // Joined chunk for single-line consumers (AgentDetail / plugin host); per-chunk segments for dedupe-aware consumers.
          chunk: buffer.segments.map((segment) => segment.chunk).join(""),
          truncated: buffer.truncated,
          segments: buffer.segments,
        },
      };
      send(JSON.stringify(merged));
    }
    logBuffers.clear();
  };

  const enqueueLog = (event: LiveEvent) => {
    const payload = event.payload ?? {};
    const runId = typeof payload.runId === "string" ? payload.runId : "";
    const stream = typeof payload.stream === "string" ? payload.stream : "stdout";
    const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
    const ts = typeof payload.ts === "string" ? payload.ts : event.createdAt;
    const key = `${runId} ${stream}`;

    let buffer = logBuffers.get(key);
    if (!buffer) {
      buffer = { event, segments: [], bytes: 0, truncated: false };
      logBuffers.set(key, buffer);
    }
    buffer.event = event; // keep newest event as the flush template (latest ts/id)
    buffer.segments.push({ ts, chunk });
    buffer.bytes += Buffer.byteLength(chunk, "utf8");
    if (payload.truncated === true) buffer.truncated = true;

    // Drop oldest whole chunks (never split mid-char) until within budget; always keep the newest.
    while (buffer.bytes > MAX_RUN_LOG_FLUSH_BYTES && buffer.segments.length > 1) {
      const dropped = buffer.segments.shift() as RunLogSegment;
      buffer.bytes -= Buffer.byteLength(dropped.chunk, "utf8");
      buffer.truncated = true;
    }

    if (flushTimer === null) flushTimer = setTimeout(flush, RUN_LOG_FLUSH_INTERVAL_MS);
  };

  return {
    handle(event: LiveEvent) {
      if (event.type === "heartbeat.run.log") {
        enqueueLog(event);
        return;
      }
      send(JSON.stringify(event));
    },
    dispose() {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      logBuffers.clear();
    },
  };
}

interface WsSocket {
  readyState: number;
  ping(): void;
  send(data: string): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "pong", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  on(event: "connection", listener: (socket: WsSocket, req: IncomingMessage) => void): void;
  on(event: "close", listener: () => void): void;
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: { OPEN: number };
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

interface UpgradeContext {
  companyId: string;
  actorType: "board" | "agent";
  actorId: string;
}

interface IncomingMessageWithContext extends IncomingMessage {
  paperclipUpgradeContext?: UpgradeContext;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`);
  socket.destroy();
}

function parseCompanyId(pathname: string) {
  const match = pathname.match(/^\/api\/companies\/([^/]+)\/events\/ws$/);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
}

function parseBearerToken(rawAuth: string | string[] | undefined) {
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function headersFromIncomingMessage(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

async function authorizeUpgrade(
  db: Db,
  req: IncomingMessage,
  companyId: string,
  url: URL,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
): Promise<UpgradeContext | null> {
  const queryToken = url.searchParams.get("token")?.trim() ?? "";
  const authToken = parseBearerToken(req.headers.authorization);
  const token = authToken ?? (queryToken.length > 0 ? queryToken : null);

  // Browser board context has no bearer token in local_trusted and authenticated modes.
  if (!token) {
    if (opts.deploymentMode === "local_trusted") {
      return {
        companyId,
        actorType: "board",
        actorId: "board",
      };
    }

    if (opts.deploymentMode !== "authenticated" || !opts.resolveSessionFromHeaders) {
      return null;
    }

    const session = await opts.resolveSessionFromHeaders(headersFromIncomingMessage(req));
    const userId = session?.user?.id;
    if (!userId) return null;

    const [roleRow, memberships] = await Promise.all([
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
      db
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        ),
    ]);

    const hasCompanyMembership = memberships.some((row) => row.companyId === companyId);
    if (!roleRow && !hasCompanyMembership) return null;

    return {
      companyId,
      actorType: "board",
      actorId: userId,
    };
  }

  const tokenHash = hashToken(token);
  const key = await db
    .select()
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
    .then((rows) => rows[0] ?? null);

  if (!key || key.companyId !== companyId) {
    return null;
  }

  await db
    .update(agentApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentApiKeys.id, key.id));

  return {
    companyId,
    actorType: "agent",
    actorId: key.agentId,
  };
}

export function setupLiveEventsWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const wss = new WebSocketServer({ noServer: true });
  const cleanupByClient = new Map<WsSocket, () => void>();
  const aliveByClient = new Map<WsSocket, boolean>();

  const pingInterval = setInterval(() => {
    for (const socket of wss.clients) {
      if (!aliveByClient.get(socket)) {
        socket.terminate();
        continue;
      }
      aliveByClient.set(socket, false);
      socket.ping();
    }
  }, 30000);

  wss.on("connection", (socket: WsSocket, req: IncomingMessage) => {
    const context = (req as IncomingMessageWithContext).paperclipUpgradeContext;
    if (!context) {
      socket.close(1008, "missing context");
      return;
    }

    const forwarder = createLiveEventForwarder((data) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(data);
    });
    const unsubscribe = subscribeCompanyLiveEvents(context.companyId, (event) => {
      forwarder.handle(event);
    });

    cleanupByClient.set(socket, () => {
      unsubscribe();
      forwarder.dispose();
    });
    aliveByClient.set(socket, true);

    socket.on("pong", () => {
      aliveByClient.set(socket, true);
    });

    socket.on("close", () => {
      const cleanup = cleanupByClient.get(socket);
      if (cleanup) cleanup();
      cleanupByClient.delete(socket);
      aliveByClient.delete(socket);
    });

    socket.on("error", (err: Error) => {
      logger.warn({ err, companyId: context.companyId }, "live websocket client error");
    });
  });

  wss.on("close", () => {
    clearInterval(pingInterval);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url) {
      rejectUpgrade(socket, "400 Bad Request", "missing url");
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const companyId = parseCompanyId(url.pathname);
    if (!companyId) {
      socket.destroy();
      return;
    }

    void authorizeUpgrade(db, req, companyId, url, {
      deploymentMode: opts.deploymentMode,
      resolveSessionFromHeaders: opts.resolveSessionFromHeaders,
    })
      .then((context) => {
        if (!context) {
          rejectUpgrade(socket, "403 Forbidden", "forbidden");
          return;
        }

        const reqWithContext = req as IncomingMessageWithContext;
        reqWithContext.paperclipUpgradeContext = context;

        wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
          wss.emit("connection", ws, reqWithContext);
        });
      })
      .catch((err) => {
        logger.error({ err, path: req.url }, "failed websocket upgrade authorization");
        rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
      });
  });

  return wss;
}
