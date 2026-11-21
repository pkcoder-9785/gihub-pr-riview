# Multi-agent setup validation

Date: 22 November 2026 (Asia/Kolkata)

## Outcome

**Passed:** native saved-session delegation using the three configured roles,
with the main session as lead and exactly two named specialist workers. No
application features, application files, or dependency manifests were changed.

## Executed checks

| Check | Observed outcome |
| --- | --- |
| `codex --version` | `codex-cli 0.171.0` |
| `codex debug models` | Live catalog included `gpt-6-luna` with `high` and `gpt-6.1-sol` with `medium` and `high` |
| Required role fields/model pairs | Exactly three files; `name`, `description`, `developer_instructions`, model, and effort declarations checked against the live catalog |
| `bash -n scripts/codex-team.sh` | Exit 0 |
| Launcher + `app-server --print-startup-config` | Strict installed-CLI configuration validation exited 0 |
| App-server `config/read` | Project layer active; root `gpt-6.1-sol/high`; agents enabled; two worker threads; maximum depth 1; `multi_agent_v2=true` |
| Feature inventory | `multi_agent_v2` listed stable and enabled; legacy `multi_agent` listed deprecated |
| Normal saved-session read-only delegation | Both named workers launched concurrently and returned reports reviewed by the lead |
| Own test rollout inspected | Exactly one `spawn_agent` call for `frontend_developer` and one for `backend_developer`; no additional lead |
| Before/after SHA-256 comparison | All seven existing application/dependency files unchanged |

Python on this machine lacks `tomllib`; no Python TOML-parser success is claimed.
The installed Codex parser, effective configuration response, discovered named
roles, and actual worker launches were used for validation instead.

## Live delegation demonstration

Root session ID: `01a1ff6c-1110-7a63-a020-aa6853f6904a`.

| Participant | Configured model / reasoning | Returned task identifier |
| --- | --- | --- |
| Thinking Agent / Orchestrator | `gpt-6.1-sol` / `high` | `/root` |
| Frontend Developer | `gpt-6-luna` / `high` | `/root/frontend_validation` |
| Backend Developer | `gpt-6.1-sol` / `medium` | `/root/backend_validation` |

The root's recorded turn context confirmed `gpt-6.1-sol/high`. The named-worker
launches were confirmed in the test's own rollout. Worker tool results exposed
task identifiers, not separate runtime model telemetry; the worker model/effort
assignments are verified configuration, not independently emitted inference
telemetry.

The lead planned and assigned explicit read-only tasks before launching them.
Both workers had no writable files, no secret access, no package installation,
and no further delegation.

- Frontend inspected the health route and file tree. It reported HTTP 200 JSON
  `{ "status": "ok", "service": "github-pr-review" }`, the absence of a frontend,
  and the need to distinguish liveness from full review readiness in a future UI.
- Backend inspected local Inngest import paths and `functions = []`. It reported
  that the referenced files exist and that `npm test` is a failing placeholder.
- The lead compared both reports with the actual files and reported successful
  completion. These were static read-only checks, not application tests.

Compared files: `app.js`, `index.js`, `config.js`, `package.json`,
`package-lock.json`, `inngest/client.js`, and `inngest/function/index.js`.

## Failures observed and resolution

1. The initial live test used `--ephemeral`. Both worker launches failed with
   `invalid thread-store request: no rollout found`. Although the CLI process
   exited 0, that delegation test failed. A normal saved CLI session resolved
   the startup failure and passed the same read-only scenario.
2. `--strict-config` is unsupported for `codex features` in this version. The
   documented feature-inventory command was corrected to call `codex` directly
   without that flag. Strict validation remains enabled for normal launcher,
   execution, and app-server startup paths.
3. Existing user-level MCP integrations emitted startup warnings. Neither was
   needed for this test; their configuration was not changed.

## Evidence and boundaries

Temporary raw logs from this setup run are in:

- `/private/tmp/code-pr-review-team-smoke/` — initial failed ephemeral run.
- `/private/tmp/code-pr-review-team-smoke-persistent/` — successful saved run,
  including `events.jsonl`, `summary.md`, `stderr.log`, and `exit-code.txt`.

Temporary paths are not durable artifacts. This report and the agent definitions
are the persistent project record. Normal CLI history can be inspected with
`bash scripts/codex-team.sh resume --last`.

No HTTP requests to the application, full runtime tests, dependency installs,
`npm test`, commits, pushes, deployments, or destructive operations were executed
as part of the demonstration. The unfinished PR review bot is not validated by
this setup test.
