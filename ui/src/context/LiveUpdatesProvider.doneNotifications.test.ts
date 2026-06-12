// @vitest-environment node

const { getIssueMock } = vi.hoisted(() => ({
  getIssueMock: vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    get: getIssueMock,
    getComment: vi.fn(),
  },
}));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { __liveUpdatesTestUtils } from "./LiveUpdatesProvider";
import { queryKeys } from "../lib/queryKeys";

const COMPANY_ID = "company-1";
const USER_ID = "user-1";

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "ACME-12",
    title: "Ship the widget",
    status: "done",
    assigneeUserId: USER_ID,
    createdByUserId: null,
    ...overrides,
  };
}

function makeQueryClient(issue: Record<string, unknown> | null) {
  return {
    invalidateQueries: vi.fn(),
    getQueryData: (queryKey: unknown) => {
      if (!issue) return undefined;
      const detailKey = queryKeys.issues.detail(issue.id as string);
      if (JSON.stringify(queryKey) === JSON.stringify(detailKey)) return issue;
      return undefined;
    },
  };
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    entityType: "issue",
    entityId: "issue-1",
    action: "issue.updated",
    actorType: "agent",
    actorId: "agent-9",
    details: { status: "done" },
    ...overrides,
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    isActive: () => true,
    isForegrounded: () => false,
    getPathname: () => "/ACME/issues/ACME-12",
    showNotification: vi.fn(),
    ...overrides,
  };
}

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  getIssueMock.mockReset();
});

describe("maybeNotifyIssueDone", () => {
  it("notifies for a done transition on an issue assigned to the current user", async () => {
    const deps = makeDeps();
    __liveUpdatesTestUtils.maybeNotifyIssueDone(
      makeQueryClient(makeIssue()) as never,
      COMPANY_ID,
      makePayload(),
      { userId: USER_ID, agentId: null },
      deps as never,
    );
    await flushAsync();
    expect(deps.showNotification).toHaveBeenCalledWith({
      issueId: "issue-1",
      title: "ACME-12 is done",
      body: "Ship the widget",
      href: "/ACME/issues/ACME-12",
    });
  });

  it("notifies for a done transition on an issue created by the current user", async () => {
    const deps = makeDeps();
    __liveUpdatesTestUtils.maybeNotifyIssueDone(
      makeQueryClient(makeIssue({ assigneeUserId: null, createdByUserId: USER_ID })) as never,
      COMPANY_ID,
      makePayload(),
      { userId: USER_ID, agentId: null },
      deps as never,
    );
    await flushAsync();
    expect(deps.showNotification).toHaveBeenCalled();
  });

  it("skips issues the current user neither created nor is assigned to", async () => {
    const deps = makeDeps();
    __liveUpdatesTestUtils.maybeNotifyIssueDone(
      makeQueryClient(makeIssue({ assigneeUserId: "someone-else", createdByUserId: "another" })) as never,
      COMPANY_ID,
      makePayload(),
      { userId: USER_ID, agentId: null },
      deps as never,
    );
    await flushAsync();
    expect(deps.showNotification).not.toHaveBeenCalled();
  });

  it("skips when the toggle is inactive", async () => {
    const deps = makeDeps({ isActive: () => false });
    __liveUpdatesTestUtils.maybeNotifyIssueDone(
      makeQueryClient(makeIssue()) as never,
      COMPANY_ID,
      makePayload(),
      { userId: USER_ID, agentId: null },
      deps as never,
    );
    await flushAsync();
    expect(deps.showNotification).not.toHaveBeenCalled();
  });

  it("skips when the board tab is foregrounded", async () => {
    const deps = makeDeps({ isForegrounded: () => true });
    __liveUpdatesTestUtils.maybeNotifyIssueDone(
      makeQueryClient(makeIssue()) as never,
      COMPANY_ID,
      makePayload(),
      { userId: USER_ID, agentId: null },
      deps as never,
    );
    await flushAsync();
    expect(deps.showNotification).not.toHaveBeenCalled();
  });

  it("skips when the current user performed the update themselves", async () => {
    const deps = makeDeps();
    __liveUpdatesTestUtils.maybeNotifyIssueDone(
      makeQueryClient(makeIssue()) as never,
      COMPANY_ID,
      makePayload({ actorType: "user", actorId: USER_ID }),
      { userId: USER_ID, agentId: null },
      deps as never,
    );
    await flushAsync();
    expect(deps.showNotification).not.toHaveBeenCalled();
  });

  it("skips non-done status transitions such as cancelled", async () => {
    const deps = makeDeps();
    __liveUpdatesTestUtils.maybeNotifyIssueDone(
      makeQueryClient(makeIssue({ status: "cancelled" })) as never,
      COMPANY_ID,
      makePayload({ details: { status: "cancelled" } }),
      { userId: USER_ID, agentId: null },
      deps as never,
    );
    await flushAsync();
    expect(deps.showNotification).not.toHaveBeenCalled();
  });

  it("falls back to fetching the issue when it is not cached", async () => {
    getIssueMock.mockResolvedValueOnce(makeIssue());
    const deps = makeDeps();
    __liveUpdatesTestUtils.maybeNotifyIssueDone(
      makeQueryClient(null) as never,
      COMPANY_ID,
      makePayload(),
      { userId: USER_ID, agentId: null },
      deps as never,
    );
    await flushAsync();
    expect(getIssueMock).toHaveBeenCalledWith("issue-1");
    expect(deps.showNotification).toHaveBeenCalled();
  });

  it("stays silent when the fallback fetch fails", async () => {
    getIssueMock.mockRejectedValueOnce(new Error("offline"));
    const deps = makeDeps();
    __liveUpdatesTestUtils.maybeNotifyIssueDone(
      makeQueryClient(null) as never,
      COMPANY_ID,
      makePayload(),
      { userId: USER_ID, agentId: null },
      deps as never,
    );
    await flushAsync();
    expect(deps.showNotification).not.toHaveBeenCalled();
  });
});
