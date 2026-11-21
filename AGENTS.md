# Project instructions

## Main-agent workflow

- The main Codex session handles planning, implementation, review, and reporting. Do not create subagents, delegate work, or ask workers to make changes.
- Read `PROJECT_NOTES.md` and inspect the relevant source before project work. Keep changes incremental and within the user's requested scope.
- Before implementation, state a short plan. Define API or data contracts only when the requested change needs them.
- Inspect the completed changes and run only the checks appropriate to the request. Never report a check as passing unless it was run and its result observed. `npm test` is currently a placeholder that exits with failure.
- Update `PROJECT_NOTES.md` after each completed project change with the change and actual checks/results. Keep new project handoff notes in that file unless the user requests otherwise.
- Do not overwrite user changes, reset the workspace, or revert unrelated work.

## Project conventions and safety

- JavaScript ES modules (`type: module`), Express, Inngest, and Octokit already exist. OpenAI Responses API, Zod, and diff parsing are planned; inspect actual dependency declarations before relying on them.
- Preserve the PR review design in `PROJECT_NOTES.md`, including stale-snapshot suppression, valid-finding summary fallback for invalid inline locations, and reconciliation before retrying ambiguous GitHub writes.
- Do not read, print, copy, or commit `.env` secrets, API tokens, or private keys. Use synthetic values when credentials are unnecessary.
- Do not install dependencies, add frameworks, change APIs, or refactor unrelated files solely to make a setup smoke check pass.
- Never commit, push, deploy, or perform destructive operations without explicit user approval.
- Use bounded, targeted checks; report filesystem, dependency, network, and authentication blockers rather than pretending validation succeeded.
