# agent-graph

A local dashboard and background daemon for delegations between Claude Code and Codex.
Track agents, models, conversations, and task results in one directed graph, including delegations in both directions.

## Features

- Keep the delegation graph visible while switching projects and sessions.
- Inspect models, conversation history, task output, acceptance checks, and assignment decisions.
- Start sessions and send messages from the dashboard through Herdr. Change models or stop Claude sessions, and retry failed delegations.
- Run dependency-based task plans with approval gates and pull request integration.
- Store history locally, outside your working repositories.

## Quick start

Run this command in a terminal on your Mac:

```bash
curl -fsSL https://raw.githubusercontent.com/ryomac5/agent-graph/main/scripts/install.sh | bash
```

The installer downloads agent-graph and installs missing tools: Node 24, Claude Code, Codex CLI, and Herdr. You do not need to install Git, Node, or Homebrew beforehand.

Complete Claude and Codex sign-in when prompted. If Git's runtime is missing, approve the macOS Command Line Tools installation when its dialog appears. The installer waits for it to finish.

Setup registers the Claude plugin, Codex MCP server, and Herdr integrations, then starts the background services. Open the dashboard URL printed at the end.

Open a new terminal to use the installed CLI commands. Restart any open Claude or Codex clients so they load the new configuration.

Automated installation currently supports **macOS on Apple Silicon and Intel**. An internet connection is required. Agent usage follows each provider's account and billing terms.

### What setup changes

Tools are downloaded from their official distribution sources into your user directory. The downloaded Node archive is checked against its official SHA-256 checksum before execution. Existing tools are reused.

Setup preserves unrelated Codex and shell settings and backs up files before changing them. It registers services for automatic startup at login. Existing Herdr servers are reused, and an unchanged daemon configuration does not trigger a restart. Updates that require a daemon restart stop before changing configuration if delegated tasks are still running.

If you already have the source code, run this from the repository root instead:

```bash
bash scripts/setup.sh
```

### Check or update an installation

In a new terminal:

```bash
agent-graph --doctor   # Check registration and print the dashboard URL
agent-graph --dry-run  # Preview setup changes without applying them
```

Run the installation command again to update agent-graph. Downloaded versions are stored separately so the installer does not overwrite an earlier version.

For unattended setup, `bash scripts/setup.sh --skip-login` skips authentication checks. Authenticate the CLIs separately before delegating tasks.

See the [setup guide (Japanese)](docs/guides/setup.html) for configuration locations and troubleshooting.

## Usage

Ask Claude Code or Codex to delegate a task through the `delegate` MCP tool. The caller supplies a role, a task, and acceptance criteria. The assignment policy selects the model. Child agents can delegate through the same tool, and both Claude-to-Codex and Codex-to-Claude delegations are recorded.

Select a project and session in the dashboard to inspect the graph and conversation. Ended sessions are grouped in history. Planner tasks waiting for a decision expose Approve, Reject, and Retry controls.

Personal assignment policies live in `~/.config/agent-graph/policy.toml`, or under `XDG_CONFIG_HOME` when set.

### Task plans

From the repository root:

```bash
node packages/planner/src/cli.ts run --session <id> [--spec path] [--max-parallel n] [--no-pr]
node packages/planner/src/cli.ts status --session <id>
node packages/planner/src/cli.ts approve <task> --session <id>
node packages/planner/src/cli.ts reject <task> --session <id>
node packages/planner/src/cli.ts retry <task> --session <id>
```

The default task specification is `.agents/graph/<id>/tasks.yaml`.

## Project structure

This repository is a pnpm workspace with five packages.

| Package | Responsibility |
| --- | --- |
| `packages/core` | Events, trace context, assignment policy, execution adapters, acceptance checks, and SQLite storage |
| `packages/daemon` | MCP, dashboard HTTP and SSE, trace ingestion, and usage collection |
| `packages/dashboard` | Delegation graphs, conversation history, and approval controls |
| `packages/adapters` | Installation, Claude plugins, Codex configuration, and client integration |
| `packages/planner` | Dependency-based execution of `tasks.yaml` plans |

## Local storage

Runtime state is stored outside the repositories your agents work on.

| Data | Default location |
| --- | --- |
| Downloaded application versions | `~/.local/share/agent-graph/releases/` |
| Automatically installed tools | `~/.local/share/agent-graph/tools/` |
| Project history | `~/.local/state/agent-graph/<repo-key>/agent-graph.db` |
| Daemon socket and logs | `~/.local/state/agent-graph/run/` |
| Agent worktrees | `~/.cache/agent-graph/worktrees/<repo-key>/<session>/<task>/` |

Setup respects absolute `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, and `CODEX_HOME` paths. Generated configurations should be recreated on each PC rather than copied from another machine. Setup does not migrate session history.

## Troubleshooting

If model names are missing after installation, restart the Claude or Codex client and send a message. Model names come from the client's local conversation records; they may be unavailable before the first turn. Claude records are read from `CLAUDE_CONFIG_DIR` (default: `~/.claude`), including sessions started in a repository subdirectory. Codex records are read from `CODEX_HOME` (default: `~/.codex`).

When Codex does not pass a thread ID to MCP, agent-graph uses the process's open conversation files or a unique thread created near session registration. It saves that association for subsequent daemon restarts. Ambiguous matches remain unresolved rather than showing another conversation's model.

MCP disconnections and Claude SessionEnd hooks move sessions into history. Archived Codex threads also move into history, even if the app server remains running. The daemon checks process liveness at startup and periodically afterward. Hook-only sessions without a process ID expire after 30 minutes without activity.

To update another Mac, publish the changes to the repository, rerun the quick-start installation command there, and restart its Claude and Codex clients.

If startup reports `ERR_MODULE_NOT_FOUND` or `MODULE_NOT_FOUND` for files under `releases/`, rerun the installer. It compares the cached release with the downloaded archive, moves an incomplete or modified copy into a sibling `.incomplete-*` directory, and restores the complete release. Setup verifies the daemon's imports before changing client or service settings. A registered daemon that is stopped can be updated without waiting for its unavailable HTTP server.

## Development

Use Node 24 or later. Runtime code uses Node's standard library; pnpm dependencies are needed for development.

```bash
npx --yes pnpm@10 install
npx --yes pnpm@10 typecheck
npx --yes pnpm@10 test
```

Live end-to-end checks use authenticated Claude and Codex CLIs and may incur provider usage charges:

```bash
AGENT_GRAPH_E2E=1 bash scripts/e2e-stage2.sh  # Delegation in both directions
AGENT_GRAPH_E2E=1 bash scripts/e2e-stage4.sh  # Dashboard
AGENT_GRAPH_E2E=1 bash scripts/e2e-stage5.sh  # Plugins and configuration
AGENT_GRAPH_E2E=1 bash scripts/e2e-stage6.sh  # Planner and review
```

These checks are skipped unless `AGENT_GRAPH_E2E` is set. They isolate state and working repositories in temporary directories.

Please include relevant tests with changes. Follow [AGENTS.md](AGENTS.md) for repository conventions. The [architecture](docs/agents/architecture.md) and [dashboard API contract](docs/agents/dashboard-api.md) document component boundaries and behavior; these documents are currently in Japanese.

## License

[MIT](LICENSE). Claude Code, Codex CLI, and Herdr are installed separately from their official distributions and remain subject to their own licenses and account terms.
