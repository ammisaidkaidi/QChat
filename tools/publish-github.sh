#!/usr/bin/env bash
# Create the GitHub repository (if needed) and push the current branch.
#
# Usage:
#   GITHUB_TOKEN=ghp_xxx ./tools/publish-github.sh infagent
#   GITHUB_TOKEN=ghp_xxx ./tools/publish-github.sh my-org/infagent --private
#
# The token needs the `repo` scope (classic) or "Administration: write" +
# "Contents: write" (fine-grained). It is read from the environment only and
# never written to disk or echoed.

set -euo pipefail

NAME="${1:-}"
VISIBILITY="public"

shift || true
for arg in "$@"; do
  case "$arg" in
    --private) VISIBILITY="private" ;;
    --public) VISIBILITY="public" ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "$NAME" ]]; then
  echo "usage: GITHUB_TOKEN=... $0 [owner/]repo-name [--private|--public]" >&2
  exit 2
fi

TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [[ -z "$TOKEN" ]]; then
  echo "error: set GITHUB_TOKEN (or GH_TOKEN) to a token with repo-create permission." >&2
  exit 2
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: run this from inside the git repository." >&2
  exit 2
fi

API="https://api.github.com"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
REPO_PATH="$NAME"
OWNER="${NAME%%/*}"
SHORT_NAME="${NAME##*/}"

payload=$(printf '{"name":"%s","private":%s,"description":"InfAgent — TypeScript agent infrastructure toolkit","has_issues":true,"has_wiki":false,"auto_init":false}' \
  "$SHORT_NAME" "$([[ "$VISIBILITY" == "private" ]] && echo true || echo false)")

if [[ "$NAME" == */* ]]; then
  endpoint="$API/orgs/$OWNER/repos"
else
  endpoint="$API/user/repos"
fi

echo "→ creating or verifying repository $NAME ($VISIBILITY)…"
http_code=$(curl -sS -o /tmp/infagent-repo.json -w '%{http_code}' \
  -X POST "$endpoint" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -d "$payload")

case "$http_code" in
  201) echo "  created." ;;
  422) echo "  already exists — continuing." ;;
  401|403)
    echo "error: GitHub rejected the token (HTTP $http_code)." >&2
    sed -E 's/("token"|"authorization")[^,]*/\1: "***"/g' /tmp/infagent-repo.json >&2
    exit 1
    ;;
  *)
    echo "error: unexpected GitHub response (HTTP $http_code)." >&2
    cat /tmp/infagent-repo.json >&2
    exit 1
    ;;
esac
rm -f /tmp/infagent-repo.json

REMOTE_URL="https://github.com/${REPO_PATH}.git"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE_URL"
else
  git remote add origin "$REMOTE_URL"
fi

if [[ -n "$TOKEN" ]]; then
  # Push with an ephemeral credential helper so the token never lands in .git/config.
  git -c credential.helper='!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f' \
    push -u origin "$BRANCH"
else
  git push -u origin "$BRANCH"
fi

echo "✔ pushed $BRANCH → $REMOTE_URL"
