# Project-scoped Codex setup

This directory configures the main Codex session for this project. Work is handled by that session; agent spawning and multi-agent mode are disabled in `config.toml`.

The project launcher keeps Codex scoped to this directory despite the unrelated Git repository at the user's home directory:

```bash
bash scripts/codex-project.sh
bash scripts/codex-project.sh resume --last
```

The main session uses `gpt-6.1-sol` with high reasoning effort, workspace write access, and on-request approvals. Review project trust prompts before trusting this directory.
