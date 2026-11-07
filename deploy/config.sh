# shellcheck shell=bash disable=SC2034  # sourced: the scripts that source it use what it sets
# Settings shared by setup.sh, deploy.sh, guard.sh and protect.sh. Override any of them in the environment, e.g.
#   REGION=europe-west1 deploy/deploy.sh
# Paperwork runs in the Google Cloud project PROJECT_ID names (.env or the environment; deploy/setup.sh asks for it
# the first time). Its service, accounts, secrets and Firestore collections have names of their own, so it can share
# a project with other apps.

# A value from .env, without printing it
env_value() {
  [ -f .env ] || return 0
  { grep -E "^$1=" .env || true; } | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

# A value from deploy/github-deploy.env: where GitHub Actions deploys (setup.sh writes it, protect.sh adds to it)
gh_env_value() {
  [ -f deploy/github-deploy.env ] || return 0
  { grep -E "^$1=" deploy/github-deploy.env || true; } | tail -1 | cut -d= -f2-
}

PROJECT_ID="${PROJECT_ID:-$(env_value PROJECT_ID)}"
# A clone without .env: where GitHub Actions deploys (deploy/github-deploy.env, written by setup.sh)
PROJECT_ID="${PROJECT_ID:-$(gh_env_value GCP_PROJECT_ID)}"
FIRESTORE_DB="${FIRESTORE_DB:-$(env_value FIRESTORE_DB)}"
FIRESTORE_DB="${FIRESTORE_DB:-(default)}"
# Only used when the database doesn't exist yet; an existing database keeps its location
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-eur3}"
REGION="${REGION:-europe-west3}"
SERVICE="${SERVICE:-paperwork}"
# Paperwork as two services (protect.sh split): the app, behind Google's Identity-Aware Proxy, runs as APP_SERVICE;
# SERVICE becomes the public edge for AI apps, forwarded email and Cloud Scheduler and runs as EDGE_SA. Both empty
# while Paperwork is one service.
APP_SERVICE="${APP_SERVICE:-$(gh_env_value GCP_APP_SERVICE)}"
EDGE_SA="${EDGE_SA:-$(gh_env_value GCP_EDGE_SERVICE_ACCOUNT)}"
# Time zone for the server's "today"
APP_TIMEZONE="${APP_TIMEZONE:-Europe/Berlin}"
# How often Cloud Scheduler has the server file what landed in the Inbox. Each run takes a second or two
# when the Inbox is empty, and the server only pays for time spent answering, so this stays in the free tier.
CRON_SCHEDULE="${CRON_SCHEDULE:-*/5 * * * *}"

RUN_SA="paperwork-server@${PROJECT_ID}.iam.gserviceaccount.com"
CRON_SA="paperwork-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"
# GitHub Actions deploys as this account, signed in through Workload Identity Federation (no stored key)
DEPLOY_SA="paperwork-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
# What protect.sh split names the app's service and the edge's account
APP_SERVICE_DEFAULT="paperwork-app"
EDGE_SA_DEFAULT="paperwork-edge@${PROJECT_ID}.iam.gserviceaccount.com"
# Artifact Registry repository for the images GitHub Actions builds
REPOSITORY="${REPOSITORY:-paperwork}"
# The GitHub repository allowed to deploy, e.g. "owner/name", and its branch; from the git remote unless set: the
# last two parts of its address, so HTTPS (with or without a user name), SSH and SSH host aliases for a second
# GitHub account ("git@github-work:owner/name.git") all work (each with "|| true": under pipefail a missing
# remote or origin/HEAD, as in a shallow CI checkout, must not stop the scripts)
GITHUB_REPO="${GITHUB_REPO:-$({ git remote get-url origin 2>/dev/null || true; } | sed -E 's#\.git$##; s#^.*[:/]([^/:]+/[^/:]+)$#\1#')}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-$({ git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true; } | sed 's#^origin/##')}"
# Without origin/HEAD locally, the remote says which branch is its default
DEPLOY_BRANCH="${DEPLOY_BRANCH:-$({ git ls-remote --symref origin HEAD 2>/dev/null || true; } | sed -nE 's#^ref: refs/heads/([^[:space:]]+)[[:space:]]+HEAD$#\1#p')}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"

die() {
  echo "Error: $*" >&2
  exit 1
}

# A warning; in GitHub Actions also shown on the run's summary page
warn() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::warning::$*"; else echo "Warning: $*" >&2; fi
}

# Cloud Run's address is known before the first deploy: https://<service>-<project number>.<region>.run.app
service_url_for() {
  PROJECT_NUMBER="${PROJECT_NUMBER:-$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')}"
  echo "https://$1-$PROJECT_NUMBER.$REGION.run.app"
}

service_url() {
  service_url_for "$SERVICE"
}

# New service accounts take a few seconds before permissions can be granted to them
retry() {
  local attempt
  for attempt in 1 2 3 4 5 6; do
    "$@" && return 0
    [ "$attempt" = 6 ] && return 1
    echo "  (not ready yet, retrying in 10 s)"
    sleep 10
  done
}

# ---------- Running services ----------

# A Cloud Run service as it runs now (JSON), or nothing when it doesn't exist (or may not be read)
describe_service() {
  gcloud run services describe "$1" --region "$REGION" --project "$PROJECT_ID" --format=json 2>/dev/null || true
}

# Whether a service that describe_service found nothing of really doesn't exist: true only when gcloud says so
# ("Cannot find service"), false when it is there after all; any other failure (no network, no permission, signed
# out) stops the script, as it says nothing about the service
service_missing() {
  local out
  if out="$(gcloud run services describe "$1" --region "$REGION" --project "$PROJECT_ID" --format='value(metadata.name)' 2>&1)"; then
    return 1
  fi
  case "$out" in
    *"Cannot find service"*) return 0 ;;
  esac
  die "Couldn't read the Cloud Run service $1 (${out//$'\n'/ }); nothing was changed."
}

# What a running service's JSON says: `service_field "$JSON" env NAME`, `… annotation NAME`, `… account` or `… image`
service_field() {
  [ -n "$1" ] || return 0
  printf '%s' "$1" | node -e '
    let s = "";
    process.stdin.on("data", d => (s += d)).on("end", () => {
      try {
        const service = JSON.parse(s);
        const [kind, name] = process.argv.slice(1);
        const spec = service.spec.template.spec;
        const value =
          kind === "env" ? ((spec.containers[0].env || []).find(e => e.name === name) || {}).value :
          kind === "annotation" ? (service.metadata.annotations || {})[name] :
          kind === "account" ? spec.serviceAccountName :
          kind === "image" ? spec.containers[0].image : "";
        process.stdout.write(value || "");
      } catch {}
    });' "$2" "${3:-}"
}

# Paperwork as one service or as two (protect.sh split), from deploy/github-deploy.env (GCP_APP_SERVICE) or the
# environment (APP_SERVICE). Should that line ever be lost (a reverted file, setup.sh run with an old checkout), the
# running edge still says so (PAPERWORK_ROLE=edge): deploying it as one service would open the whole app to the
# internet again, so it stays two services, with a warning. PAPERWORK_SPLIT=off deploys one service anyway, the way
# back (DEPLOY.md, "Back to one service").
# $1: the running SERVICE's JSON. Sets SPLIT (1 or empty), APP_SERVICE and EDGE_SA.
split_mode() {
  SPLIT=""
  case "${PAPERWORK_SPLIT:-}" in
    off)
      APP_SERVICE=""
      return 0
      ;;
    "") ;;
    *) die "PAPERWORK_SPLIT is either off (one service) or unset." ;;
  esac
  if [ -z "$APP_SERVICE" ] && [ "$(service_field "$1" env PAPERWORK_ROLE)" = edge ]; then
    APP_SERVICE="$APP_SERVICE_DEFAULT"
    EDGE_SA="${EDGE_SA:-$(service_field "$1" account)}"
    warn "deploy/github-deploy.env doesn't name the app's service, but $SERVICE runs as Paperwork's public edge, so this stays two services ($APP_SERVICE and $SERVICE). Commit the lines deploy/protect.sh split added to deploy/github-deploy.env, or go back to one service with PAPERWORK_SPLIT=off deploy/deploy.sh (DEPLOY.md)."
  fi
  [ -n "$APP_SERVICE" ] || return 0
  [ "$APP_SERVICE" != "$SERVICE" ] || die "The app's service ($APP_SERVICE) must be another than the edge's ($SERVICE)."
  SPLIT=1
  EDGE_SA="${EDGE_SA:-$EDGE_SA_DEFAULT}"
}

# ---------- Firestore ----------

# The IAM condition that limits an account's Firestore access to one database of the project, as YAML for
# --condition-from-file: Paperwork's accounts may use Paperwork's database, never another app's there
# (setup.sh, protect.sh isolate). $2 is its title, by which the binding is found again; Paperwork's is
# paperwork-<database>-db-only, e.g. paperwork-default-db-only.
db_condition() {
  printf 'expression: resource.name == "projects/%s/databases/%s"\ntitle: %s\n' "$PROJECT_ID" "$1" "${2:-$(db_condition_title "$1")}"
}

db_condition_title() {
  printf 'paperwork-%s-db-only' "$(printf '%s' "$1" | tr -cd 'a-z0-9-')"
}

# ---------- Asked once, on this machine (setup.sh) ----------

# A setting setup.sh needs and .env doesn't have: asked for on the terminal and, unless it is secret, kept in .env so
# deploy.sh and the next run of setup.sh find it. $1 the name, $2 the question, $3 a default, $4 "secret" to read it
# without showing it and keep it out of .env (it goes to Secret Manager only). Prints the value.
ask_setting() {
  local name="$1" question="$2" default="${3:-}" secret="${4:-}" value=""
  [ -t 0 ] || die "$name is missing: add it to .env (see .env.example), or run deploy/setup.sh in a terminal to be asked."
  while [ -z "$value" ]; do
    if [ -n "$secret" ]; then
      read -r -s -p "$question: " value
      echo >&2
    else
      read -r -p "$question${default:+ [$default]}: " value
      value="${value:-$default}"
    fi
  done
  if [ -z "$secret" ]; then
    [ ! -s .env ] || [ -z "$(tail -c1 .env)" ] || echo >>.env
    printf '%s="%s"\n' "$name" "$value" >>.env
  fi
  printf '%s' "$value"
}

# The browser key for Google's file picker, made by setup.sh. Not secret: it only works for the Picker API, and
# only from Paperwork's pages.
PICKER_KEY_NAME="Paperwork picker"
picker_key_name() {
  { gcloud services api-keys list --project "$PROJECT_ID" --filter="displayName=\"$PICKER_KEY_NAME\"" --format='value(name)' 2>/dev/null || true; } | head -1
}

picker_key() {
  local name
  name="$(picker_key_name)"
  if [ -n "$name" ]; then
    gcloud services api-keys get-key-string "$name" --format='value(keyString)' 2>/dev/null || true
  fi
}

check_access() {
  command -v gcloud >/dev/null || die "Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install"
  [ -n "$PROJECT_ID" ] || die "Set PROJECT_ID (in .env or the environment) to the Google Cloud project to deploy into."
  local account
  account="$(gcloud config get-value account 2>/dev/null)"
  gcloud projects describe "$PROJECT_ID" --format='value(projectId)' >/dev/null 2>&1 ||
    die "$account cannot open project $PROJECT_ID. Sign in with the account that owns it: gcloud auth login"
  echo "Project $PROJECT_ID as $account"
}
