# ⚡ BITBUCKET-MCP

A deployment-agnostic [Model Context Protocol](https://modelcontextprotocol.io) server (stdio) for **Bitbucket Server / Data Center**, with a ready adapter seam for **Bitbucket Cloud** — compact cards, pagination-aware listings, optimistic-lock-safe writes.

```text
┌─────────────────────────────────────────────────────────┐
│  🔌 One MCP server, two deployment flavors              │
│  📇 Compact-card outputs — raw payloads never reach LLM │
│  🔒 Read-only mode + automatic 409-retry on writes      │
└─────────────────────────────────────────────────────────┘
```

![npm version](https://img.shields.io/npm/v/@nevzatcirak/bitbucket-mcp)
![npm downloads](https://img.shields.io/npm/dm/@nevzatcirak/bitbucket-mcp)
![CI](https://github.com/nevzatcirak/bitbucket-mcp/actions/workflows/ci.yml/badge.svg)
![Publish](https://github.com/nevzatcirak/bitbucket-mcp/actions/workflows/publish.yml/badge.svg)
![node](https://img.shields.io/node/v/%40nevzatcirak/bitbucket-mcp)
![License](https://img.shields.io/npm/l/%40nevzatcirak/bitbucket-mcp)

> **Server/DC support now, Cloud adapter coming.** The tool layer, output format and pagination are deployment-agnostic from day one. Every tool manifest declares `providers: ["server", "cloud"]`; tools whose manifest does not list the active provider are simply never advertised to the MCP client. Cloud-only tools already respond with a structured `PROVIDER_UNAVAILABLE` error instead of crashing.

---

## 🎯 Why this package

| Pain point | What bitbucket-mcp does |
|---|---|
| Raw REST payloads are huge (links, avatars, HTML) | Every result is projected into a **compact card** — flat JSON, only the fields an agent needs |
| Different pagination per deployment flavor | One convention everywhere: `start`/`limit` in, `isLastPage` + `nextPageStart` out |
| Concurrent writers clobber each other | Write flows go through an **optimistic-lock wrapper**: on `409 Conflict` it re-fetches the current version and retries once, automatically |
| Read-only environments | `BITBUCKET_READ_ONLY=true` hides every write tool from the MCP client |
| Mixed estates | Pick `server` or `cloud` with one env variable; tool availability adapts per provider |

## ✨ Features

| Area | What ships |
|---|---|
| 🧩 Tool registry | Manifest-driven registration with per-tool `providers` + `readOnly` flags |
| ⚙️ Config | Full env-based config with structured problems (the server never crashes on bad config) |
| 🌐 REST client | Token/Basic auth, custom headers, timeouts, normalized error codes |
| 📄 Pagination | Normalized `PageMeta` (`isLastPage`, `nextPageStart`, cursor seam for Cloud) |
| 🔁 Writes | Optimistic-locking retry wrapper (re-fetch + 1 retry on `409`) |
| 📇 Output | `compact-card` projection helpers — raw payloads never reach the LLM |
| 🔎 Tools | **18 Server/DC read-only tools** (below) |

### 🔍 Discovery

| Tool | Purpose | Key parameters |
|---|---|---|
| `bb_get_projects` | List projects | `name?`, `limit`, `start` |
| `bb_get_project` | One project by key | `projectKey` |
| `bb_get_repositories` | List repositories of a project | `projectKey`, `name?`, `limit`, `start` |
| `bb_get_repository` | One repository (+ HTTP clone URL) | `projectKey`, `repositorySlug` |
| `bb_browse_repository` | Browse the file tree | `projectKey`, `repositorySlug`, `path?`, `at?`, `limit`, `start` |
| `bb_get_file_content` | Raw file content, truncated with stats | `projectKey`, `repositorySlug`, `path`, `at?`, `maxChars` |

### 🔎 Code search

| Tool | Purpose | Key parameters |
|---|---|---|
| `bb_search_code` | Lucene code search with modifiers | `query`, `project?`, `repo?`, `path?`, `ext?`, `limit`, `start` |

`query` examples: `"OptimisticLock"`, `"TODO fix path:src/core ext:ts"`, `"retry repo:PLAT/api"`.

### 📖 Pull-request reading

| Tool | Purpose | Key parameters |
|---|---|---|
| `bb_list_pull_requests` | List PRs | `state?` (OPEN\|MERGED\|DECLINED\|ALL), `direction?` (INCOMING\|OUTGOING), `author?` (client-side), `limit`, `start` |
| `bb_get_pull_request` | PR detail with reviewers | `pullRequestId`, `maxDescriptionChars?` |
| `bb_get_pull_request_changes` | File-level changes | `pullRequestId`, `limit`, `start` |
| `bb_get_pull_request_diff` | Per-file diff, smart truncation (head 60% + tail 40% + omission stats) | `pullRequestId`, `path?`, `maxCharsPerFile?` |
| `bb_get_pull_request_builds` | CI build statuses of the source head commit | `pullRequestId`, `limit`, `start` |

### 💬 Review reading

| Tool | Purpose | Key parameters |
|---|---|---|
| `bb_get_pr_comments_and_actions` | Review threads with severity (BLOCKER), tasks and resolution state; resolved threads hidden by default | `pullRequestId`, `severity?` (ALL\|NORMAL\|BLOCKER), `includeResolved?`, `includeReplies?`, `maxTextChars?` |

### 📥 Dashboard

| Tool | Purpose | Key parameters |
|---|---|---|
| `bb_get_dashboard_pull_requests` | Your pull requests by role | `role?` (AUTHOR\|REVIEWER\|PARTICIPANT), `state?` |
| `bb_get_inbox_pull_requests` | Your inbox pull requests | `limit`, `start` |

### 👤 Users, branches, commits

| Tool | Purpose | Key parameters |
|---|---|---|
| `bb_get_user` | User by slug, or name/email search | `userSlug?` or `filter?` |
| `bb_list_branches` | Branches with default-branch detection (`isDefault`) | `projectKey`, `repositorySlug`, `filter?` |
| `bb_list_commits` | Commits with client-side author filter | `since?`, `until?`, `author?`, `includeMerges?` |

All list tools return `{ items: [...], page: { size, limit, start, isLastPage, nextPageStart } }` — pass `start: nextPageStart` to fetch the next page.

## 📦 Installation

**npx (no install):**

```bash
npx @nevzatcirak/bitbucket-mcp --version
```

**Global install:**

```bash
npm install -g @nevzatcirak/bitbucket-mcp
bitbucket-mcp --version
```

**From source:**

```bash
git clone https://github.com/nevzatcirak/bitbucket-mcp.git
cd bitbucket-mcp
npm install
npm run build && node dist/index.js --version
```

## ⚙️ Configuration

| Variable | Required | Description |
|---|---|---|
| `BITBUCKET_URL` | ✅ | Base URL, no trailing slash — e.g. `https://bitbucket.example.com` |
| `BITBUCKET_PROVIDER` | — | `server` (default, Server/DC) or `cloud` (adapter not implemented yet) |
| `BITBUCKET_TOKEN` | A or B | Token auth. Server/DC PAT → `Authorization: Bearer`. Cloud API token → used with the username |
| `BITBUCKET_USERNAME` | A or B | Credential auth (with `BITBUCKET_PASSWORD`) → `Authorization: Basic` |
| `BITBUCKET_PASSWORD` | A or B | See `BITBUCKET_USERNAME` |
| `BITBUCKET_READ_ONLY` | — | `true` hides all write tools from the MCP client |
| `BITBUCKET_CUSTOM_HEADERS` | — | Comma-separated `Name: Value` pairs appended to every request |

**Auth matrix:**

| Deployment | Option A | Option B |
|---|---|---|
| Server / Data Center | `BITBUCKET_TOKEN` (PAT → Bearer) | `BITBUCKET_USERNAME` + `BITBUCKET_PASSWORD` (Basic) |
| Cloud | `BITBUCKET_USERNAME` + `BITBUCKET_TOKEN` (Basic) | *(Bearer-style tokens supported by the client layer)* |

Missing configuration never crashes the server: problems are logged at startup and the affected tools answer with a structured `CONFIG_MISSING` error.

## 🔌 MCP client configuration

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "bitbucket": {
      "command": "npx",
      "args": ["-y", "@nevzatcirak/bitbucket-mcp"],
      "env": {
        "BITBUCKET_URL": "https://bitbucket.example.com",
        "BITBUCKET_PROVIDER": "server",
        "BITBUCKET_TOKEN": "<your-personal-access-token>",
        "BITBUCKET_READ_ONLY": "false"
      }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "bitbucket": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@nevzatcirak/bitbucket-mcp"],
      "env": {
        "BITBUCKET_URL": "https://bitbucket.example.com",
        "BITBUCKET_PROVIDER": "server",
        "BITBUCKET_USERNAME": "<user>",
        "BITBUCKET_PASSWORD": "<password>"
      }
    }
  }
}
```

**OpenCode** (`opencode.json`):

```json
{
  "mcp": {
    "bitbucket": {
      "type": "local",
      "command": [
        "npx", "-y", "@nevzatcirak/bitbucket-mcp"
      ],
      "environment": {
        "BITBUCKET_URL": "https://bitbucket.example.com",
        "BITBUCKET_PROVIDER": "server",
        "BITBUCKET_TOKEN": "<your-personal-access-token>"
      }
    }
  }
}
```

## 🧪 Tool usage examples

```text
▸ "Show the open pull requests on repo 'platform/api', 10 per page"
  → bb_list_pull_requests { projectKey: "PLAT", repositorySlug: "api", state: "OPEN", start: 0, limit: 10 }

  {
    "items": [
      { "id": 101, "title": "Add pagination helper", "state": "OPEN",
        "author": "dev-one", "fromBranch": "feature/x", "toBranch": "main" }
    ],
    "page": { "size": 10, "start": 0, "isLastPage": false, "nextPageStart": 10 }
  }
```

```text
▸ "What did the review say about PR 101?"
  → bb_get_pr_comments_and_actions { projectKey: "PLAT", repositorySlug: "api", pullRequestId: 101 }
  → threads with severity, tasks and replies; resolved threads hidden by default
```

```text
▸ "Show me the diff of PR 101"
  → bb_get_pull_request_diff { projectKey: "PLAT", repositorySlug: "api", pullRequestId: 101 }
  → per-file compact diffs: added/removed counts, head/tail preview, omission stats
```

```text
> "Update the branch restriction to require 2 approvals"   (upcoming write phase)
  → write flow with optimistic locking: fetch version → apply → on 409, re-fetch + retry once
```

## 🚦 Read-only mode

Set `BITBUCKET_READ_ONLY=true` and every write tool disappears from the advertised tool list — not merely errors at call time. Ideal for read-only automation or shared agents.

## 🔒 Optimistic locking

Write flows that target versioned resources use a shared wrapper:

1. Fetch the current resource (including its `version`).
2. Apply the mutation with that version.
3. On `409 Conflict`: re-fetch, re-apply — exactly **one** automatic retry.
4. Any other failure surfaces as a structured error with a stable code (`AUTH_FAILED`, `NOT_FOUND`, `VALIDATION`, `CONFLICT`, `UPSTREAM_ERROR`, …).

## 🗺️ Roadmap

- [x] **Phase 0** — foundation: config, REST client, registry, pagination, compact cards, optimistic-lock wrapper, CI + publish pipelines
- [x] **Phase 1** — Server/DC read tools: repositories, branches, commits, code search, pull requests, reviews, dashboard
- [ ] **Phase 2** — Server/DC write tools with optimistic locking
- [ ] **Phase 3** — Cloud adapter: fill the existing provider seam (cursor-based pagination), Cloud auth

## 🛠️ Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest (tests are colocated with sources)
npm run lint       # eslint
npm run check:org  # CI guard: rejects real organization references in sources
```

Project layout:

```text
src/
├── index.ts                 # stdio entry point
├── version.ts               # name + version single source
├── core/                    # deployment-agnostic layer
│   ├── config.ts            # env config → { config, problems }
│   ├── restClient.ts        # fetch wrapper + RestError normalization
│   ├── provider.ts          # provider seam + pagination styles
│   ├── pagination.ts        # pageQuery / pageMeta / extractPageItems
│   ├── compactCard.ts       # compact-card projection
│   ├── optimisticLock.ts    # 409 → re-fetch → retry-once wrapper
│   ├── errors.ts            # structured MCP error results
│   └── json.ts              # safe JSON accessors
├── providers/
│   ├── server/              # Server/DC adapter (implemented)
│   └── cloud/               # Cloud adapter (seam ready, not implemented)
└── tools/
    └── registry.ts          # manifest-driven tool registration
    └── server/              # Server/DC tool manifests (18 read-only tools)
```

## 🚀 Publishing

Publishing is a manual GitHub Actions trigger (**Publish → Run workflow**). The workflow guards the package name, runs the full gate (lint, tests, build, organization-reference guard) and publishes `@nevzatcirak/bitbucket-mcp` to npm with `NPM_TOKEN`.

## 📄 License

MIT — see [LICENSE](LICENSE).
