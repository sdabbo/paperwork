#!/usr/bin/env bash
# One-time hardening of Paperwork on Google Cloud, run by the project's owner with gcloud (DEPLOY.md, "Protecting
# Paperwork"). Nothing changes without a yes: each step says what it will do, asks, and is skipped when a check shows
# it is done already, so the script can simply be run again after a stop.
#
#   deploy/protect.sh [plan]      what is set up and what the next steps would change (changes nothing)
#   deploy/protect.sh status      the same
#   deploy/protect.sh isolate     Paperwork's accounts may use Paperwork's Firestore database only; Paperwork is
#                                 checked, and gets its access back should it fail (database: the same)
#   deploy/protect.sh split       two services: the app behind Google's Identity-Aware Proxy (IAP), the public edge
#                                 for AI apps, forwarded email and Cloud Scheduler
#   deploy/protect.sh finance     after split, optional: a finance app may read the contracts and receipts
#                                 through two GET paths of the app, behind IAP, as its own service account, and
#                                 nothing else; tested with a call signed as that account (DEPLOY.md)
#
#   --dry-run       print every command that would change something, in order, and run none of them
# shellcheck disable=SC2016  # JavaScript for node in single quotes
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/config.sh
P=(--project "$PROJECT_ID")

USAGE="Usage: deploy/protect.sh [plan|status|isolate|split|finance] [--dry-run]"
ACTION=plan
DRY_RUN=""
for arg in "$@"; do
  case "$arg" in
    plan | status | isolate | split | finance) ACTION="$arg" ;;
    database) ACTION=isolate ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "$USAGE" ;;
  esac
done

JOB=paperwork-inbox
APP_NAME="${APP_SERVICE:-$APP_SERVICE_DEFAULT}"
EDGE_ACCOUNT="${EDGE_SA:-$EDGE_SA_DEFAULT}"
SECRETS=(paperwork-gemini-api-key paperwork-google-client-secret paperwork-app-secret paperwork-inbound-email-secret)
FIRESTORE_API="https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases"
# Finance, an optional companion finance app in the same project: its service account, which may read Paperwork's
# read-only feed (finance), and the one Firestore database that account may use (granted with this condition)
FINANCE_ACCOUNT="$(printf '%s' "${FINANCE_READER_ACCOUNT:-finance-server@$PROJECT_ID.iam.gserviceaccount.com}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
FINANCE_DB="${FINANCE_FIRESTORE_DB:-finance}"
# IAP lets Finance's account through on the feed's paths only (Paperwork's own check allows exactly two of them)
FEED_CONDITION='expression=request.path.startsWith("/internal/finance/"),title=finance-feed-only'
# Google applies a change of IAM usually within 2 minutes, at times 7 or more: for 15 minutes, every 30 s, an app is
# asked whether it still reads its database after losing its access to every other
WATCH_TRIES=30

STEP=""
TEMP_GRANT=""
# The account TEMP_GRANT may sign JWTs as: the edge's (split, S8) unless set (finance, F4)
TEMP_GRANT_ON=""
# What finance changed in this run, so a failed test takes back only that: F2 the grant on IAP (condition or none),
# F3 the setting in the app
F2_ADDED=""
F3_DONE=""
# Accounts whose access to every database was taken away, while it isn't checked yet that their app still works
UNVERIFIED=""
TMP="$(mktemp -d)"
chmod 700 "$TMP"

# ---------- Saying, asking, running ----------

say() {
  echo "  $*"
}

step() {
  STEP="$1"
  echo
  echo "== $1. $2"
}

skip() {
  say "Done already: $*"
}

# A command as it could be typed (on stderr, so it shows even where its output is discarded)
show() {
  local out="  \$" arg
  for arg in "$@"; do
    case "$arg" in
      "" | *[!A-Za-z0-9_./:=@,+%-]*)
        case "$arg" in *"'"*) out="$out \"$arg\"" ;; *) out="$out '$arg'" ;; esac
        ;;
      *) out="$out $arg" ;;
    esac
  done
  printf '%s\n' "$out" >&2
}

# A change made without a command line (a file written, an API called)
show_change() {
  printf '  $ (%s)\n' "$*" >&2
}

# Every command that changes something goes through here: shown, then run (with --dry-run: only shown)
run() {
  show "$@"
  if [ -n "$DRY_RUN" ]; then return 0; fi
  "$@"
}

# Before each step that changes something; no stops the script there
confirm() {
  if [ -n "$DRY_RUN" ]; then
    say "(would ask: $1)"
    return 0
  fi
  local answer
  read -r -p "  $1 [y/N] " answer
  case "$answer" in y | Y | yes | Yes) return 0 ;; esac
  say "Stopped here, as you asked. Run deploy/protect.sh $ACTION again to go on from here."
  STEP=""
  exit 0
}

# Something optional, "no" unless answered yes (with --dry-run: no); with yes as $2, "yes" unless answered no (with
# --dry-run: yes)
offer() {
  local default="${2:-no}" answer
  if [ -n "$DRY_RUN" ]; then
    say "(would offer, default $default: $1)"
    [ "$default" = yes ]
    return
  fi
  if [ "$default" = yes ]; then
    read -r -p "  $1 [Y/n] " answer
    case "$answer" in n | N | no | No) return 1 ;; *) return 0 ;; esac
  fi
  read -r -p "  $1 [y/N] " answer
  case "$answer" in y | Y | yes | Yes) return 0 ;; *) return 1 ;; esac
}

# A value, proposing $2 (with --dry-run: the proposal)
ask() {
  if [ -n "$DRY_RUN" ]; then
    printf '%s' "$2"
    return 0
  fi
  local answer
  read -r -p "  $1 [$2]: " answer
  printf '%s' "${answer:-$2}"
}

# Something the owner does in a browser or the console
wait_for_owner() {
  if [ -n "$DRY_RUN" ]; then
    say "(would wait for you: $1)"
    return 0
  fi
  read -r -p "  $1 Press Enter when done. " _
}

pause() {
  if [ -n "$DRY_RUN" ]; then
    say "(would wait $1 s: $2)"
    return 0
  fi
  say "Waiting $1 s: $2…"
  sleep "$1"
}

on_exit() {
  local code=$?
  if [ -n "$TEMP_GRANT" ] && [ -z "$DRY_RUN" ]; then
    gcloud iam service-accounts remove-iam-policy-binding "${TEMP_GRANT_ON:-$EDGE_ACCOUNT}" --member="$TEMP_GRANT" \
      --role=roles/iam.serviceAccountTokenCreator "${P[@]}" >/dev/null 2>&1 ||
      echo "Remove the temporary grant yourself: gcloud iam service-accounts remove-iam-policy-binding ${TEMP_GRANT_ON:-$EDGE_ACCOUNT} --member=$TEMP_GRANT --role=roles/iam.serviceAccountTokenCreator --project $PROJECT_ID" >&2
  fi
  # Stopped before that check finished: the access is given back (isolate takes it away again, and checks)
  if [ -n "$UNVERIFIED" ] && [ -z "$DRY_RUN" ]; then
    echo "Stopped before it was checked that the app still reads its database; giving the access back:" >&2
    give_back
  fi
  rm -rf "$TMP"
  if [ "$code" != 0 ] && [ -n "$STEP" ]; then
    echo >&2
    echo "Stopped at step $STEP. Run deploy/protect.sh $ACTION again to continue; steps already done are skipped." >&2
  fi
}
trap on_exit EXIT

# ---------- Reading (never changes anything) ----------

# A JavaScript expression of the JSON on stdin (x), printed; arrays one item per line; nothing on errors
json() {
  node -e '
    let s = "";
    process.stdin.on("data", d => (s += d)).on("end", () => {
      try {
        const v = new Function("x", `return (${process.argv[1]})`)(JSON.parse(s));
        if (v !== undefined && v !== null) process.stdout.write(Array.isArray(v) ? v.join("\n") : String(v));
      } catch {}
    });' "$1"
}

# Whether an IAM policy (JSON) has ROLE for MEMBER: with the condition titled CONDITION, without one ("none"), or
# either way ("any", the default)
has_binding() {
  printf '%s' "$1" | node -e '
    let s = "";
    process.stdin.on("data", d => (s += d)).on("end", () => {
      const [role, member, condition] = process.argv.slice(1);
      let policy = {};
      try { policy = JSON.parse(s || "{}"); } catch {}
      const found = (policy.bindings || []).some(b => b.role === role && (b.members || []).includes(member) &&
        (condition === "any" || (condition === "none" ? !b.condition : (b.condition || {}).title === condition)));
      process.exit(found ? 0 : 1);
    });' "$2" "$3" "${4:-any}"
}

# Who may call a policy's resource without signing in
open_members() {
  printf '%s' "$1" | json 'x.bindings.flatMap(b => b.members.filter(m => m === "allUsers" || m === "allAuthenticatedUsers"))'
}

# Google's REST APIs, read with gcloud's access token (kept in a file, so it shows in no command line)
AUTH_HEADER="$TMP/auth"
(umask 077 && printf 'Authorization: Bearer %s\n' "$(gcloud auth print-access-token 2>/dev/null || true)" >"$AUTH_HEADER")
google() {
  curl -sf -X "$1" "$2" -H @"$AUTH_HEADER" -H "X-Goog-User-Project: $PROJECT_ID" -H 'Content-Type: application/json' \
    ${3:+--data "$3"} 2>/dev/null || true
}

# A database's top-level collections, one per line
collections() {
  google POST "$FIRESTORE_API/$1/documents:listCollectionIds" '{"pageSize":300}' | json 'x.collectionIds || []'
}

# The account Paperwork's Drive connection belongs to (only that field is read)
owner_email() {
  google GET "$FIRESTORE_API/$1/documents/paperwork/connection?mask.fieldPaths=ownerEmail" | json 'x.fields.ownerEmail.stringValue'
}

db_exists() {
  gcloud firestore databases describe --database="$1" "${P[@]}" >/dev/null 2>&1
}

project_policy() {
  gcloud projects get-iam-policy "$PROJECT_ID" --format=json
}

# Whether an account (in a project policy) may use Firestore only as the condition titled $3 allows, and no longer
# every database of the project
only_conditioned() {
  has_binding "$1" roles/datastore.user "serviceAccount:$2" "$3" && ! has_binding "$1" roles/datastore.user "serviceAccount:$2" none
}

job_state() {
  gcloud scheduler jobs describe "$JOB" --location "$REGION" "${P[@]}" --format='value(state)' 2>/dev/null || true
}

account_exists() {
  gcloud iam service-accounts describe "$1" "${P[@]}" >/dev/null 2>&1
}

app_policy() {
  gcloud run services get-iam-policy "$APP_NAME" --region "$REGION" "${P[@]}" --format=json 2>/dev/null || true
}

iap_policy() {
  gcloud iap web get-iam-policy --resource-type=cloud-run --service="$APP_NAME" --region="$REGION" "${P[@]}" --format=json 2>/dev/null || true
}

refresh_services() {
  EDGE_JSON="$(describe_service "$SERVICE")"
  APP_JSON="$(describe_service "$APP_NAME")"
}

# The roles a resource's IAM policy (JSON, $1) gives MEMBER ($2), one per line
roles_of() {
  printf '%s' "$1" | node -e '
    let s = "";
    process.stdin.on("data", d => (s += d)).on("end", () => {
      let policy = {};
      try { policy = JSON.parse(s || "{}"); } catch {}
      for (const b of (policy && policy.bindings) || []) if ((b.members || []).includes(process.argv[1])) console.log(b.role);
    });' "$2"
}

# Everything through which Finance's account could get at Paperwork other than the feed, one finding per line;
# nothing when there is none. Reads only. $1: the project's IAM policy.
finance_reach() {
  local member="serviceAccount:$FINANCE_ACCOUNT" name policy role
  # The project: Firestore only for Finance's own database, exactly as Finance's setup.sh grants it. Firestore without
  # that condition (or with another) reaches Paperwork's database; owner, editor and viewer read every database; the
  # others reach Paperwork's secrets, act as its accounts, or change its services, schedule, image or who may call
  # them. A custom role could hold any of that.
  # A policy that couldn't be read (plan reads it quietly) is a finding, not a pass
  printf '%s' "$1" | node -e '
    let s = "";
    process.stdin.on("data", d => (s += d)).on("end", () => {
      const [member, own] = process.argv.slice(1);
      const reaching = /^roles\/(owner|editor|viewer|datastore\.|firebase|secretmanager\.|iam\.|run\.|iap\.|resourcemanager\.|cloudscheduler\.|artifactregistry\.|cloudbuild\.|logging\.(viewer|privateLogViewer|admin))/;
      let policy = null;
      try { policy = JSON.parse(s); } catch {}
      if (!policy || typeof policy !== "object") return console.log("couldn\x27t read the project\x27s IAM policy (gcloud projects get-iam-policy)");
      for (const b of policy.bindings || []) {
        if (!(b.members || []).includes(member)) continue;
        if (b.role === "roles/datastore.user" && b.condition && b.condition.expression === own) continue;
        const condition = b.condition ? ` with the condition ${b.condition.title || b.condition.expression}` : " without a condition";
        if (!b.role.startsWith("roles/")) console.log(`the project gives it the custom role ${b.role}${condition}`);
        else if (reaching.test(b.role)) console.log(`the project gives it ${b.role}${condition}`);
      }
    });' "$member" "resource.name == \"projects/$PROJECT_ID/databases/$FINANCE_DB\""
  # Paperwork's secrets: paperwork-app-secret signs its sessions
  for name in "${SECRETS[@]}"; do
    if ! policy="$(gcloud secrets get-iam-policy "$name" "${P[@]}" --format=json 2>/dev/null)"; then
      echo "couldn't read who may read the secret $name (gcloud secrets get-iam-policy $name)"
      continue
    fi
    for role in $(roles_of "$policy" "$member"); do echo "the secret $name gives it $role"; done
  done
  # Paperwork's accounts: signing as the edge (or the scheduler) reaches /internal/cron, as the deploy account the
  # services themselves
  for name in "$RUN_SA" "$EDGE_ACCOUNT" "$CRON_SA" "$DEPLOY_SA"; do
    account_exists "$name" || continue
    if ! policy="$(gcloud iam service-accounts get-iam-policy "$name" "${P[@]}" --format=json 2>/dev/null)"; then
      echo "couldn't read who may act as $name (gcloud iam service-accounts get-iam-policy $name)"
      continue
    fi
    for role in $(roles_of "$policy" "$member"); do echo "Paperwork's account $name gives it $role"; done
  done
  # The two services: calling either past IAP, or changing them
  for name in "$APP_NAME" "$SERVICE"; do
    if ! policy="$(gcloud run services get-iam-policy "$name" --region "$REGION" "${P[@]}" --format=json 2>/dev/null)"; then
      echo "couldn't read who may call $name (gcloud run services get-iam-policy $name)"
      continue
    fi
    for role in $(roles_of "$policy" "$member"); do echo "the Cloud Run service $name gives it $role"; done
  done
}

# The database a service uses ("" when it doesn't exist; a service from before FIRESTORE_DB was set uses (default))
db_of() {
  [ -n "$1" ] || return 0
  local db
  db="$(service_field "$1" env FIRESTORE_DB)"
  printf '%s' "${db:-(default)}"
}

app_deployed() {
  [ "$(service_field "$APP_JSON" env PAPERWORK_ROLE)" = app ] && [ "$(service_field "$APP_JSON" annotation run.googleapis.com/iap-enabled)" = true ]
}

edge_deployed() {
  [ "$(service_field "$EDGE_JSON" env PAPERWORK_ROLE)" = edge ] && [ "$(service_field "$EDGE_JSON" account)" = "$EDGE_ACCOUNT" ]
}

# deploy/github-deploy.env: a line protect.sh writes there (GitHub Actions deploys by it once it is committed)
set_deploy_env() {
  local file=deploy/github-deploy.env
  [ "$(gh_env_value "$1")" != "$2" ] || return 0
  show_change "write $1=$2 into $file"
  [ -z "$DRY_RUN" ] || return 0
  { grep -vE "^$1=" "$file" 2>/dev/null || true; echo "$1=$2"; } >"$TMP/deploy.env"
  cat "$TMP/deploy.env" >"$file"
}

# The address a stranger sees answering; nothing when there is no answer
status_of() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$@" 2>/dev/null || true
}

# ---------- Before anything changes ----------

[ -n "$DRY_RUN" ] && echo "Dry run: commands that would change something are only shown (\$ …); nothing is changed."
check_access
PROJECT_NUMBER="${PROJECT_NUMBER:-$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')}"
IAP_AGENT="service-$PROJECT_NUMBER@gcp-sa-iap.iam.gserviceaccount.com"
APP_ADDRESS="$(service_url_for "$APP_NAME")"
EDGE_ADDRESS="$(service_url)"
refresh_services

# split runs from a clean checkout of the deploy branch: it deploys this checkout, and the lines it writes into
# deploy/github-deploy.env are to be committed
if [ "$ACTION" = split ]; then
  dirty="$(git status --porcelain -- . ':!deploy/github-deploy.env' 2>/dev/null || true)"
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [ -n "$dirty" ] || [ "$branch" != "$DEPLOY_BRANCH" ]; then
    problem="Run this from a clean checkout of $DEPLOY_BRANCH (now: ${branch:-no git checkout}${dirty:+, with uncommitted changes})."
    if [ -n "$DRY_RUN" ]; then say "Note: $problem"; else die "$problem"; fi
  fi
  # What split deploys is what GitHub deploys: this checkout is origin's, and paperwork runs it already (its filing
  # takes turns with the app's through the store; older code doesn't), unless split got that far before
  if [ -n "$DRY_RUN" ]; then
    say "(would check that this checkout is origin/$DEPLOY_BRANCH, and that $SERVICE runs it)"
  else
    git fetch -q origin "$DEPLOY_BRANCH" 2>/dev/null || die "Couldn't fetch origin/$DEPLOY_BRANCH to compare this checkout with it."
    head="$(git rev-parse HEAD)"
    [ "$head" = "$(git rev-parse "origin/$DEPLOY_BRANCH" 2>/dev/null || true)" ] ||
      die "This checkout isn't origin/$DEPLOY_BRANCH (git status says whether to pull or to push first): split deploys what GitHub deploys."
    if ! edge_deployed; then
      image="$(service_field "$EDGE_JSON" image)"
      case "$image" in
        *":$head") ;;
        *)
          say "$SERVICE doesn't run this commit ($head) but ${image:-no image}: GitHub hasn't deployed it yet, or its run failed."
          confirm "Go on anyway (no: wait for GitHub's run, then run this again)?"
          ;;
      esac
    fi
  fi
  say "Don't push to $DEPLOY_BRANCH until step S11's change is committed: a deploy from GitHub that starts before step"
  say "S9 would turn $SERVICE back into the whole app."
fi

# ---------- plan / status ----------

report() {
  local ancestors org policy dbs name location free described role title
  echo
  echo "== Project $PROJECT_ID ($PROJECT_NUMBER)"
  ancestors="$(gcloud projects get-ancestors "$PROJECT_ID" --format=json 2>/dev/null || true)"
  org="$(printf '%s' "$ancestors" | json 'x.filter(a => a.type === "organization").map(a => a.id)[0]')"
  if [ -n "$org" ]; then
    say "In the organization $org ($(gcloud organizations describe "$org" --format='value(displayName)' 2>/dev/null || true))."
  else
    say "In no organization: IAP needs an OAuth client made in the console (split says how)."
  fi

  echo
  echo "== Firestore databases"
  dbs="$(gcloud firestore databases list "${P[@]}" --format=json 2>/dev/null || true)"
  for name in $(printf '%s' "$dbs" | json 'x.map(d => d.name.split("/").pop())'); do
    location="$(printf '%s' "$dbs" | json "x.find(d => d.name.endsWith('/$name')).locationId")"
    free="$(printf '%s' "$dbs" | json "x.find(d => d.name.endsWith('/$name')).freeTier")"
    say "$name: $location${free:+, free tier: $free}; collections: $(collections "$name" | tr '\n' ' ')"
  done

  echo
  echo "== Paperwork's services"
  for name in "$SERVICE" "$APP_NAME"; do
    described="$(describe_service "$name")"
    if [ -z "$described" ]; then
      say "$name: not there"
      continue
    fi
    role="$(service_field "$described" env PAPERWORK_ROLE)"
    say "$name: ${role:-one service}, runs as $(service_field "$described" account), database $(db_of "$described"), IAP $([ "$(service_field "$described" annotation run.googleapis.com/iap-enabled)" = true ] && echo on || echo off)"
    policy="$(gcloud run services get-iam-policy "$name" --region "$REGION" "${P[@]}" --format=json 2>/dev/null || true)"
    say "  may call it: $(printf '%s' "$policy" | json 'x.bindings.filter(b => b.role === "roles/run.invoker").flatMap(b => b.members).join(", ")')"
  done
  say "Inbox schedule ($JOB): $(job_state)"

  echo
  echo "== Who can read Firestore (project-wide roles; without a condition, every database; printed only)"
  policy="$(project_policy 2>/dev/null || true)"
  printf '%s' "$policy" | json 'x.bindings.filter(b => /^roles\/(owner|editor|viewer|datastore\.|firebase\.)/.test(b.role)).map(b => `  ${b.role}${b.condition ? ` (if ${b.condition.title})` : ""}: ${b.members.join(", ")}`)'

  echo
  echo "== Steps"
  title="$(db_condition_title "$FIRESTORE_DB")"
  check_line "$(only_conditioned "$policy" "$RUN_SA" "$title" && echo y)" "isolate: $RUN_SA may use only Paperwork's database, $FIRESTORE_DB"
  if account_exists "$EDGE_ACCOUNT"; then
    check_line "$(only_conditioned "$policy" "$EDGE_ACCOUNT" "$title" && echo y)" "isolate: $EDGE_ACCOUNT may use only $FIRESTORE_DB"
  fi
  check_line "$(app_deployed && echo y)" "split: the app, $APP_NAME, behind IAP"
  check_line "$(edge_deployed && echo y)" "split: $SERVICE is the public edge, running as $EDGE_ACCOUNT"
  check_line "$([ -n "$(gh_env_value GCP_APP_SERVICE)" ] && echo y)" "split: deploy/github-deploy.env names both services"
  if account_exists "$FINANCE_ACCOUNT"; then
    check_line "$([ -z "$(finance_reach "$policy")" ] && echo y)" "finance: $FINANCE_ACCOUNT reaches nothing of Paperwork's but the feed"
  else
    check_line "" "finance (optional): a finance app's account, $FINANCE_ACCOUNT (FINANCE_READER_ACCOUNT names another)"
  fi
  check_line "$(has_binding "$(iap_policy)" roles/iap.httpsResourceAccessor "serviceAccount:$FINANCE_ACCOUNT" && echo y)" "finance: IAP lets it through to the feed"
  check_line "$([ "$(service_field "$APP_JSON" env FINANCE_READER_ACCOUNT)" = "$FINANCE_ACCOUNT" ] && echo y)" "finance: $APP_NAME serves the feed to it"
}

check_line() {
  if [ -n "$1" ]; then say "[x] $2"; else say "[ ] $2"; fi
}

if [ "$ACTION" = plan ] || [ "$ACTION" = status ]; then
  report
  if [ "$ACTION" = plan ]; then
    echo
    echo "Next: deploy/protect.sh isolate, then deploy/protect.sh split (each asks before every change;"
    echo "add --dry-run to see the commands first). DEPLOY.md, \"Protecting Paperwork\", explains both."
    echo "Optional, for a finance app: deploy/protect.sh finance, once split is done (DEPLOY.md, \"Finance's read-only feed\")."
  fi
  exit 0
fi

# ---------- isolate ----------

# Paperwork's answer, at its public address (the one service, or the edge), to a request that has it read its store:
# an app it doesn't know asking for a token. It looks the app up, writes nothing and logs one line. 401: it read the
# store; 500: Firestore refused; anything else (no answer yet) tells neither. The edge's account has the same
# condition as the app's, so what the edge reads, the app (behind IAP, out of reach here) reads too.
store_answer() {
  status_of -X POST --data 'grant_type=refresh_token&client_id=pwc_isolationcheck00000000' "$EDGE_ADDRESS/oauth/token"
}

# Before anything is taken away: Paperwork reads its store now (allowing for a cold start)
store_reads_now() {
  local code=""
  for _ in 1 2 3; do
    code="$(store_answer)"
    [ "$code" != 401 ] || return 0
    [ "$code" != 500 ] || break
    sleep 10
  done
  die "Paperwork doesn't read its store even now ($EDGE_ADDRESS/oauth/token answered ${code:-nothing}, not 401). Nothing was taken away; Cloud Run's logs of $SERVICE say why."
}

# Whether Paperwork still reads its store while Google applies the change: asked every 30 s, WATCH_TRIES times. A
# refusal that clears up was the access to its own database arriving late, so the last clear answer decides; three
# refusals in a row end the wait.
store_keeps_working() {
  local try=1 code last="" refused=0 what
  while :; do
    code="$(store_answer)"
    case "$code" in
      401) last=ok refused=0 what="reads its store" ;;
      500) last=refused refused=$((refused + 1)) what="Firestore refused" ;;
      *) what="no clear answer" ;;
    esac
    say "$(date +%H:%M:%S) Paperwork: $what (${code:-no answer})"
    [ "$refused" -lt 3 ] && [ "$try" -lt "$WATCH_TRIES" ] || break
    try=$((try + 1))
    sleep 30
  done
  [ "$last" = ok ]
}

# A running Paperwork service ($1, its JSON $2; nothing when it isn't there) must use the database the condition names
uses_db() {
  [ -z "$2" ] || [ "$(db_of "$2")" = "$FIRESTORE_DB" ] ||
    die "$1 uses the Firestore database $(db_of "$2"), but FIRESTORE_DB here is $FIRESTORE_DB (.env or the environment). Nothing was changed."
}

# Takes the role Firestore user without a condition (every database of the project) from the accounts in $1. Until
# their app is checked they are in UNVERIFIED, and get it back should the script stop first.
take_away() {
  local sa
  for sa in $1; do
    UNVERIFIED="$UNVERIFIED $sa"
    run gcloud projects remove-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$sa" --role=roles/datastore.user --condition=None >/dev/null
  done
}

# Gives the accounts in UNVERIFIED the role without a condition back: the way back when their app fails
give_back() {
  local sa
  for sa in $UNVERIFIED; do
    run gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$sa" --role=roles/datastore.user --condition=None >/dev/null ||
      echo "  Couldn't. Run it yourself: gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$sa --role=roles/datastore.user --condition=None" >&2
  done
  UNVERIFIED=""
}

isolate() {
  local title accounts sa policy added="" taking=""

  step I1 "Paperwork's database, and who may use it"
  [ -n "$EDGE_JSON" ] || die "$SERVICE isn't deployed yet; deploy Paperwork first (deploy/deploy.sh)."
  uses_db "$SERVICE" "$EDGE_JSON"
  uses_db "$APP_NAME" "$APP_JSON"
  title="$(db_condition_title "$FIRESTORE_DB")"
  accounts="$RUN_SA"
  if account_exists "$EDGE_ACCOUNT"; then accounts="$accounts $EDGE_ACCOUNT"; fi
  db_condition "$FIRESTORE_DB" >"$TMP/condition.yaml"
  say "Paperwork uses the database $FIRESTORE_DB. Its accounts (${accounts// /, }) get the role Firestore"
  say "user only where $(sed -n 's/^expression: //p' "$TMP/condition.yaml") (titled $title),"
  say "and then lose the role without a condition, which reaches every database of the project."

  step I2 "Paperwork's accounts may use $FIRESTORE_DB"
  policy="$(project_policy)"
  for sa in $accounts; do
    if has_binding "$policy" roles/datastore.user "serviceAccount:$sa" "$title"; then
      skip "$sa may use $FIRESTORE_DB."
    else
      confirm "Let $sa use the database $FIRESTORE_DB (Firestore user, only for that database)?"
      retry run gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$sa" --role=roles/datastore.user \
        --condition-from-file="$TMP/condition.yaml" >/dev/null
      added=1
    fi
  done

  step I3 "Paperwork's accounts lose every other database, and Paperwork is checked"
  policy="$(project_policy)"
  for sa in $accounts; do
    has_binding "$policy" roles/datastore.user "serviceAccount:$sa" none || continue
    # Only once it may use its own database
    has_binding "$policy" roles/datastore.user "serviceAccount:$sa" "$title" || [ -n "$DRY_RUN" ] ||
      die "$sa may not use $FIRESTORE_DB on its own yet (step I2); nothing was taken away."
    taking="$taking $sa"
  done
  if [ -z "$taking" ]; then
    skip "Paperwork's accounts may use $FIRESTORE_DB only."
  else
    if [ -n "$DRY_RUN" ]; then
      say "(would check that Paperwork reads its store now: $EDGE_ADDRESS/oauth/token answers 401)"
    else
      store_reads_now
      say "Paperwork reads its store now."
    fi
    [ -z "$added" ] || pause 120 "Google applies the access to $FIRESTORE_DB first"
    taking="${taking# }"
    confirm "Take away the access to every Firestore database of the project (they keep $FIRESTORE_DB) from ${taking// /, }? For 15 minutes then, Paperwork is asked whether it still reads its store, and gets the access back should it not."
    take_away "$taking"
    if [ -n "$DRY_RUN" ]; then
      say "(would ask Paperwork every 30 s for 15 minutes whether it still reads its store, and give the access back if not)"
      UNVERIFIED=""
    elif store_keeps_working; then
      UNVERIFIED=""
      say "Paperwork reads its store with access to $FIRESTORE_DB alone."
    else
      say "Paperwork can't read its store with access to $FIRESTORE_DB alone: the condition doesn't match. Giving the"
      say "access to every database back:"
      give_back
      STEP=""
      die "Paperwork works again once Google applies that (a few minutes). Nothing else was changed; DEPLOY.md (\"Isolating Paperwork's data\") says what to look at."
    fi
  fi

  step I4 "What's left for you"
  say "1. Other apps' accounts in this project that are Firestore users without a condition still reach every database,"
  say "   Paperwork's too; deploy/protect.sh plan lists them. Limit each to its own database with the same kind of condition."
  say "2. People with project-wide roles (owner, editor, viewer) still reach every database; deploy/protect.sh plan lists them."
  STEP=""
}

# ---------- split ----------

split() {
  local ancestors org domain account proposal allowed custom="" policy secret title client_id="" client_file
  local referrers key name audience code tried jwt_ok since answer logs

  # IAP on a Cloud Run service is gcloud's --iap (generally available since March 2026)
  gcloud run deploy --help 2>/dev/null | grep -q -- '--\[no-\]iap' ||
    die "This gcloud doesn't know gcloud run deploy --iap yet. Update it (gcloud components update) and run this again."

  # The edge gets Paperwork's database only, as isolate leaves Paperwork's own account: only once isolate has shown
  # that this works (an edge whose access doesn't match can't read its store, and Gemini and email fail)
  if ! only_conditioned "$(project_policy)" "$RUN_SA" "$(db_condition_title "$FIRESTORE_DB")"; then
    if [ -n "$DRY_RUN" ]; then say "Note: deploy/protect.sh isolate comes first."; else
      die "Run deploy/protect.sh isolate first: it checks that access limited to the database $FIRESTORE_DB works, which the edge relies on."
    fi
  fi

  step S1 "Your account, and Google's sign-in page for IAP"
  ancestors="$(gcloud projects get-ancestors "$PROJECT_ID" --format=json 2>/dev/null || true)"
  org="$(printf '%s' "$ancestors" | json 'x.filter(a => a.type === "organization").map(a => a.id)[0]')"
  domain=""
  [ -z "$org" ] || domain="$(gcloud organizations describe "$org" --format='value(displayName)' 2>/dev/null || true)"
  allowed="$(service_field "$EDGE_JSON" env ALLOWED_EMAILS)"
  [ -n "$allowed" ] || allowed="$(service_field "$APP_JSON" env ALLOWED_EMAILS)"
  # Proposed: the account Drive is connected through; IAP must let exactly the account you sign in with through
  proposal="$(owner_email "$FIRESTORE_DB")"
  [ -n "$proposal" ] || proposal="${allowed%%,*}"
  account="$(ask "Which Google account opens Paperwork (IAP lets only this one through)?" "${proposal:-you@example.com}" | tr '[:upper:]' '[:lower:]')"
  case ",$(printf '%s' "$allowed" | tr '[:upper:]' '[:lower:]' | tr -d ' ')," in
    *",$account,"*) say "$account may sign in to Paperwork (ALLOWED_EMAILS)." ;;
    *)
      if [ -n "$DRY_RUN" ]; then say "Note: $account is not in ALLOWED_EMAILS ($allowed)."; else
        die "$account isn't in Paperwork's ALLOWED_EMAILS ($allowed); the app lets only accounts in both through. Deploy with it added first."
      fi
      ;;
  esac
  if [ -n "$org" ] && [ "${account#*@}" = "$domain" ]; then
    say "The project is in your organization ($domain): IAP's own sign-in client works, nothing to set up."
  else
    custom=1
    if [ -n "$org" ]; then say "The project is in $domain, but $account is outside it,"; else say "The project is in no organization,"; fi
    say "so IAP needs a sign-in client of its own, made in the console (Google stopped the API for it in March 2026)."
    client_id="$(gcloud iap settings get --resource-type=cloud-run --service="$APP_NAME" --region="$REGION" "${P[@]}" --format=json 2>/dev/null |
      json 'x.accessSettings.oauthSettings.clientId' || true)"
  fi
  if [ -n "$custom" ] && [ -n "$client_id" ]; then
    skip "IAP uses the sign-in client $client_id."
  elif [ -n "$custom" ]; then
    say "  1. https://console.cloud.google.com/auth/clients?project=$PROJECT_ID › Create client › Web application,"
    say "     named \"Paperwork IAP\", Create."
    say "  2. In the dialog that follows, Download JSON at once: Google shows the client's secret only there. Keep the"
    say "     file until step S4 has read it, then delete it."
    say "  3. Then open the client, add this Authorized redirect URI (with its client ID) and Save:"
    say "       https://iap.googleapis.com/v1/oauth/clientIds/<CLIENT_ID>:handleRedirect"
    say "  4. If Google Auth Platform › Audience says Testing, add $account as a test user."
    wait_for_owner "Make the client now."
  fi

  step S2 "Turn on IAP for the project"
  if [ -n "$(gcloud services list --enabled --filter=config.name=iap.googleapis.com --format='value(config.name)' "${P[@]}" 2>/dev/null || true)" ]; then
    skip "IAP's API is on."
  else
    confirm "Turn on the Identity-Aware Proxy API?"
    run gcloud services enable iap.googleapis.com "${P[@]}"
    # IAP's service agent, which calls the app for IAP; gcloud's beta component makes it at once (otherwise Google
    # does within a few minutes, which step S4 waits for)
    if CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud beta services identity create --help >/dev/null 2>&1; then
      run gcloud beta services identity create --service=iap.googleapis.com "${P[@]}" >/dev/null || true
    else
      say "(IAP's service agent comes within a few minutes; S4 waits for it.)"
    fi
  fi

  step S3 "The edge's own account, $EDGE_ACCOUNT"
  if account_exists "$EDGE_ACCOUNT"; then
    skip "the account exists."
  else
    confirm "Create the service account ${EDGE_ACCOUNT%%@*} for the public edge?"
    run gcloud iam service-accounts create "${EDGE_ACCOUNT%%@*}" --display-name "Paperwork public edge" "${P[@]}"
  fi
  # It signs the scheduled run's JWT itself (cron relay), reads the secrets, uses Paperwork's database (only that one,
  # as isolate leaves Paperwork's other account); GitHub's deploy account may deploy revisions running as it
  policy="$(gcloud iam service-accounts get-iam-policy "$EDGE_ACCOUNT" "${P[@]}" --format=json 2>/dev/null || true)"
  if has_binding "$policy" roles/iam.serviceAccountTokenCreator "serviceAccount:$EDGE_ACCOUNT"; then
    skip "it may sign its own JWTs."
  else
    retry run gcloud iam service-accounts add-iam-policy-binding "$EDGE_ACCOUNT" --member="serviceAccount:$EDGE_ACCOUNT" \
      --role=roles/iam.serviceAccountTokenCreator "${P[@]}" >/dev/null
  fi
  if has_binding "$policy" roles/iam.serviceAccountUser "serviceAccount:$DEPLOY_SA"; then
    skip "GitHub's deploy account may deploy revisions running as it."
  elif account_exists "$DEPLOY_SA" || [ -n "$DRY_RUN" ]; then
    retry run gcloud iam service-accounts add-iam-policy-binding "$EDGE_ACCOUNT" --member="serviceAccount:$DEPLOY_SA" \
      --role=roles/iam.serviceAccountUser "${P[@]}" >/dev/null
  fi
  for secret in "${SECRETS[@]}"; do
    policy="$(gcloud secrets get-iam-policy "$secret" "${P[@]}" --format=json 2>/dev/null || true)"
    if has_binding "$policy" roles/secretmanager.secretAccessor "serviceAccount:$EDGE_ACCOUNT"; then
      skip "it may read $secret."
    else
      retry run gcloud secrets add-iam-policy-binding "$secret" --member="serviceAccount:$EDGE_ACCOUNT" \
        --role=roles/secretmanager.secretAccessor "${P[@]}" >/dev/null
    fi
  done
  db_condition "$FIRESTORE_DB" >"$TMP/condition.yaml"
  title="$(db_condition_title "$FIRESTORE_DB")"
  if has_binding "$(project_policy)" roles/datastore.user "serviceAccount:$EDGE_ACCOUNT" "$title"; then
    skip "it may use the database $FIRESTORE_DB."
  else
    retry run gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$EDGE_ACCOUNT" --role=roles/datastore.user \
      --condition-from-file="$TMP/condition.yaml" >/dev/null
  fi

  step S4 "The app, $APP_NAME, behind IAP"
  if app_deployed; then
    skip "$APP_NAME runs as the app with IAP on."
  else
    confirm "Build this checkout and deploy it as $APP_NAME, with IAP on and nobody else allowed to call it (a few minutes)?"
    run env DEPLOY_ONLY=app APP_SERVICE="$APP_NAME" EDGE_SA="$EDGE_ACCOUNT" deploy/deploy.sh
    refresh_services
    app_deployed || [ -n "$DRY_RUN" ] || die "$APP_NAME doesn't show IAP on after the deploy (gcloud run services describe $APP_NAME); nothing else was switched."
  fi
  # gcloud lets IAP's service agent call the app, but only warns when it can't (yet)
  policy="$(app_policy)"
  if has_binding "$policy" roles/run.invoker "serviceAccount:$IAP_AGENT"; then
    skip "IAP's service agent may call the app."
  else
    tried=0
    until run gcloud run services add-iam-policy-binding "$APP_NAME" --region "$REGION" "${P[@]}" \
      --member="serviceAccount:$IAP_AGENT" --role=roles/run.invoker >/dev/null; do
      tried=$((tried + 1))
      [ "$tried" -lt 10 ] || die "IAP's service agent ($IAP_AGENT) still can't be granted. Try again in a few minutes."
      say "(IAP's service agent isn't there yet; trying again in 30 s)"
      sleep 30
    done
  fi
  for name in $(open_members "$(app_policy)"); do
    confirm "$APP_NAME may be called by $name. Remove that?"
    run gcloud run services remove-iam-policy-binding "$APP_NAME" --region "$REGION" "${P[@]}" --member="$name" --role=roles/run.invoker >/dev/null
  done
  if [ -n "$custom" ]; then
    client_id="$(gcloud iap settings get --resource-type=cloud-run --service="$APP_NAME" --region="$REGION" "${P[@]}" --format=json 2>/dev/null |
      json 'x.accessSettings.oauthSettings.clientId' || true)"
    if [ -n "$client_id" ]; then
      skip "IAP uses the sign-in client $client_id."
    elif [ -n "$DRY_RUN" ]; then
      run gcloud iap settings set "$TMP/iap-settings.yaml" "${P[@]}" --resource-type=cloud-run --region="$REGION" --service="$APP_NAME"
    else
      client_file="$(ask "Path of the client's downloaded JSON (step S1)" "$HOME/Downloads/client_secret.json")"
      [ -f "$client_file" ] || die "There is no file $client_file."
      client_id="$(json 'x.web ? x.web.client_id : x.client_id' <"$client_file")"
      secret="$(json 'x.web ? x.web.client_secret : x.client_secret' <"$client_file")"
      [ -n "$client_id" ] || die "$client_file holds no client ID."
      if [ -z "$secret" ]; then
        say "$client_file holds no secret: Google shows it only when the client is made. Make a new one: Google Auth"
        say "Platform › Clients › Paperwork IAP › Add secret."
        read -r -s -p "  Paste it (not shown): " secret
        echo
        [ -n "$secret" ] || die "No secret given; IAP's sign-in client wasn't changed."
      fi
      (umask 077 && printf 'accessSettings:\n  oauthSettings:\n    clientId: %s\n    clientSecret: %s\n' "$client_id" "$secret" >"$TMP/iap-settings.yaml")
      secret=""
      say "Check that the client lists https://iap.googleapis.com/v1/oauth/clientIds/$client_id:handleRedirect as a redirect URI."
      run gcloud iap settings set "$TMP/iap-settings.yaml" "${P[@]}" --resource-type=cloud-run --region="$REGION" --service="$APP_NAME" >/dev/null
      rm -f "$TMP/iap-settings.yaml"
      say "IAP uses it now; you may delete $client_file."
    fi
  fi

  step S5 "Who IAP lets through: $account, and the edge for the scheduled run"
  policy="$(iap_policy)"
  for name in "user:$account" "serviceAccount:$EDGE_ACCOUNT"; do
    if has_binding "$policy" roles/iap.httpsResourceAccessor "$name"; then
      skip "IAP lets $name through."
    else
      confirm "Let $name through IAP to $APP_NAME?"
      run gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service="$APP_NAME" --region="$REGION" "${P[@]}" \
        --member="$name" --role=roles/iap.httpsResourceAccessor --condition=None >/dev/null
    fi
  done

  step S6 "Google sign-in and the file picker on the app's address"
  if edge_deployed; then
    skip "Paperwork runs as two services."
  else
    say "Add this Authorized redirect URI to Paperwork's Google sign-in client, then Save:"
    say "  $APP_ADDRESS/auth/callback"
    say "  https://console.cloud.google.com/apis/credentials/oauthclient/$(service_field "$EDGE_JSON" env GOOGLE_CLIENT_ID)?project=$PROJECT_ID"
    wait_for_owner "Add it now."
  fi
  key="$(picker_key_name)"
  if [ -z "$key" ]; then
    say "No picker key (setup.sh makes one); nothing to change."
  else
    referrers="$(gcloud services api-keys describe "$key" --format=json 2>/dev/null | json 'x.restrictions.browserKeyRestrictions.allowedReferrers' || true)"
    if printf '%s\n' "$referrers" | grep -qxF "$APP_ADDRESS/*"; then
      skip "the picker key works on the app's pages."
    else
      # Both flags in one call: the referrers alone could drop the key's limit to the Picker API
      referrers="$( { printf '%s\n' "$referrers"; printf '%s\n' "$APP_ADDRESS/*" "$EDGE_ADDRESS/*" "http://localhost:3000/*"; } | grep -v '^$' | awk '!seen[$0]++' | paste -sd, -)"
      run gcloud services api-keys update "$key" --api-target=service=picker.googleapis.com --allowed-referrers="$referrers" "${P[@]}" >/dev/null
    fi
  fi

  if edge_deployed; then
    step S7 "Open the app"
    skip "Paperwork runs as two services (steps S7 and S8)."
  else
    step S7 "Open the app"
    say "Open $APP_ADDRESS in your browser: Google asks you to sign in as $account, then Paperwork's own sign-in"
    say "follows as usual. The library should load, with Drive connected."
    while true; do
      if [ -n "$DRY_RUN" ]; then
        say "(would wait for you to open the app)"
        break
      fi
      read -r -p "  Did the library load? [y/N] " answer
      case "$answer" in y | Y | yes | Yes) break ;; esac
      # Paperwork logs why it refused IAP's signed header, and which audience it got
      logs="$(gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$APP_NAME\" AND jsonPayload.message=\"IAP check failed\"" \
        --freshness=15m --limit 5 --format=json "${P[@]}" 2>/dev/null || true)"
      printf '%s' "$logs" | json 'x.map(e => `    ${e.timestamp} ${e.jsonPayload.reason}${e.jsonPayload.aud ? ` (aud ${e.jsonPayload.aud})` : ""}`)'
      echo
      audience="$(printf '%s' "$logs" | json 'x.map(e => e.jsonPayload.aud).filter(Boolean)[0]')"
      if [[ "$audience" =~ ^/projects/[0-9]+/locations/[a-z0-9-]+/services/$APP_NAME$ ]] &&
        [ "$audience" != "$(service_field "$APP_JSON" env IAP_AUDIENCE)" ]; then
        confirm "IAP's signed header is for $audience. Set IAP_AUDIENCE to that?"
        run gcloud run services update "$APP_NAME" --region "$REGION" "${P[@]}" --update-env-vars "IAP_AUDIENCE=$audience" >/dev/null
        refresh_services
      else
        say "Nothing in the app's logs says what to change. Try a private window; DEPLOY.md (\"Protecting Paperwork\") lists"
        say "what else to look at. Nothing is switched for AI apps, email or the schedule yet."
        confirm "Try again?"
      fi
    done

    step S8 "Test the scheduled run's way into the app"
    say "Signs a JWT as $EDGE_ACCOUNT and asks the app to file its Inbox through IAP, as the edge will every 5 minutes."
    if [ -n "$DRY_RUN" ]; then
      show gcloud iam service-accounts sign-jwt "$TMP/claims.json" "$TMP/run.jwt" --iam-account="$EDGE_ACCOUNT" "${P[@]}"
      show curl -X POST -H @"$TMP/run-header" --data '{}' "$APP_ADDRESS/internal/cron"
      say "(if refused: the same with aud $APP_ADDRESS/*)"
    else
      confirm "Run that test now (it files what waits in the Inbox)?"
      jwt_ok=""
      sign_tries=0
      for audience in "$APP_ADDRESS/internal/cron" "$APP_ADDRESS/*"; do
        node -e 'const now = Math.floor(Date.now() / 1000); const [sa, aud] = process.argv.slice(1);
          process.stdout.write(JSON.stringify({ iss: sa, sub: sa, aud, iat: now, exp: now + 300 }))' "$EDGE_ACCOUNT" "$audience" >"$TMP/claims.json"
        until gcloud iam service-accounts sign-jwt "$TMP/claims.json" "$TMP/run.jwt" --iam-account="$EDGE_ACCOUNT" "${P[@]}" >/dev/null 2>"$TMP/sign.err"; do
          # Google applies the grant usually within 2 minutes, at times 7 or more: up to 8 minutes, every 30 s
          if [ -n "$TEMP_GRANT" ]; then
            sign_tries=$((sign_tries + 1))
            [ "$sign_tries" -lt 16 ] || die "Couldn't sign a JWT as $EDGE_ACCOUNT: $(cat "$TMP/sign.err")"
            pause 30 "Google hasn't applied the grant yet"
            continue
          fi
          cat "$TMP/sign.err" >&2
          confirm "Your account may not sign JWTs as $EDGE_ACCOUNT. Allow that for this test only (removed right after)?"
          TEMP_GRANT="user:$(gcloud config get-value account 2>/dev/null)"
          retry run gcloud iam service-accounts add-iam-policy-binding "$EDGE_ACCOUNT" --member="$TEMP_GRANT" \
            --role=roles/iam.serviceAccountTokenCreator "${P[@]}" >/dev/null
          pause 60 "Google applies IAM changes"
        done
        (umask 077 && printf 'Authorization: Bearer %s\n' "$(cat "$TMP/run.jwt")" >"$TMP/run-header")
        rm -f "$TMP/run.jwt"
        code="$(curl -sS -o "$TMP/run.out" -D "$TMP/run.headers" -w '%{http_code}' --max-time 600 -X POST \
          -H @"$TMP/run-header" -H 'Content-Type: application/json' --data '{}' "$APP_ADDRESS/internal/cron" 2>/dev/null || true)"
        rm -f "$TMP/run-header"
        say "aud $audience: $code, $(head -c 300 "$TMP/run.out" | tr '\r\n' '  ')"
        if [ "$code" = 200 ] && json 'typeof x === "object"' <"$TMP/run.out" | grep -q true; then
          jwt_ok="$audience"
          break
        fi
        say "  (from IAP: $(grep -i '^x-goog-iap-generated-response:' "$TMP/run.headers" | cut -d: -f2- | tr -d '\r ' || true))"
      done
      if [ -n "$TEMP_GRANT" ]; then
        run gcloud iam service-accounts remove-iam-policy-binding "$EDGE_ACCOUNT" --member="$TEMP_GRANT" \
          --role=roles/iam.serviceAccountTokenCreator "${P[@]}" >/dev/null
        TEMP_GRANT=""
      fi
      if [ -z "$jwt_ok" ]; then
        say "IAP didn't let the scheduled run through. Nothing is switched: Paperwork still runs as one service at"
        say "$EDGE_ADDRESS, and $APP_NAME stays behind IAP. The app's logs (\"IAP check failed\", \"IAP relay accepted\")"
        say "and DEPLOY.md (\"Protecting Paperwork\") say more."
        exit 1
      fi
      if [ "$jwt_ok" != "$APP_ADDRESS/internal/cron" ]; then
        CRON_RELAY_AUDIENCE="$jwt_ok"
        say "The edge will sign for $jwt_ok (CRON_RELAY_AUDIENCE; later deploys keep it)."
      fi
    fi
  fi

  step S9 "$SERVICE becomes the public edge"
  if edge_deployed; then
    skip "$SERVICE runs as the edge."
  else
    say "From now on $SERVICE answers only AI apps, forwarded email and Cloud Scheduler; the app is at $APP_ADDRESS."
    confirm "Deploy $SERVICE as the public edge?"
    run env DEPLOY_ONLY=edge APP_SERVICE="$APP_NAME" EDGE_SA="$EDGE_ACCOUNT" ${CRON_RELAY_AUDIENCE:+CRON_RELAY_AUDIENCE="$CRON_RELAY_AUDIENCE"} deploy/deploy.sh
    refresh_services
  fi
  say "Checking the doors (deploy/guard.sh):"
  if ! run env APP_SERVICE="$APP_NAME" EDGE_SA="$EDGE_ACCOUNT" deploy/guard.sh; then
    if offer "The check failed. Go back to one service now (PAPERWORK_SPLIT=off deploy/deploy.sh)?"; then
      run env PAPERWORK_SPLIT=off deploy/deploy.sh
    fi
    die "Stopped after the check failed."
  fi

  step S10 "The scheduled run through the edge"
  if [ "$(gh_env_value GCP_APP_SERVICE)" = "$APP_NAME" ] && [ "$(gh_env_value GCP_EDGE_SERVICE_ACCOUNT)" = "$EDGE_ACCOUNT" ]; then
    skip "Paperwork runs as two services, and deploy/github-deploy.env says so (S10 and S11)."
    step S12 "What's left for you"
    say "Nothing; README.md, \"Security\", has the steps for your Google account."
    STEP=""
    return 0
  fi
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  run gcloud scheduler jobs run "$JOB" --location "$REGION" "${P[@]}"
  pause 90 "the scheduled run"
  if [ -z "$DRY_RUN" ]; then
    gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=(\"$SERVICE\" OR \"$APP_NAME\") AND (jsonPayload.message=\"Cron relay\" OR jsonPayload.message=\"IAP relay accepted\") AND timestamp>=\"$since\"" \
      --limit 10 --format=json "${P[@]}" 2>/dev/null |
      json 'x.map(e => `    ${e.resource.labels.service_name}: ${e.jsonPayload.message} ${e.jsonPayload.phase || e.jsonPayload.email || ""} ${e.jsonPayload.status ?? ""}`)' || true
    echo
    say "A \"Cron relay … call 200\" line means the chain works. If not, nothing is lost: email and scans wait in the"
    say "Inbox, and the app files them whenever you open it. DEPLOY.md (\"Protecting Paperwork\") says where to look."
  fi

  step S11 "Tell GitHub's deploys"
  set_deploy_env GCP_APP_SERVICE "$APP_NAME"
  set_deploy_env GCP_EDGE_SERVICE_ACCOUNT "$EDGE_ACCOUNT"
  say "Commit it, so every push deploys both services:"
  say "  git add deploy/github-deploy.env && git commit -m \"Paperwork as two services\" && git push"

  step S12 "What's left for you"
  say "1. Passkeys on your Google account, and the other steps in README.md, \"Security\"."
  say "2. On the phone: open $APP_ADDRESS in Safari, sign in, Add to Home Screen; delete the old icon."
  say "3. GitHub: Settings › Code security: Dependabot alerts and security updates on; Settings › Branches: protect"
  say "   $DEPLOY_BRANCH (no force pushes, the check must pass)."
  say "4. Gemini stays connected (same address). Email forwarding keeps working (same address)."
  say "5. Optional, once you won't go back to one service: the old address can come off the sign-in client and the"
  say "   picker key (DEPLOY.md, \"Back to one service\")."
  say "Back to one service if ever needed: PAPERWORK_SPLIT=off deploy/deploy.sh (DEPLOY.md)."
  STEP=""
}

# ---------- finance ----------

# Adds or removes ($1: add|remove) Finance's grant on IAP, with the feed's condition or none ($2: condition|none).
# Shown like every change; gcloud's message, should it refuse, is left in $TMP/iap.err.
iap_grant() {
  local condition="$FEED_CONDITION"
  [ "$2" = condition ] || condition=None
  set -- gcloud iap web "$1-iam-policy-binding" --resource-type=cloud-run --service="$APP_NAME" --region="$REGION" "${P[@]}" \
    --member="serviceAccount:$FINANCE_ACCOUNT" --role=roles/iap.httpsResourceAccessor --condition="$condition"
  show "$@"
  [ -z "$DRY_RUN" ] || return 0
  "$@" >/dev/null 2>"$TMP/iap.err"
}

# A JWT signed as ACCOUNT ($1) for AUDIENCE ($2), written to OUTFILE ($3), as Finance has IAM Credentials sign its own
# on Cloud Run: {iss, sub, aud, iat, exp: iat + 300}. When your account may not sign as it, the same offer as S8: a
# grant for this test only, removed right after (and by on_exit, should the script stop first).
sign_jwt_as() {
  local account="$1" audience="$2" out="$3" tries=0
  node -e 'const now = Math.floor(Date.now() / 1000); const [sa, aud] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ iss: sa, sub: sa, aud, iat: now, exp: now + 300 }))' "$account" "$audience" >"$TMP/claims.json"
  until gcloud iam service-accounts sign-jwt "$TMP/claims.json" "$out" --iam-account="$account" "${P[@]}" >/dev/null 2>"$TMP/sign.err"; do
    # Google applies the grant usually within 2 minutes, at times 7 or more: up to 8 minutes, every 30 s
    if [ -n "$TEMP_GRANT" ]; then
      tries=$((tries + 1))
      [ "$tries" -lt 16 ] || die "Couldn't sign a JWT as $account: $(cat "$TMP/sign.err")"
      pause 30 "Google hasn't applied the grant yet"
      continue
    fi
    cat "$TMP/sign.err" >&2
    TEMP_GRANT_ON="$account"
    confirm "Your account may not sign JWTs as $account. Allow that for this test only (removed right after)?"
    TEMP_GRANT="user:$(gcloud config get-value account 2>/dev/null)"
    retry run gcloud iam service-accounts add-iam-policy-binding "$account" --member="$TEMP_GRANT" \
      --role=roles/iam.serviceAccountTokenCreator "${P[@]}" >/dev/null
    pause 60 "Google applies IAM changes"
  done
}

# One request of F4, with the JWT from $TMP/feed-header (never on a command line). Sets CODE (000: no answer) and BY:
# IAP when IAP generated the answer, else Paperwork.
feed_call() {
  local method="$1" url="$2"
  set -- -sS -o "$TMP/feed.out" -D "$TMP/feed.headers" -w '%{http_code}' --max-time 60 -X "$method" -H @"$TMP/feed-header"
  [ "$method" != POST ] || set -- "$@" --data ''
  : >"$TMP/feed.out"
  : >"$TMP/feed.headers"
  CODE="$(curl "$@" "$url" 2>/dev/null || true)"
  CODE="${CODE:-000}"
  BY=Paperwork
  if grep -qi '^x-goog-iap-generated-response:' "$TMP/feed.headers"; then BY=IAP; fi
}

# The answer is a refusal: IAP's (a redirect to its sign-in, 401 or 403, marked as IAP's) or Paperwork's (403)
refused() {
  case "$BY $CODE" in "IAP 3"?? | "IAP 401" | "IAP 403" | "Paperwork 403") return 0 ;; esac
  return 1
}

# How an answer is shown: its status and who gave it
answer_of() {
  if [ "$CODE" = 000 ]; then echo "no answer"; else echo "$CODE from $BY"; fi
}

# Takes back what this run changed (F4 failed): the grant on IAP, then the setting in the app
finance_undo() {
  if [ -z "$F2_ADDED$F3_DONE" ]; then
    say "Steps F2 and F3 were done before this run; they stay as they are."
    return 0
  fi
  if [ -n "$F2_ADDED" ]; then
    say "Taking back F2: IAP no longer lets $FINANCE_ACCOUNT through."
    if ! iap_grant remove "$F2_ADDED"; then
      sed 's/^/    /' "$TMP/iap.err" >&2
      say "Couldn't. Remove it yourself (DEPLOY.md, \"Finance's read-only feed\", Switching it off)."
    fi
  fi
  if [ -n "$F3_DONE" ]; then
    say "Taking back F3: $APP_NAME no longer serves the feed."
    run gcloud run services update "$APP_NAME" --region "$REGION" "${P[@]}" --remove-env-vars FINANCE_READER_ACCOUNT >/dev/null ||
      say "Couldn't. Run it yourself: gcloud run services update $APP_NAME --region $REGION --project $PROJECT_ID --remove-env-vars FINANCE_READER_ACCOUNT"
  fi
}

finance() {
  local head image policy findings since audience aud_ok="" first_refusal="" purchases="" session="" cron=""
  local count condition_note iap_only waits=0

  # The feed is served by the app behind IAP, which split makes
  if ! app_deployed || ! edge_deployed; then
    die "Run deploy/protect.sh split first: Finance reads the feed from the app behind IAP."
  fi
  # F3 switches the feed on in the image the app runs now, so that image must have it: GitHub tags its images by
  # commit, and this checkout is the commit that brought the feed (or a later one)
  head="$(git rev-parse HEAD 2>/dev/null || true)"
  image="$(service_field "$APP_JSON" image)"
  case "$image" in
    *":${head:-no commit}") say "$APP_NAME runs this checkout's commit ($head)." ;;
    *)
      say "$APP_NAME runs ${image:-an image without a name}, not this checkout's commit (${head:-this is no git checkout})."
      say "An image from before the feed would switch on nothing, and step F4 would fail."
      confirm "Go on anyway (no: once GitHub has deployed this commit, run this again)?"
      ;;
  esac

  step F1 "Finance's account, and what it may reach"
  account_exists "$FINANCE_ACCOUNT" ||
    die "There is no service account $FINANCE_ACCOUNT in $PROJECT_ID. Run Finance's deploy/setup.sh first (or set FINANCE_READER_ACCOUNT to Finance's account)."
  policy="$(project_policy)"
  findings="$(finance_reach "$policy")"
  if [ -n "$findings" ]; then
    say "$FINANCE_ACCOUNT can get at Paperwork other than through the feed:"
    printf '%s\n' "$findings" | sed 's/^/    - /'
    say "Remove each binding (gcloud … remove-iam-policy-binding … --member=serviceAccount:$FINANCE_ACCOUNT --role=<role>),"
    say "then run this again. Finance needs only roles/datastore.user with the condition its deploy/setup.sh grants."
    die "Nothing was changed."
  fi
  say "$FINANCE_ACCOUNT may use Firestore only for Finance's database ($FINANCE_DB), and nothing of Paperwork's: not"
  say "its database, secrets, service accounts or services."

  step F2 "Let Finance through IAP to the feed"
  if has_binding "$(iap_policy)" roles/iap.httpsResourceAccessor "serviceAccount:$FINANCE_ACCOUNT"; then
    skip "IAP lets $FINANCE_ACCOUNT through to $APP_NAME."
  else
    say "IAP lets $FINANCE_ACCOUNT through to $APP_NAME on paths that start with /internal/finance/; the app itself"
    say "allows it exactly GET /internal/finance/contracts and GET /internal/finance/purchases, and nothing else."
    confirm "Let $FINANCE_ACCOUNT through IAP to the feed?"
    if iap_grant add condition; then
      F2_ADDED=condition
    else
      sed 's/^/    /' "$TMP/iap.err" >&2
      say "IAP didn't take the condition on the path (gcloud's message above)."
      if offer "Let $FINANCE_ACCOUNT through IAP without it? Paperwork's own check still allows it only GET on the two paths of the feed."; then
        if ! iap_grant add none; then
          sed 's/^/    /' "$TMP/iap.err" >&2
          die "IAP didn't take that either; nothing was changed."
        fi
        F2_ADDED=none
      else
        say "Stopped here, as you asked; nothing was changed. Run deploy/protect.sh finance again to go on from here."
        STEP=""
        exit 0
      fi
    fi
  fi

  step F3 "Switch the feed on in the app"
  if [ "$(service_field "$APP_JSON" env FINANCE_READER_ACCOUNT)" = "$FINANCE_ACCOUNT" ]; then
    skip "$APP_NAME serves the feed to $FINANCE_ACCOUNT."
  else
    [ -n "$image" ] || die "Couldn't read the image $APP_NAME runs (gcloud run services describe $APP_NAME)."
    say "Deploys the image $APP_NAME runs now again, with FINANCE_READER_ACCOUNT=$FINANCE_ACCOUNT: nothing is rebuilt,"
    say "and later deploys (GitHub's too) keep the setting."
    confirm "Switch the feed on in $APP_NAME?"
    run env DEPLOY_ONLY=app APP_SERVICE="$APP_NAME" EDGE_SA="$EDGE_ACCOUNT" IMAGE="$image" FINANCE_READER_ACCOUNT="$FINANCE_ACCOUNT" deploy/deploy.sh
    F3_DONE=1
    refresh_services
    [ -n "$DRY_RUN" ] || [ "$(service_field "$APP_JSON" env FINANCE_READER_ACCOUNT)" = "$FINANCE_ACCOUNT" ] ||
      die "$APP_NAME doesn't show FINANCE_READER_ACCOUNT=$FINANCE_ACCOUNT after the deploy (gcloud run services describe $APP_NAME)."
  fi

  step F4 "Test Finance's way into the feed"
  say "Signs a JWT as $FINANCE_ACCOUNT, as Finance does on Cloud Run, and asks the app for the feed through IAP; then,"
  say "with a JWT for the whole app, its other doors must refuse it with a 403. Only statuses and the number of contracts"
  say "are shown, never what the feed holds."
  since="$(node -e 'process.stdout.write(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10))')"
  if [ -n "$DRY_RUN" ]; then
    show gcloud iam service-accounts sign-jwt "$TMP/claims.json" "$TMP/feed.jwt" --iam-account="$FINANCE_ACCOUNT" "${P[@]}"
    show curl -sS -H @"$TMP/feed-header" "$APP_ADDRESS/internal/finance/contracts"
    show curl -sS -H @"$TMP/feed-header" "$APP_ADDRESS/internal/finance/purchases?since=$since"
    say "(with aud $APP_ADDRESS/internal/finance/*, and if IAP refuses that, $APP_ADDRESS/*; then with aud $APP_ADDRESS/*:)"
    show gcloud iam service-accounts sign-jwt "$TMP/claims.json" "$TMP/feed.jwt" --iam-account="$FINANCE_ACCOUNT" "${P[@]}"
    show curl -sS -H @"$TMP/feed-header" "$APP_ADDRESS/api/session"
    show curl -sS -X POST -H @"$TMP/feed-header" --data '' "$APP_ADDRESS/internal/cron"
    STEP=""
    return 0
  fi
  confirm "Run that test now (it reads the feed and changes nothing)?"
  # Google applies a change of IAM usually within 2 minutes, at times 7 or more, and F3's deploy takes about one: while
  # IAP refuses the feed for both audiences and its grant is from this run (F2), that is the likeliest reason, so the
  # test is run again every 30 s for up to 8 minutes before anything is taken back
  while true; do
    first_refusal=""
    iap_only=1
    for audience in "$APP_ADDRESS/internal/finance/*" "$APP_ADDRESS/*"; do
      sign_jwt_as "$FINANCE_ACCOUNT" "$audience" "$TMP/feed.jwt"
      # The JWT goes into a header file only this user may read, and from there to curl: never on a command line
      (umask 077 && printf 'Authorization: Bearer %s\n' "$(cat "$TMP/feed.jwt")" >"$TMP/feed-header")
      rm -f "$TMP/feed.jwt"
      say "aud $audience:"
      feed_call GET "$APP_ADDRESS/internal/finance/contracts"
      count=""
      if [ "$CODE" = 200 ] && [ "$(json 'x.version === 1 && Array.isArray(x.contracts)' <"$TMP/feed.out")" = true ]; then
        count="$(json 'x.contracts.length' <"$TMP/feed.out")"
        say "  GET /internal/finance/contracts: 200, $count contracts"
      else
        say "  GET /internal/finance/contracts: $(answer_of)"
      fi
      [ -n "$first_refusal" ] || [ -n "$count" ] || first_refusal="$(answer_of)"
      if [ -n "$count" ] || [ "$BY" != IAP ] || ! refused; then iap_only=""; fi
      feed_call GET "$APP_ADDRESS/internal/finance/purchases?since=$since"
      if [ "$CODE" = 200 ] && [ "$(json 'x.version === 1 && Array.isArray(x.receipts)' <"$TMP/feed.out")" = true ]; then
        purchases="200, the query string passed"
      else
        purchases="$(answer_of)"
      fi
      say "  GET /internal/finance/purchases?since=$since: $purchases"
      rm -f "$TMP/feed-header" "$TMP/feed.out" "$TMP/feed.headers"
      if [ -n "$count" ]; then
        aud_ok="$audience"
        break
      fi
    done
    [ -z "$aud_ok" ] || break
    [ -n "$F2_ADDED" ] && [ -n "$iap_only" ] && [ "$waits" -lt 16 ] || break
    waits=$((waits + 1))
    pause 30 "IAP refused both audiences while its grant (F2) is new: Google may not have applied it yet"
  done
  # The app's other doors, asked with a JWT for the whole app whichever audience got the feed: Finance's account may
  # sign one for any audience, and IAP turns a JWT away from a path outside its audience before its grant or Paperwork
  # is asked, so the feed's own JWT proves nothing there. Only a 403 counts as refused: IAP's (the grant's condition on
  # the path holds) or Paperwork's (its own check); a 401 or a redirect means IAP didn't take the JWT, which tests
  # neither.
  if [ -n "$aud_ok" ]; then
    sign_jwt_as "$FINANCE_ACCOUNT" "$APP_ADDRESS/*" "$TMP/feed.jwt"
    (umask 077 && printf 'Authorization: Bearer %s\n' "$(cat "$TMP/feed.jwt")" >"$TMP/feed-header")
    rm -f "$TMP/feed.jwt"
    say "aud $APP_ADDRESS/*, the app's other doors:"
    feed_call GET "$APP_ADDRESS/api/session"
    if [ "$CODE" = 403 ]; then session="$BY"; fi
    say "  GET /api/session: $(answer_of)$([ -n "$session" ] && echo ", refused as it should be")"
    : >"$TMP/feed.out"
    feed_call POST "$APP_ADDRESS/internal/cron"
    if [ "$CODE" = 403 ]; then cron="$BY"; fi
    say "  POST /internal/cron: $(answer_of)$([ -n "$cron" ] && echo ", refused as it should be")"
    rm -f "$TMP/feed-header" "$TMP/feed.out" "$TMP/feed.headers"
  fi
  if [ -n "$TEMP_GRANT" ]; then
    run gcloud iam service-accounts remove-iam-policy-binding "$TEMP_GRANT_ON" --member="$TEMP_GRANT" \
      --role=roles/iam.serviceAccountTokenCreator "${P[@]}" >/dev/null
    TEMP_GRANT=""
  fi

  if [ -z "$aud_ok" ] || [ -z "$session" ] || [ -z "$cron" ]; then
    if [ -z "$aud_ok" ]; then
      say "Finance's JWT didn't get through to the feed with either audience."
    else
      say "Finance's JWT for the whole app wasn't refused with a 403 at the app's other doors:"
      say "it got through to more than the feed, or IAP didn't take it, which tests neither IAP's condition on the path"
      say "nor Paperwork's own check."
    fi
    finance_undo
    say "The app's log lines \"IAP check failed\" and \"IAP finance accepted\", and DEPLOY.md (\"Finance's read-only"
    say "feed\"), say more."
    STEP=""
    exit 1
  fi

  case "$F2_ADDED" in
    condition) condition_note="IAP took the grant with the condition request.path.startsWith(\"/internal/finance/\")" ;;
    none) condition_note="IAP refused the condition on the path; the grant has none, and Paperwork's own check limits the paths" ;;
    *) condition_note="the grant on IAP was there before this run ($(iap_policy | json "x.bindings.filter(b => b.role === 'roles/iap.httpsResourceAccessor' && b.members.includes('serviceAccount:$FINANCE_ACCOUNT')).map(b => b.condition ? 'with the condition ' + (b.condition.title || b.condition.expression) : 'without a condition').join(', ')"))" ;;
  esac
  echo
  say "Finance gets through to the feed, and only to the feed:"
  say "  C1: IAP takes Finance's JWT for aud $aud_ok$([ "$aud_ok" != "$APP_ADDRESS/internal/finance/*" ] && echo " (aud $APP_ADDRESS/internal/finance/*: $first_refusal)")."
  say "  C2: $condition_note; with aud $APP_ADDRESS/*, GET /api/session was refused by $session, POST /internal/cron by $cron."
  say "  C3: GET /internal/finance/purchases?since=$since: $purchases."
  echo
  say "Next, tell the finance app where the feed is, e.g. in its deploy settings:"
  if [ "$aud_ok" = "$APP_ADDRESS/internal/finance/*" ]; then
    say "  PAPERWORK_URL=$APP_ADDRESS bash deploy/deploy.sh"
  else
    say "  PAPERWORK_URL=$APP_ADDRESS PAPERWORK_FEED_AUDIENCE=$aud_ok bash deploy/deploy.sh"
  fi
  say "Later deploys of Paperwork keep FINANCE_READER_ACCOUNT."
  STEP=""
}

case "$ACTION" in
  isolate) isolate ;;
  split) split ;;
  finance) finance ;;
esac
echo
echo "Done."
