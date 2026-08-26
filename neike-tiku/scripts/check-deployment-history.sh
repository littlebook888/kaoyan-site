#!/usr/bin/env bash

set -euo pipefail

canonical_ref="${CANONICAL_REF:-origin/main}"
deployment_ref="${DEPLOYMENT_REF:-sites/main}"
source_ref="${SOURCE_REF:-HEAD}"

require_commit() {
  local ref="$1"

  if ! git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null; then
    echo "ERROR: required Git ref '${ref}' is missing." >&2
    echo "Fetch the canonical and Sites source repositories before deploying." >&2
    exit 1
  fi
}

require_commit "$canonical_ref"
require_commit "$deployment_ref"
require_commit "$source_ref"

if ! git merge-base "$canonical_ref" "$deployment_ref" >/dev/null; then
  echo "ERROR: '${canonical_ref}' and '${deployment_ref}' have unrelated histories." >&2
  echo "Refusing deployment. Restore the Sites source branch from canonical main; do not create or extend a snapshot history." >&2
  exit 1
fi

canonical_sha="$(git rev-parse "${canonical_ref}^{commit}")"
source_sha="$(git rev-parse "${source_ref}^{commit}")"

if [[ "$source_sha" != "$canonical_sha" ]]; then
  echo "ERROR: deployment source '${source_ref}' is not the canonical remote head '${canonical_ref}'." >&2
  echo "Push canonical main first, then deploy that exact commit." >&2
  exit 1
fi

if ! git merge-base --is-ancestor "$deployment_ref" "$source_ref"; then
  echo "ERROR: '${deployment_ref}' is not an ancestor of '${source_ref}'." >&2
  echo "A normal fast-forward Sites source push would fail; refusing deployment." >&2
  exit 1
fi

echo "Git history check passed: ${deployment_ref} can fast-forward to ${source_ref}."
