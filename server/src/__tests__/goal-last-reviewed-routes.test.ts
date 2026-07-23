import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGoalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  goalService: () => mockGoalService,
  logActivity: mockLogActivity,
}));

async function createApp() {
  const { errorHandler } = await import("../middleware/index.js");
  const { goalRoutes } = await import("../routes/goals.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", goalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("goal lastReviewedAt patch route", () => {
  const existingGoal = {
    id: "goal-1",
    companyId: "company-1",
    title: "Goal",
    description: null,
    level: "team",
    status: "active",
    parentId: null,
    ownerAgentId: null,
    lastReviewedAt: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue(null);
    mockLogActivity.mockResolvedValue(undefined);
    mockGoalService.getById.mockResolvedValue(existingGoal);
    mockGoalService.update.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({
      ...existingGoal,
      ...data,
    }));
  });

  it("updates lastReviewedAt from an ISO8601 string", async () => {
    const app = await createApp();
    const reviewedAt = "2026-07-23T00:00:00.000Z";
    const res = await request(app)
      .patch("/api/goals/goal-1")
      .send({ lastReviewedAt: reviewedAt });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockGoalService.update).toHaveBeenCalledWith("goal-1", {
      lastReviewedAt: new Date(reviewedAt),
    });
    expect(res.body.lastReviewedAt).toBe(reviewedAt);
  });

  it("clears lastReviewedAt with null", async () => {
    const app = await createApp();
    const res = await request(app)
      .patch("/api/goals/goal-1")
      .send({ lastReviewedAt: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockGoalService.update).toHaveBeenCalledWith("goal-1", { lastReviewedAt: null });
  });

  it("rejects a non-ISO8601 lastReviewedAt", async () => {
    const app = await createApp();
    const res = await request(app)
      .patch("/api/goals/goal-1")
      .send({ lastReviewedAt: "not-a-date" });

    expect(res.status).toBe(400);
    expect(mockGoalService.update).not.toHaveBeenCalled();
  });
});
