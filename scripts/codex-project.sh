#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# Do not inherit the unrelated home-directory Git repository as this project.
# Other CLI arguments can select resume/exec or supply the user's feature prompt.
exec codex --strict-config -C "$project_dir" \
  -c 'project_root_markers=[]' "$@"
