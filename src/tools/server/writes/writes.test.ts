import { afterEach, describe, expect, it, vi } from "vitest";
import { selectManifests, toolManifests } from "../../registry.js";
import type { ToolManifest } from "../../registry.js";
import { envelope, makeServerCtx } from "../../../../test/test-helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function find(name: string): ToolManifest {
  const manifest = toolManifests.find((m) => m.name === name);
  if (!manifest) throw new Error(`manifest not found: ${name}`);
  return manifest;
}

const ARGS = { projectKey: "PLAT", repositorySlug: "api" } as const;

interface Route {
  match: (url: URL, init: RequestInit) => boolean;
  respond: () => { status?: number; body: unknown };
}

function routedCtx(routes: Route[]) {
  return makeServerCtx((url, init) => {
    for (const route of routes) {
      if (route.match(url, init)) return route.respond();
    }
    return { status: 500, body: { errors: [{ message: `unrouted ${String(init.method)} ${url.pathname}` }] } };
  });
}

const PR = (version: number, extra: Record<string, unknown> = {}) => ({
  id: 101,
  title: "Test PR",
  state: "OPEN",
  version,
  createdDate: 1_700_000_000_000,
  updatedDate: 1_700_100_000_000,
  author: { user: { name: "dev1", displayName: "Dev One" } },
  fromRef: { displayId: "feature/x", latestCommit: "abc123", repository: { slug: "api", project: { key: "PLAT" } } },
  toRef: { displayId: "master", latestCommit: "def456", repository: { slug: "api", project: { key: "PLAT" } } },
  participants: [],
  ...extra,
});

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body));
}

describe("branch writes", () => {
  it("bb_create_branch creates a branch via branch-admin", async () => {
    const { ctx, captured, restore } = routedCtx([
      {
        match: (url) => url.pathname.endsWith("/branch-admin/1.0/projects/PLAT/repos/api/branches"),
        respond: () => ({ body: { id: "refs/heads/feature/mcp", displayId: "feature/mcp" } }),
      },
    ]);
    try {
      const result = (await find("bb_create_branch").handler(
        { ...ARGS, name: "feature/mcp", startPoint: "master" },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toEqual({ created: true, displayId: "feature/mcp", startPoint: "master" });
      expect(captured[0].init.method).toBe("POST");
      expect(bodyOf(captured[0].init)).toEqual({ name: "feature/mcp", startPoint: "master" });
    } finally {
      restore();
    }
  });

  it("bb_delete_branch refuses the default branch with DELETE_REFUSED", async () => {
    const { ctx, captured, restore } = routedCtx([
      {
        match: (url) => url.pathname.endsWith("/branches") && url.searchParams.get("details") === "true",
        respond: () => ({ body: envelope([{ displayId: "master", type: "BRANCH", isDefault: true }]) }),
      },
    ]);
    try {
      await expect(find("bb_delete_branch").handler({ ...ARGS, name: "master" }, ctx)).rejects.toMatchObject({
        code: "DELETE_REFUSED",
      });
      expect(captured).toHaveLength(1); // only the detection GET, no DELETE
    } finally {
      restore();
    }
  });

  it("bb_delete_branch deletes a non-default branch", async () => {
    const { ctx, captured, restore } = routedCtx([
      {
        match: (url) => url.pathname.endsWith("/branches") && url.searchParams.get("details") === "true",
        respond: () => ({ body: envelope([{ displayId: "feature/mcp", type: "BRANCH", isDefault: false }]) }),
      },
      {
        match: (url, init) => url.pathname.endsWith("/branches") && init.method === "DELETE",
        respond: () => ({ body: {} }),
      },
    ]);
    try {
      const result = (await find("bb_delete_branch").handler({ ...ARGS, name: "feature/mcp" }, ctx)) as Record<string, unknown>;
      expect(result).toEqual({ deleted: true, name: "feature/mcp" });
      expect(captured[1].init.method).toBe("DELETE");
      expect(captured[1].url.searchParams.get("name")).toBe("feature/mcp");
    } finally {
      restore();
    }
  });
});

describe("create pull request", () => {
  it("pre-fills reviewers from the required-reviewers service", async () => {
    const { ctx, captured, restore } = routedCtx([
      {
        match: (url) => url.pathname.includes("/default-reviewers/1.0/"),
        respond: () => ({ body: [{ name: "rev1" }, { user: { name: "rev2" } }] }),
      },
      {
        match: (url, init) => init.method === "POST" && url.pathname.endsWith("/pull-requests"),
        respond: () => ({ body: PR(1) }),
      },
    ]);
    try {
      const result = (await find("bb_create_pull_request").handler(
        { ...ARGS, title: "Test PR", fromBranch: "feature/mcp", toBranch: "master" },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ id: 101, title: "Test PR" });
      const createBody = bodyOf(captured[1].init);
      expect(createBody["reviewers"]).toEqual([{ user: { name: "rev1" } }, { user: { name: "rev2" } }]);
      expect(createBody["fromRef"]).toMatchObject({ id: "refs/heads/feature/mcp" });
      expect(createBody["toRef"]).toMatchObject({ id: "refs/heads/master" });
    } finally {
      restore();
    }
  });

  it("continues with a manual-reviewer note when the service is 404", async () => {
    const { ctx, restore } = routedCtx([
      {
        match: (url) => url.pathname.includes("/default-reviewers/1.0/"),
        respond: () => ({ status: 404, body: {} }),
      },
      {
        match: (url, init) => init.method === "POST" && url.pathname.endsWith("/pull-requests"),
        respond: () => ({ body: PR(1) }),
      },
    ]);
    try {
      const result = (await find("bb_create_pull_request").handler(
        { ...ARGS, title: "Test PR", fromBranch: "feature/mcp", toBranch: "master" },
        ctx,
      )) as Record<string, unknown>;
      expect(String(result["reviewerNote"])).toContain("manually");
    } finally {
      restore();
    }
  });

  it("supports fork sources via fromProjectKey/fromRepositorySlug", async () => {
    const { ctx, captured, restore } = routedCtx([
      {
        match: (url) => url.pathname.includes("/default-reviewers/1.0/"),
        respond: () => ({ body: [] }),
      },
      {
        match: (url, init) => init.method === "POST" && url.pathname.endsWith("/pull-requests"),
        respond: () => ({ body: PR(1) }),
      },
    ]);
    try {
      await find("bb_create_pull_request").handler(
        { ...ARGS, title: "Fork PR", fromBranch: "fix", toBranch: "main", fromProjectKey: "FORK", fromRepositorySlug: "api-copy" },
        ctx,
      );
      const createBody = bodyOf(captured[1].init);
      expect(createBody["fromRef"]["repository"]).toEqual({ slug: "api-copy", project: { key: "FORK" } });
      expect(createBody["toRef"]["repository"]).toEqual({ slug: "api", project: { key: "PLAT" } });
    } finally {
      restore();
    }
  });

  it("maps 403 permission errors to AUTH_FAILED", async () => {
    const { ctx, restore } = routedCtx([
      {
        match: (url, init) => init.method === "POST" && url.pathname.endsWith("/pull-requests"),
        respond: () => ({ status: 403, body: {} }),
      },
    ]);
    try {
      await expect(
        find("bb_create_pull_request").handler({ ...ARGS, title: "x", fromBranch: "a", toBranch: "b" }, ctx),
      ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    } finally {
      restore();
    }
  });
});

describe("optimistic-lock flows", () => {
  it("bb_update_pull_request retries once on 409 with the fresh version", async () => {
    let fetchCount = 0;
    let putCount = 0;
    const { ctx, captured, restore } = routedCtx([
      {
        match: (url, init) => init.method === "GET" && /\/pull-requests\/101$/.test(url.pathname),
        respond: () => {
          fetchCount += 1;
          return { body: PR(fetchCount === 1 ? 3 : 4) };
        },
      },
      {
        match: (url, init) => init.method === "PUT" && /\/pull-requests\/101$/.test(url.pathname),
        respond: () => {
          putCount += 1;
          if (putCount === 1) return { status: 409, body: { errors: [{ message: "version conflict" }] } };
          return { body: PR(4, { title: "Renamed PR" }) };
        },
      },
    ]);
    try {
      const result = (await find("bb_update_pull_request").handler(
        { ...ARGS, pullRequestId: 101, title: "Renamed PR" },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ id: 101, title: "Renamed PR", version: 4 });
      expect(fetchCount).toBe(2);
      expect(putCount).toBe(2);
      expect(bodyOf(captured[1].init)["version"]).toBe(3);
      expect(bodyOf(captured[3].init)["version"]).toBe(4);
    } finally {
      restore();
    }
  });

  it("bb_reopen_pull_request retries once on 409", async () => {
    let fetchCount = 0;
    let reopenCount = 0;
    const { ctx, restore } = routedCtx([
      {
        match: (url, init) => init.method === "GET" && /\/pull-requests\/101$/.test(url.pathname),
        respond: () => {
          fetchCount += 1;
          return { body: PR(fetchCount === 1 ? 5 : 6, { state: "DECLINED" }) };
        },
      },
      {
        match: (url, init) => init.method === "POST" && url.pathname.endsWith("/reopen"),
        respond: () => {
          reopenCount += 1;
          if (reopenCount === 1) return { status: 409, body: {} };
          return { body: PR(7, { state: "OPEN" }) };
        },
      },
    ]);
    try {
      const result = (await find("bb_reopen_pull_request").handler({ ...ARGS, pullRequestId: 101 }, ctx)) as Record<string, unknown>;
      expect(result).toMatchObject({ state: "OPEN" });
      expect(fetchCount).toBe(2);
      expect(reopenCount).toBe(2);
    } finally {
      restore();
    }
  });

  it("bb_update_pull_request_comment resolves a thread with a 409 retry", async () => {
    let fetchCount = 0;
    let putCount = 0;
    const { ctx, restore } = routedCtx([
      {
        match: (url, init) => init.method === "GET" && /\/comments\/9$/.test(url.pathname),
        respond: () => {
          fetchCount += 1;
          return {
            body: { comment: { id: 9, version: fetchCount, text: "fix this", severity: "NORMAL", state: "OPEN" } },
          };
        },
      },
      {
        match: (url, init) => init.method === "PUT" && /\/comments\/9$/.test(url.pathname),
        respond: () => {
          putCount += 1;
          if (putCount === 1) return { status: 409, body: {} };
          return { body: { comment: { id: 9, version: 3, text: "fix this", severity: "NORMAL", state: "RESOLVED" } } };
        },
      },
    ]);
    try {
      const result = (await find("bb_update_pull_request_comment").handler(
        { ...ARGS, pullRequestId: 101, commentId: 9, state: "RESOLVED" },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ id: 9, state: "RESOLVED" });
      expect(fetchCount).toBe(2);
      expect(putCount).toBe(2);
    } finally {
      restore();
    }
  });
});

describe("merge lifecycle", () => {
  it("bb_merge_pull_request does not auto-retry on 409 and sends the strategy", async () => {
    let mergeCount = 0;
    const { ctx, captured, restore } = routedCtx([
      {
        match: (url, init) => init.method === "GET" && /\/pull-requests\/101$/.test(url.pathname),
        respond: () => ({ body: PR(8) }),
      },
      {
        match: (url, init) => init.method === "POST" && url.pathname.endsWith("/merge"),
        respond: () => {
          mergeCount += 1;
          return { status: 409, body: { errors: [{ message: "new commits landed" }] } };
        },
      },
    ]);
    try {
      await expect(
        find("bb_merge_pull_request").handler({ ...ARGS, pullRequestId: 101, strategy: "squash" }, ctx),
      ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
      expect(mergeCount).toBe(1);
      const body = bodyOf(captured[1].init);
      expect(body["version"]).toBe(8);
      expect(body["strategy"]).toEqual({ id: "squash" });
    } finally {
      restore();
    }
  });

  it("bb_can_merge_pull_request reports vetoes", async () => {
    const { ctx, restore } = routedCtx([
      {
        match: (url) => url.pathname.endsWith("/pull-requests/101/merge"),
        respond: () => ({
          body: {
            canMerge: false,
            conflicted: true,
            vetoes: [{ summaryMessage: "Merge conflicts detected", detailedMessage: "Resolve conflicts first." }],
          },
        }),
      },
    ]);
    try {
      const result = (await find("bb_can_merge_pull_request").handler({ ...ARGS, pullRequestId: 101 }, ctx)) as Record<string, unknown>;
      expect(result).toMatchObject({ canMerge: false, conflicted: true });
      const vetoes = result["vetoes"] as Record<string, unknown>[];
      expect(vetoes[0]["summary"]).toContain("conflict");
    } finally {
      restore();
    }
  });

  it("bb_decline_pull_request declines with the current version", async () => {
    const { ctx, captured, restore } = routedCtx([
      {
        match: (url, init) => init.method === "GET" && /\/pull-requests\/101$/.test(url.pathname),
        respond: () => ({ body: PR(2, { state: "OPEN" }) }),
      },
      {
        match: (url, init) => init.method === "POST" && url.pathname.endsWith("/decline"),
        respond: () => ({ body: PR(3, { state: "DECLINED" }) }),
      },
    ]);
    try {
      const result = (await find("bb_decline_pull_request").handler(
        { ...ARGS, pullRequestId: 101, message: "not ready" },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ state: "DECLINED" });
      const declineBody = bodyOf(captured[1].init);
      expect(declineBody["version"]).toBe(2);
      expect(declineBody["message"]).toBe("not ready");
    } finally {
      restore();
    }
  });
});

describe("comment writes", () => {
  it("bb_post_pull_request_comment posts a PR-level comment", async () => {
    const { ctx, captured, restore } = routedCtx([
      {
        match: (url, init) => init.method === "POST" && url.pathname.endsWith("/comments"),
        respond: () => ({ body: { comment: { id: 7, text: "looks good", severity: "NORMAL", state: "OPEN", pending: false } } }),
      },
    ]);
    try {
      const result = (await find("bb_post_pull_request_comment").handler(
        { ...ARGS, pullRequestId: 101, text: "looks good" },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ id: 7, taskCreated: false, pending: false });
      expect(captured[0].init.method).toBe("POST");
    } finally {
      restore();
    }
  });

  it("bb_post_pull_request_comment with BLOCKER severity creates a task", async () => {
    const { ctx, captured, restore } = routedCtx([
      {
        match: (url, init) => init.method === "POST" && url.pathname.endsWith("/comments"),
        respond: () => ({ body: { comment: { id: 8, text: "security hole", severity: "BLOCKER", state: "OPEN" } } }),
      },
      {
        match: (url, init) => init.method === "POST" && url.pathname.endsWith("/tasks"),
        respond: () => ({ body: { id: 55, state: "OPEN" } }),
      },
    ]);
    try {
      const result = (await find("bb_post_pull_request_comment").handler(
        { ...ARGS, pullRequestId: 101, text: "security hole", severity: "BLOCKER" },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ id: 8, taskCreated: true });
      const taskBody = bodyOf(captured[1].init);
      expect(taskBody["anchor"]).toEqual({ id: 8, type: "COMMENT" });
      expect(taskBody["state"]).toBe("OPEN");
    } finally {
      restore();
    }
  });

  it("bb_post_pull_request_comment posts inline anchors with startLine", async () => {
    const { ctx, captured, restore } = routedCtx([
      {
        match: (url, init) => init.method === "POST" && url.pathname.endsWith("/comments"),
        respond: () => ({ body: { comment: { id: 10, text: "suggestion", severity: "NORMAL", state: "OPEN" } } }),
      },
    ]);
    try {
      await find("bb_post_pull_request_comment").handler(
        {
          ...ARGS,
          pullRequestId: 101,
          text: "suggestion",
          file: "src/a.ts",
          line: 12,
          startLine: 8,
          lineType: "ADDED",
        },
        ctx,
      );
      expect(bodyOf(captured[0].init)["anchor"]).toEqual({
        path: "src/a.ts",
        line: 12,
        startLine: 8,
        lineType: "ADDED",
        fileType: "TO",
      });
    } finally {
      restore();
    }
  });

  it("bb_post_pull_request_comment rejects inline calls without a line", async () => {
    const { ctx, restore } = makeServerCtx(() => ({ body: {} }));
    try {
      await expect(
        find("bb_post_pull_request_comment").handler({ ...ARGS, pullRequestId: 101, text: "x", file: "a.ts" }, ctx),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    } finally {
      restore();
    }
  });
});

describe("submit review", () => {
  it("resolves the user via the session endpoint and submits the verdict", async () => {
    const { ctx, captured, restore } = routedCtx([
      {
        match: (url) => url.pathname.endsWith("/users/current"),
        respond: () => ({ body: { name: "reviewer1", displayName: "Reviewer" } }),
      },
      {
        match: (url, init) => init.method === "POST" && url.pathname.endsWith("/comments/publish"),
        respond: () => ({ status: 404, body: {} }),
      },
      {
        match: (url, init) => init.method === "PUT" && url.pathname.includes("/participants/reviewer1"),
        respond: () => ({ body: { approved: true, status: "APPROVED" } }),
      },
    ]);
    try {
      const result = (await find("bb_submit_pull_request_review").handler(
        { ...ARGS, pullRequestId: 101, verdict: "APPROVED" },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ userSlug: "reviewer1", verdict: "APPROVED", approved: true });
      expect(String(result["note"] ?? "")).toContain("manually");
      expect(bodyOf(captured[2].init)["status"]).toBe("APPROVED");
    } finally {
      restore();
    }
  });

  it("falls back to the single PR participant", async () => {
    const { ctx, restore } = routedCtx([
      {
        match: (url) => url.pathname.endsWith("/users/current"),
        respond: () => ({ status: 404, body: {} }),
      },
      {
        match: (url, init) => init.method === "GET" && /\/pull-requests\/101$/.test(url.pathname),
        respond: () => ({ body: PR(1, { participants: [{ user: { name: "solo-user" }, role: "AUTHOR" }] }) }),
      },
      {
        match: (url, init) => init.method === "PUT" && url.pathname.includes("/participants/solo-user"),
        respond: () => ({ body: { status: "NEEDS_WORK" } }),
      },
    ]);
    try {
      const result = (await find("bb_submit_pull_request_review").handler(
        { ...ARGS, pullRequestId: 101, verdict: "NEEDS_WORK" },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ userSlug: "solo-user", verdict: "NEEDS_WORK", approved: false });
    } finally {
      restore();
    }
  });

  it("falls back to the consensus of recent activity authors", async () => {
    const { ctx, restore } = routedCtx([
      {
        match: (url) => url.pathname.endsWith("/users/current"),
        respond: () => ({ status: 404, body: {} }),
      },
      {
        match: (url, init) => init.method === "GET" && /\/pull-requests\/101$/.test(url.pathname),
        respond: () => ({ body: PR(1) }), // no participants
      },
      {
        match: (url) => url.pathname.endsWith("/activities"),
        respond: () => ({
          body: {
            values: [
              { action: "DECLINED", user: { name: "ncirak" } },
              { action: "COMMENTED", user: { name: "ncirak" } },
            ],
          },
        }),
      },
      {
        match: (url, init) => init.method === "PUT" && url.pathname.includes("/participants/ncirak"),
        respond: () => ({ body: { status: "NEEDS_WORK" } }),
      },
    ]);
    try {
      const result = (await find("bb_submit_pull_request_review").handler(
        { ...ARGS, pullRequestId: 101, verdict: "NEEDS_WORK" },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ userSlug: "ncirak", verdict: "NEEDS_WORK" });
    } finally {
      restore();
    }
  });

  it("fails with VALIDATION when the identity cannot be resolved", async () => {
    const { ctx, restore } = routedCtx([
      {
        match: (url) => url.pathname.endsWith("/users/current"),
        respond: () => ({ status: 404, body: {} }),
      },
      {
        match: (url, init) => init.method === "GET" && /\/pull-requests\/101$/.test(url.pathname),
        respond: () => ({ body: PR(1) }),
      },
    ]);
    try {
      await expect(
        find("bb_submit_pull_request_review").handler({ ...ARGS, pullRequestId: 101, verdict: "APPROVED" }, ctx),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    } finally {
      restore();
    }
  });
});

describe("read-only gating", () => {
  it("hides every write tool when BITBUCKET_READ_ONLY=true", () => {
    const advertised = selectManifests(toolManifests, "server", true).map((m) => m.name);
    expect(advertised).toHaveLength(18);
    for (const writeTool of [
      "bb_create_branch",
      "bb_delete_branch",
      "bb_create_pull_request",
      "bb_merge_pull_request",
      "bb_submit_pull_request_review",
    ]) {
      expect(advertised).not.toContain(writeTool);
    }
  });
});
