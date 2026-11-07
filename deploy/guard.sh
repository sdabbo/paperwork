#!/usr/bin/env bash
# Checks Paperwork's doors from outside. GitHub Actions runs it after every deploy (.github/workflows/deploy.yml);
# run it yourself any time:
#   deploy/guard.sh
# As two services (deploy/protect.sh split), the app must sit behind Google's Identity-Aware Proxy (IAP) with nobody
# else allowed to call it, IAP must let through only the owner's accounts, the edge's and (once deploy/protect.sh
# finance switched on its read-only feed) Finance's, and the public edge must answer only what machines call: AI apps
# (MCP and OAuth), forwarded email and Cloud Scheduler. As one service there is nothing of this to check, and it says
# so.
#
# It reads what Cloud Run says about the services and asks their addresses without any credentials, as a stranger
# would. It changes nothing. Any finding fails it (exit 1), and GitHub emails the run's failure; nothing is rolled
# back by itself (DEPLOY.md, "Back to one service").
# For trying it against servers on this machine: GUARD_APP_URL and GUARD_EDGE_URL (addresses to ask instead of the
# services'), GUARD_WAIT (seconds between tries, default 10).
# shellcheck disable=SC2016  # JavaScript for node in single quotes
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/config.sh
P=(--project "$PROJECT_ID")
WAIT="${GUARD_WAIT:-10}"

FAILED=0
ok() {
  echo "  ok: $*"
}
# A finding; on GitHub also an error on the run's summary page (one line: % and line breaks escaped)
bad() {
  FAILED=$((FAILED + 1))
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    local text="$*"
    text="${text//%/%25}"
    echo "::error::${text//$'\n'/%0A}"
  else
    echo "  FAILED: $*"
  fi
}

EDGE_JSON="$(describe_service "$SERVICE")"
# Not read is not the same as not there: should gcloud fail to read it, the check fails rather than passing as one
# service (service_missing stops it); read a moment later, it is checked
if [ -z "$EDGE_JSON" ] && ! service_missing "$SERVICE"; then EDGE_JSON="$(describe_service "$SERVICE")"; fi
split_mode "$EDGE_JSON"
if [ -z "$SPLIT" ]; then
  # The app behind IAP while paperwork is the whole app again: deployed from a commit from before protect.sh, or
  # back to one service on purpose (then paperwork-app may go)
  if [ "$(service_field "$(describe_service "$APP_SERVICE_DEFAULT")" env PAPERWORK_ROLE)" = app ]; then
    warn "$APP_SERVICE_DEFAULT runs as Paperwork's app behind IAP, but $SERVICE runs as the whole app, public. Unless you went back to one service on purpose (DEPLOY.md, \"Back to one service\"; then delete $APP_SERVICE_DEFAULT), run deploy/protect.sh split again (it skips what is done and makes $SERVICE the edge again), then commit deploy/github-deploy.env."
  fi
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::notice::Paperwork runs as one service ($SERVICE); deploy/protect.sh split adds the doors deploy/guard.sh checks."
  else
    echo "Paperwork runs as one service ($SERVICE): nothing to check here (deploy/protect.sh split adds the doors this checks)."
  fi
  exit 0
fi

PROJECT_NUMBER="${PROJECT_NUMBER:-$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')}"
APP_ADDRESS="${GUARD_APP_URL:-$(service_url_for "$APP_SERVICE")}"
EDGE_ADDRESS="${GUARD_EDGE_URL:-$(service_url)}"
APP_ADDRESS="${APP_ADDRESS%/}"
EDGE_ADDRESS="${EDGE_ADDRESS%/}"
APP_JSON="$(describe_service "$APP_SERVICE")"
# The account the app lets read Finance's feed; empty while the feed is off
FINANCE_ACCOUNT="$(service_field "$APP_JSON" env FINANCE_READER_ACCOUNT)"

# ---------- What Cloud Run says ----------

# $1 actual, $2 expected, $3 what is right, $4 what is wrong and how to fix it
same() {
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$4"; fi
}

echo "The app, $APP_SERVICE (Cloud Run's settings)…"
if [ -z "$APP_JSON" ]; then
  bad "Couldn't read $APP_SERVICE (gcloud run services describe $APP_SERVICE --region $REGION)."
else
  same "$(service_field "$APP_JSON" annotation run.googleapis.com/iap-enabled)" true "IAP is on" \
    "IAP is off for $APP_SERVICE, so Google no longer asks for sign-in before the app. Turn it on again: gcloud run services update $APP_SERVICE --region $REGION --project $PROJECT_ID --iap"
  if [ "$(service_field "$APP_JSON" annotation run.googleapis.com/invoker-iam-disabled)" = true ]; then
    bad "$APP_SERVICE skips Cloud Run's check of who may call it (invoker IAM check disabled). Turn it on again: gcloud run services update $APP_SERVICE --region $REGION --project $PROJECT_ID --invoker-iam-check"
  else
    ok "Cloud Run checks who may call it"
  fi
  same "$(service_field "$APP_JSON" account)" "$RUN_SA" "runs as $RUN_SA" \
    "$APP_SERVICE runs as $(service_field "$APP_JSON" account), not $RUN_SA."
  same "$(service_field "$APP_JSON" env PAPERWORK_ROLE)" app "runs as the app (PAPERWORK_ROLE=app)" \
    "$APP_SERVICE has PAPERWORK_ROLE=$(service_field "$APP_JSON" env PAPERWORK_ROLE), not app: it doesn't check IAP's signed header itself."
  # Finance's read-only feed (deploy/protect.sh finance): either is fine
  if [ -n "$FINANCE_ACCOUNT" ]; then ok "the feed for Finance is switched on for $FINANCE_ACCOUNT"; else ok "the feed for Finance is off"; fi
fi

# Who may call the app: only IAP's service agent, never everyone. The deploy account may not be allowed to read
# this (then the address checks below still show whether IAP is in front).
if POLICY="$(gcloud run services get-iam-policy "$APP_SERVICE" --region "$REGION" "${P[@]}" --format=json 2>/dev/null)"; then
  OPEN="$(printf '%s' "$POLICY" | node -e '
    let s = "";
    process.stdin.on("data", d => (s += d)).on("end", () => {
      const open = [];
      for (const b of JSON.parse(s || "{}").bindings || [])
        for (const m of b.members || []) if (m === "allUsers" || m === "allAuthenticatedUsers") open.push(`${m} (${b.role})`);
      process.stdout.write(open.join(", "));
    });')"
  if [ -z "$OPEN" ]; then
    ok "nobody outside its IAM policy may call it (no allUsers, no allAuthenticatedUsers)"
  else
    bad "$APP_SERVICE may be called by $OPEN. Remove it: gcloud run services remove-iam-policy-binding $APP_SERVICE --region $REGION --project $PROJECT_ID --member=allUsers --role=roles/run.invoker"
  fi
else
  warn "Couldn't read who may call $APP_SERVICE (gcloud run services get-iam-policy); the address checks below still show whether IAP is in front."
fi

# Who IAP lets through to the app: the accounts in the app's ALLOWED_EMAILS, the edge's account (for the scheduled run)
# and Finance's (for the feed), and nobody else. GitHub's deploy account may not be allowed to read IAP's policy, so
# there a finding only warns; run deploy/guard.sh yourself to have it fail.
iap_finding() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then warn "$*"; else bad "$*"; fi
}
if IAP_POLICY="$(gcloud iap web get-iam-policy --resource-type=cloud-run --service="$APP_SERVICE" --region="$REGION" "${P[@]}" --format=json 2>/dev/null)" &&
  EXTRA="$(printf '%s' "$IAP_POLICY" | node -e '
    let s = "";
    process.stdin.on("data", d => (s += d)).on("end", () => {
      let policy;
      try { policy = JSON.parse(s); } catch { process.exit(2); }
      if (!policy || typeof policy !== "object") process.exit(2);
      const [emails, edge, finance] = process.argv.slice(1);
      // IAM writes members as kind:address; the address part compared in lower case
      const norm = m => { const at = m.indexOf(":"); return at < 0 ? m : `${m.slice(0, at)}:${m.slice(at + 1).toLowerCase()}`; };
      const expected = new Set([
        ...emails.split(",").map(e => e.trim().toLowerCase()).filter(Boolean).map(e => `user:${e}`),
        `serviceAccount:${edge.toLowerCase()}`,
        ...(finance ? [`serviceAccount:${finance.toLowerCase()}`] : []),
      ]);
      const extra = [];
      for (const b of policy.bindings || [])
        for (const m of b.members || []) {
          const open = m === "allUsers" || m === "allAuthenticatedUsers" || m.startsWith("domain:") || m.startsWith("group:");
          if (open || b.role !== "roles/iap.httpsResourceAccessor" || !expected.has(norm(m))) extra.push(`${m} (${b.role})`);
        }
      process.stdout.write(extra.join(", "));
    });' "$(service_field "$APP_JSON" env ALLOWED_EMAILS)" "$EDGE_SA" "$FINANCE_ACCOUNT")"; then
  if [ -z "$EXTRA" ]; then
    if [ -n "$FINANCE_ACCOUNT" ]; then
      ok "IAP lets through only the app's ALLOWED_EMAILS, the edge's account and Finance's"
    else
      ok "IAP lets through only the app's ALLOWED_EMAILS and the edge's account"
    fi
  else
    iap_finding "IAP lets through more than it should to $APP_SERVICE: $EXTRA. Remove each: gcloud iap web remove-iam-policy-binding --resource-type=cloud-run --service=$APP_SERVICE --region=$REGION --project $PROJECT_ID --member=<member> --role=<role> (with --condition=None, or the binding's condition)"
  fi
else
  warn "Couldn't read who IAP lets through to $APP_SERVICE (gcloud iap web get-iam-policy); run deploy/guard.sh yourself to check it."
fi

echo "The public edge, $SERVICE (Cloud Run's settings)…"
if [ -z "$EDGE_JSON" ]; then
  bad "Couldn't read $SERVICE (gcloud run services describe $SERVICE --region $REGION)."
else
  same "$(service_field "$EDGE_JSON" env PAPERWORK_ROLE)" edge "runs as the edge (PAPERWORK_ROLE=edge)" \
    "$SERVICE has PAPERWORK_ROLE=$(service_field "$EDGE_JSON" env PAPERWORK_ROLE), not edge: the whole app may be public at $EDGE_ADDRESS. Deploy again (deploy/deploy.sh)."
  if [ "$(service_field "$EDGE_JSON" annotation run.googleapis.com/iap-enabled)" = true ]; then
    bad "IAP is on for $SERVICE: AI apps, mail services and Cloud Scheduler can't sign in with Google, so they are shut out. Turn it off: gcloud run services update $SERVICE --region $REGION --project $PROJECT_ID --no-iap"
  else
    ok "IAP is off (machines call it)"
  fi
  same "$(service_field "$EDGE_JSON" account)" "$EDGE_SA" "runs as $EDGE_SA" \
    "$SERVICE runs as $(service_field "$EDGE_JSON" account), not $EDGE_SA."
  same "$(service_field "$EDGE_JSON" env FINANCE_READER_ACCOUNT)" "" "doesn't carry FINANCE_READER_ACCOUNT (Finance's feed is the app's)" \
    "$SERVICE carries FINANCE_READER_ACCOUNT, which only the app may (it can't start with it). Deploy again (deploy/deploy.sh)."
  if [ -n "$APP_JSON" ]; then
    same "$(service_field "$EDGE_JSON" env FIRESTORE_DB)" "$(service_field "$APP_JSON" env FIRESTORE_DB)" "uses the app's Firestore database" \
      "$SERVICE uses the Firestore database $(service_field "$EDGE_JSON" env FIRESTORE_DB), the app $(service_field "$APP_JSON" env FIRESTORE_DB): they must share one."
  fi
fi

# ---------- What the addresses answer ----------

# Asks an address without credentials. $1 method, $2 address, then curl's options. Sets STATUS (000: no answer),
# LOCATION, WWW_AUTHENTICATE, IAP_GENERATED and BODY (its start, on one line); BODY_FILE holds the whole answer.
BODY_FILE="$(mktemp)"
HEADER_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE" "$HEADER_FILE"' EXIT
header() {
  { grep -i "^$1:" "$HEADER_FILE" || true; } | tail -1 | cut -d: -f2- | sed 's/^ *//' | tr -d '\r'
}
probe() {
  local method="$1" url="$2"
  shift 2
  : >"$BODY_FILE"
  : >"$HEADER_FILE"
  STATUS="$(curl -sS -o "$BODY_FILE" -D "$HEADER_FILE" -w '%{http_code}' --max-time 30 -X "$method" "$@" "$url" 2>/dev/null)" || true
  STATUS="${STATUS:-000}"
  LOCATION="$(header location)"
  WWW_AUTHENTICATE="$(header www-authenticate)"
  IAP_GENERATED="$(header x-goog-iap-generated-response)"
  BODY="$(head -c 200 "$BODY_FILE" | tr '\r\n' '  ')"
}

# A field of the JSON answer
json_field() {
  node -e 'try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]] ?? "")) } catch {}' "$BODY_FILE" "$1"
}

# Asks up to 3 times, GUARD_WAIT seconds apart (a new revision may still be starting), until $1 (a function looking
# at STATUS, LOCATION, …) is satisfied. $2 what is checked, then probe's arguments. A function may set HINT to say
# what a wrong answer means.
expect() {
  local test="$1" what="$2" attempt
  shift 2
  for attempt in 1 2 3; do
    HINT=""
    probe "$@"
    if "$test"; then
      ok "$what"
      return 0
    fi
    [ "$attempt" = 3 ] || sleep "$WAIT"
  done
  bad "$what: got $STATUS${LOCATION:+, Location $LOCATION}${IAP_GENERATED:+, from IAP}${BODY:+, \"$BODY\"}.${HINT:+ $HINT}"
}

google_sign_in() {
  case "$STATUS $LOCATION" in "302 https://accounts.google.com/"*) return 0 ;; esac
  case "$STATUS" in
    2*) HINT="The app answered without Google sign-in: IAP isn't in front of it." ;;
    403)
      if [ "$IAP_GENERATED" = true ]; then
        HINT="IAP refused instead of asking a stranger to sign in; check the IAP settings of $APP_SERVICE."
      else
        HINT="Paperwork's own check of IAP's signed header refused it, which means the request reached the app without IAP: IAP is off, or the service lets everyone call it."
      fi
      ;;
    5*) HINT="The app failed; see its logs in Cloud Run." ;;
    000) HINT="No answer." ;;
  esac
  return 1
}
xhr_signed_out() { [ "$STATUS" = 401 ]; }
not_found() { [ "$STATUS" = 404 ]; }
to_app_consent() { [ "$STATUS" = 302 ] && [ "$LOCATION" = "$APP_ADDRESS/oauth/authorize?probe=1" ]; }
server_metadata() {
  [ "$STATUS" = 200 ] && [ "$(json_field issuer)" = "$EDGE_ADDRESS" ] && [ "$(json_field token_endpoint)" = "$EDGE_ADDRESS/oauth/token" ]
}
resource_metadata() { [ "$STATUS" = 200 ] && [ "$(json_field resource)" = "$EDGE_ADDRESS/mcp" ]; }
mcp_needs_token() {
  [ "$STATUS" = 401 ] || return 1
  case "$WWW_AUTHENTICATE" in *"resource_metadata=\"$EDGE_ADDRESS/.well-known/oauth-protected-resource/mcp\""*) return 0 ;; esac
  return 1
}
unauthorized() { [ "$STATUS" = 401 ]; }
store_read() {
  [ "$STATUS" = 401 ] && return 0
  [ "$STATUS" != 500 ] || HINT="The edge can't read Paperwork's Firestore database, so Gemini and forwarded email fail: $EDGE_SA needs roles/datastore.user for $FIRESTORE_DB (deploy/protect.sh isolate, then split)."
  return 1
}
forbidden() { [ "$STATUS" = 403 ]; }
healthy() { [ "$STATUS" = 200 ] && [ "$BODY" = ok ]; }

echo "The app, $APP_ADDRESS (asked as a stranger)…"
expect google_sign_in "GET / sends a stranger to Google sign-in" GET "$APP_ADDRESS/"
expect google_sign_in "GET /api/session sends a stranger to Google sign-in" GET "$APP_ADDRESS/api/session"
expect google_sign_in "GET /internal/finance/contracts sends a stranger to Google sign-in" GET "$APP_ADDRESS/internal/finance/contracts"
# What the app's own pages send, so an ended IAP session answers 401 instead of a redirect (not verified on Google
# Cloud yet, so only a warning)
probe GET "$APP_ADDRESS/api/session" -H 'X-Requested-With: XMLHttpRequest'
if xhr_signed_out; then
  ok "GET /api/session from the app's own code gets 401 (sign-in ended)"
else
  warn "GET /api/session with X-Requested-With: XMLHttpRequest got $STATUS${LOCATION:+, Location $LOCATION}, not 401; the app reloads itself through Google sign-in only on a 401 (src/lib/iap.ts)."
fi

echo "The public edge, $EDGE_ADDRESS (asked as a stranger)…"
for path in / /index.html /assets/x.js /api/session /auth/signin; do
  expect not_found "GET $path: 404 (no pages, no API, no sign-in on the edge)" GET "$EDGE_ADDRESS$path"
done
expect not_found "POST /oauth/authorize: 404 (allowing an app happens in the app)" POST "$EDGE_ADDRESS/oauth/authorize" --data ''
expect not_found "GET /internal/finance/contracts: 404 on the edge (Finance's feed is the app's)" GET "$EDGE_ADDRESS/internal/finance/contracts"
expect to_app_consent "GET /oauth/authorize sends the browser on to the app's page" GET "$EDGE_ADDRESS/oauth/authorize?probe=1"
expect server_metadata "OAuth metadata names the edge (issuer, token endpoint)" GET "$EDGE_ADDRESS/.well-known/oauth-authorization-server"
expect resource_metadata "MCP's resource is the edge's /mcp" GET "$EDGE_ADDRESS/.well-known/oauth-protected-resource/mcp"
expect mcp_needs_token "POST /mcp without a token: 401 pointing to the edge's metadata" POST "$EDGE_ADDRESS/mcp" -H 'Content-Type: application/json' --data '{}'
expect unauthorized "POST /inbound/email without the secret: 401" POST "$EDGE_ADDRESS/inbound/email" -H 'Content-Type: application/json' --data '{}'
expect forbidden "POST /internal/cron without Cloud Scheduler's token: 403" POST "$EDGE_ADDRESS/internal/cron" --data ''
# The one check that has the edge read its store (none above does): an app it doesn't know asking for a token is
# looked up there and refused with 401, writing nothing; 500 means Firestore refused the edge (protect.sh isolate)
expect store_read "POST /oauth/token for an app it doesn't know: 401 (the edge reads its store)" POST "$EDGE_ADDRESS/oauth/token" \
  --data 'grant_type=refresh_token&client_id=pwc_isolationcheck00000000'
expect healthy "GET /health: ok" GET "$EDGE_ADDRESS/health"
# Not asked: /oauth/register (each refusal would be noted in Settings › AI assistants)

echo
if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED check(s) failed. Nothing was changed or rolled back; DEPLOY.md (\"Checking the doors\") says what each means."
  exit 1
fi
echo "All doors as they should be: the app behind Google sign-in, only machine paths on the edge."
