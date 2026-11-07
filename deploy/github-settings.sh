#!/usr/bin/env bash
# The GitHub settings that keep a public Paperwork repository and its deploys safe, applied with the GitHub CLI
# (https://cli.github.com, signed in as the repository's owner: gh auth login). Safe to run again: each setting is
# simply set once more. DEPLOY.md, "GitHub settings", says why each one matters.
#
#   deploy/github-settings.sh             shows what it will set, asks once, then sets it
#   deploy/github-settings.sh --dry-run   prints the calls and makes none
#
#   1. The deploy branch: no force pushes, not deletable, and a commit must have passed "Type check, test and build"
#      before it lands there (you as an admin can still push in an emergency)
#   2. The "production" environment deploys only from protected branches
#   3. Workflows get a read-only token by default and may not approve pull requests
#   4. Pull requests of every outside contributor wait for your approval before any workflow runs
#   5. Secret scanning and push protection (refuses a push that contains a key), Dependabot alerts and security
#      updates, and private vulnerability reporting (SECURITY.md)
#
# Google accepts GitHub's sign-in for the deploy account only for pushes to the deploy branch of this repository
# (deploy/setup.sh), so 1 is what stands between a stranger and your Google Cloud project.
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/config.sh

DRY_RUN=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Usage: deploy/github-settings.sh [--dry-run]" ;;
  esac
done

command -v gh >/dev/null || die "Install the GitHub CLI (https://cli.github.com) and sign in: gh auth login"
[ -n "$GITHUB_REPO" ] || die "No GitHub repository: run this in a clone whose origin is on GitHub, or set GITHUB_REPO=owner/name."
[ -n "$DRY_RUN" ] || gh auth status >/dev/null 2>&1 || die "Sign in to GitHub first: gh auth login"
CHECK="Type check, test and build"
R="repos/$GITHUB_REPO"

# One call to GitHub's API: printed, and made unless --dry-run. $1 the method, $2 the path, then gh api's own
# arguments (fields, or --input - with JSON on stdin)
call() {
  local method="$1" path="$2"
  shift 2
  echo "  gh api -X $method $path $*" >&2
  if [ -n "$DRY_RUN" ]; then
    # The JSON of --input - is read, not sent
    case " $* " in *" --input - "*) cat >/dev/null ;; esac
    return 0
  fi
  gh api -X "$method" "$path" -H "Accept: application/vnd.github+json" "$@" >/dev/null
}

cat <<TEXT
For $GITHUB_REPO:
  1. $DEPLOY_BRANCH: no force pushes, not deletable, "$CHECK" must pass first
  2. The production environment deploys only from protected branches
  3. Workflows: read-only token by default, may not approve pull requests
  4. Outside contributors' pull requests wait for your approval before workflows run
  5. Secret scanning with push protection, Dependabot alerts and security updates, private vulnerability reporting
TEXT
if [ -z "$DRY_RUN" ]; then
  read -r -p "Set these? [y/N] " answer
  case "$answer" in y | Y | yes | Yes) ;; *) die "Nothing was changed." ;; esac
fi

echo "1. Protecting $DEPLOY_BRANCH…"
call PUT "$R/branches/$DEPLOY_BRANCH/protection" --input - <<JSON
{
  "required_status_checks": { "strict": false, "checks": [{ "context": "$CHECK" }] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false,
  "block_creations": false,
  "required_conversation_resolution": false
}
JSON

echo "2. The production environment…"
call PUT "$R/environments/production" --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": true, "custom_branch_policies": false } }
JSON

echo "3. Workflow permissions…"
call PUT "$R/actions/permissions/workflow" -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

echo "4. Approval for outside contributors' pull requests…"
call PUT "$R/actions/permissions/fork-pr-contributor-approval" -f approval_policy=all_external_contributors

echo "5. Secret scanning, Dependabot and vulnerability reporting…"
call PATCH "$R" --input - <<'JSON'
{ "security_and_analysis": { "secret_scanning": { "status": "enabled" }, "secret_scanning_push_protection": { "status": "enabled" } } }
JSON
call PUT "$R/vulnerability-alerts"
call PUT "$R/automated-security-fixes"
call PUT "$R/private-vulnerability-reporting"

if [ -n "$DRY_RUN" ]; then
  echo "Dry run: nothing was changed."
else
  echo "Done. Secret scanning applies to public repositories (and to private ones with GitHub Advanced Security)."
fi
