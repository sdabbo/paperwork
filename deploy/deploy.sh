#!/usr/bin/env bash
# Deploys Paperwork to Cloud Run. Run deploy/setup.sh once before the first deploy.
#
# From your machine (builds the image in Cloud Build; needed for the very first deploy):
#   deploy/deploy.sh                         (or ALLOWED_EMAILS=you@example.com deploy/deploy.sh)
# From GitHub Actions on every push to the deploy branch (.github/workflows/deploy.yml), with the image it built:
#   IMAGE=europe-west3-docker.pkg.dev/<project>/paperwork/paperwork:<commit> deploy/deploy.sh
#
# Once deploy/protect.sh split has made Paperwork two services (GCP_APP_SERVICE in deploy/github-deploy.env), every
# deploy updates both, the app first: the app behind Google's Identity-Aware Proxy (APP_SERVICE) and the public edge
# (SERVICE), from the same image. From your machine, also:
#   DEPLOY_ONLY=app deploy/deploy.sh         only the app (DEPLOY_ONLY=edge: only the edge, with the app's image)
#   PAPERWORK_SPLIT=off deploy/deploy.sh     back to one service (DEPLOY.md, "Back to one service")
# FINANCE_READER_ACCOUNT=… DEPLOY_ONLY=app IMAGE=<the app's image> deploy/deploy.sh is how deploy/protect.sh finance
# switches on the optional read-only feed for a finance app; later deploys keep it.
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/config.sh
P=(--project "$PROJECT_ID")

[ -n "${CI:-}" ] || check_access

# The service as it runs now. A deploy keeps its settings unless the environment or .env gives others, so
# deploys from GitHub need no copies of them.
CURRENT="$(describe_service "$SERVICE")"
# Only a service that doesn't exist is deployed as a new one, public; one that couldn't be read (a passing error)
# could be the edge, which that would turn into the whole app on the internet
if [ -z "$CURRENT" ] && [ -z "${CI:-}" ]; then
  service_missing "$SERVICE" || die "Couldn't read $SERVICE a moment ago, though it exists; nothing was deployed. Try again."
fi
# GitHub Actions sets CI. Its deploy account may only deploy new revisions of an existing service.
if [ -n "${CI:-}" ]; then
  [ -n "${PROJECT_NUMBER:-}" ] || die "GCP_PROJECT_NUMBER is missing (deploy/github-deploy.env or a GitHub variable)."
  [ -n "$CURRENT" ] || die "Service $SERVICE doesn't exist yet. Deploy once from your machine with deploy/deploy.sh, which also makes it public."
  [ "${PAPERWORK_SPLIT:-}" != off ] || die "PAPERWORK_SPLIT=off is for deploys from your machine (DEPLOY.md, \"Back to one service\")."
fi

# One service, or two (sets SPLIT, APP_SERVICE and EDGE_SA; see config.sh)
split_mode "$CURRENT"
APP_CURRENT=""
if [ -n "$SPLIT" ]; then
  APP_CURRENT="$(describe_service "$APP_SERVICE")"
  [ -n "$APP_CURRENT" ] || [ -z "${CI:-}" ] || die "Service $APP_SERVICE doesn't exist yet. Run deploy/protect.sh split first."
  # A failed read isn't a missing service: its settings (IAP_AUDIENCE, as protect.sh may have corrected it) would
  # otherwise fall back to defaults that lock the owner out
  if [ -z "$APP_CURRENT" ]; then
    service_missing "$APP_SERVICE" || die "Couldn't read $APP_SERVICE a moment ago, though it exists; nothing was deployed. Try again."
  fi
  case "${DEPLOY_ONLY:-}" in
    "" | app | edge) ;;
    *) die "DEPLOY_ONLY is app or edge." ;;
  esac
else
  [ -z "${DEPLOY_ONLY:-}" ] || die "DEPLOY_ONLY is for Paperwork as two services (deploy/protect.sh split)."
fi

# A setting of the running service (as two: the app's, else the edge's)
current_value() {
  local value=""
  [ -z "$APP_CURRENT" ] || value="$(service_field "$APP_CURRENT" env "$1")"
  [ -n "$value" ] || value="$(service_field "$CURRENT" env "$1")"
  printf '%s' "$value"
}

# A setting from the environment (GitHub variables), .env, or the running service
setting() {
  local name="$1" value
  value="${!name:-$(env_value "$name")}"
  [ -n "$value" ] || value="$(current_value "$name")"
  printf '%s' "$value"
}

# Who may sign in, and the Google sign-in client (deploy/setup.sh puts both into .env)
ALLOWED_EMAILS="$(setting ALLOWED_EMAILS)"
[ -n "$ALLOWED_EMAILS" ] || die "Set ALLOWED_EMAILS (comma-separated Google accounts). Without it nobody can sign in."
GOOGLE_CLIENT_ID="$(setting GOOGLE_CLIENT_ID)"
[ -n "$GOOGLE_CLIENT_ID" ] || die "GOOGLE_CLIENT_ID is missing (in .env, or as a GitHub variable). DEPLOY.md explains how to make one."
# Google's file picker (made by setup.sh); without it the app offers no picking from Drive
PICKER_API_KEY="$(setting PICKER_API_KEY)"
[ -n "$PICKER_API_KEY" ] || [ -n "${CI:-}" ] || PICKER_API_KEY="$(picker_key)"
[ -n "$PICKER_API_KEY" ] || echo "No browser key for Google's file picker yet: run deploy/setup.sh to make one, then deploy again."

if [ -n "$SPLIT" ]; then
  PROJECT_NUMBER="${PROJECT_NUMBER:-$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')}"
  APP_ADDRESS="$(service_url_for "$APP_SERVICE")"
  URL="$(service_url)"
  # What IAP's signed header is issued for; kept as the running app has it, since protect.sh may have corrected it.
  # Never from .env, which may hold values for running the two roles locally: a wrong one locks you out.
  IAP_AUDIENCE="${IAP_AUDIENCE:-$(current_value IAP_AUDIENCE)}"
  IAP_AUDIENCE="${IAP_AUDIENCE:-/projects/$PROJECT_NUMBER/locations/$REGION/services/$APP_SERVICE}"
  # The audience the edge signs the scheduled run's JWT for, when protect.sh found the default didn't work (from
  # the environment, as protect.sh gives it, or the running edge; never from .env)
  CRON_RELAY_AUDIENCE="${CRON_RELAY_AUDIENCE:-$(service_field "$CURRENT" env CRON_RELAY_AUDIENCE)}"
  # Finance's account, let in on the read-only feed (protect.sh finance gives it in the environment): kept as the
  # running app has it, so deploys from GitHub don't switch the feed off. Never from .env, which may hold values for
  # running locally, and never from the edge, which must not carry it (roles.ts).
  FINANCE_READER_ACCOUNT="${FINANCE_READER_ACCOUNT:-$(service_field "$APP_CURRENT" env FINANCE_READER_ACCOUNT)}"
else
  APP_ADDRESS="$(service_url)"
  URL="$APP_ADDRESS"
fi

yaml() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }
# The settings of one service: role all (one service, as Paperwork always was), app or edge
write_env() {
  local role="$1" file="$2" key value
  {
    echo "NODE_ENV: production"
    echo "STORAGE: firestore"
    echo "GOOGLE_CLOUD_PROJECT: $(yaml "$PROJECT_ID")"
    echo "FIRESTORE_DB: $(yaml "$FIRESTORE_DB")"
    echo "TZ: $(yaml "$APP_TIMEZONE")"
    echo "APP_URL: $(yaml "$APP_ADDRESS")"
    echo "ALLOWED_EMAILS: $(yaml "$ALLOWED_EMAILS")"
    echo "GOOGLE_CLIENT_ID: $(yaml "$GOOGLE_CLIENT_ID")"
    # Cloud Scheduler calls the one service, or the edge
    if [ "$role" != app ]; then
      echo "CRON_SERVICE_ACCOUNT: $(yaml "$CRON_SA")"
      echo "CRON_AUDIENCE: $(yaml "$URL")"
    fi
    if [ -n "$PICKER_API_KEY" ]; then echo "PICKER_API_KEY: $(yaml "$PICKER_API_KEY")"; fi
    # Optional settings, from the environment (GitHub variables), .env or the running service
    for key in GEMINI_MODELS DRIVE_ACCESS APP_LANGUAGE DRIVE_FOLDER_NAME INBOUND_EMAIL_ADDRESS INBOUND_ALLOWED_SENDERS \
      GEMINI_DAILY_REQUEST_LIMIT GEMINI_DAILY_TOKEN_LIMIT GEMINI_EMBEDDING_MODEL GEMINI_DAILY_EMBEDDING_LIMIT; do
      value="$(setting "$key")"
      if [ -n "$value" ]; then echo "$key: $(yaml "$value")"; fi
    done
    # As two services (server/roles.ts checks these at start-up)
    if [ "$role" != all ]; then
      echo "PAPERWORK_ROLE: $role"
      echo "PUBLIC_URL: $(yaml "$URL")"
      echo "CRON_RELAY_ACCOUNT: $(yaml "$EDGE_SA")"
    fi
    if [ "$role" = app ]; then echo "IAP_AUDIENCE: $(yaml "$IAP_AUDIENCE")"; fi
    # Only the app serves Finance's feed; set in the two-service branch above, unset as one service
    if [ "$role" = app ] && [ -n "${FINANCE_READER_ACCOUNT:-}" ]; then echo "FINANCE_READER_ACCOUNT: $(yaml "$FINANCE_READER_ACCOUNT")"; fi
    if [ "$role" = edge ] && [ -n "$CRON_RELAY_AUDIENCE" ]; then echo "CRON_RELAY_AUDIENCE: $(yaml "$CRON_RELAY_AUDIENCE")"; fi
  } >"$file"
}

ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT

# One instance at most each (the app files; scheduled runs, uploads and emails take turns through a lease in the
# store). All work happens while a request is being answered (uploads, emails and scheduled runs wait until their
# documents are filed or dropped into the Inbox), so CPU is only billed then and the server costs nothing while it
# sleeps. Uses SOURCE (image or source) and ACCESS (who may call it).
deploy_service() {
  local name="$1" account="$2"
  gcloud run deploy "$name" "${SOURCE[@]}" --region "$REGION" "${P[@]}" --quiet \
    ${ACCESS[@]+"${ACCESS[@]}"} \
    --service-account "$account" \
    --min-instances 0 --max-instances 1 \
    --cpu-throttling --cpu 1 --memory 1Gi --timeout 600 \
    --env-vars-file "$ENV_FILE" \
    --set-secrets "GEMINI_API_KEY=paperwork-gemini-api-key:latest,GOOGLE_CLIENT_SECRET=paperwork-google-client-secret:latest,APP_SECRET=paperwork-app-secret:latest,INBOUND_EMAIL_SECRET=paperwork-inbound-email-secret:latest"
}

if [ -z "$SPLIT" ]; then
  write_env all "$ENV_FILE"
  if [ -n "${IMAGE:-}" ]; then
    SOURCE=(--image "$IMAGE")
    echo "Deploying ${IMAGE} to ${REGION}…"
  else
    SOURCE=(--source .)
    echo "Building and deploying $SERVICE to $REGION (takes a few minutes)…"
  fi
  # The first deploy makes the service public (the app does its own sign-in). Later deploys keep that setting,
  # so GitHub's deploy account doesn't need the right to change who may call the service.
  ACCESS=()
  [ -z "${CI:-}" ] && ACCESS=(--allow-unauthenticated)
  deploy_service "$SERVICE" "$RUN_SA"
else
  # GitHub's deploy account changes neither IAP nor who may call a service: both carry over from the last deploy
  # from your machine (protect.sh), and deploy/guard.sh checks them after every deploy.
  if [ "${DEPLOY_ONLY:-app}" = app ]; then
    write_env app "$ENV_FILE"
    if [ -n "${IMAGE:-}" ]; then
      SOURCE=(--image "$IMAGE")
      echo "Deploying ${IMAGE} to the app, $APP_SERVICE (behind Google sign-in)…"
    else
      SOURCE=(--source .)
      echo "Building and deploying the app, $APP_SERVICE, behind Google sign-in (takes a few minutes)…"
    fi
    ACCESS=()
    # Only IAP may call the app: gcloud lets IAP's service agent call it, and nobody else
    [ -z "${CI:-}" ] && ACCESS=(--iap --no-allow-unauthenticated)
    deploy_service "$APP_SERVICE" "$RUN_SA"
  fi
  if [ "${DEPLOY_ONLY:-edge}" = edge ]; then
    write_env edge "$ENV_FILE"
    if [ -n "${IMAGE:-}" ]; then
      SOURCE=(--image "$IMAGE")
    else
      # The image the app runs now, built just above (or by the last deploy of the app)
      revision="$(gcloud run services describe "$APP_SERVICE" --region "$REGION" "${P[@]}" --format='value(status.latestReadyRevisionName)')"
      [ -n "$revision" ] || die "$APP_SERVICE has no running revision to take the image from; deploy the app first."
      image="$(gcloud run revisions describe "$revision" --region "$REGION" "${P[@]}" --format='value(status.imageDigest)')"
      [ -n "$image" ] || die "Couldn't read the image of $revision."
      SOURCE=(--image "$image")
    fi
    echo "Deploying the public edge, $SERVICE (AI apps, forwarded email, Cloud Scheduler)…"
    ACCESS=()
    # Public: what calls it can't sign in with Google, and it answers nothing else
    [ -z "${CI:-}" ] && ACCESS=(--allow-unauthenticated)
    deploy_service "$SERVICE" "$EDGE_SA"
  fi
fi

# Manual deploys build into Cloud Run's own image repository, created by the first one; keep it small too
if [ -z "${IMAGE:-}" ] && gcloud artifacts repositories describe cloud-run-source-deploy --location "$REGION" "${P[@]}" >/dev/null 2>&1; then
  gcloud artifacts repositories set-cleanup-policies cloud-run-source-deploy --location "$REGION" \
    --policy deploy/image-cleanup.json --no-dry-run "${P[@]}" >/dev/null || true
fi

echo
if [ -z "$SPLIT" ]; then
  echo "Paperwork is live at $URL"
else
  [ "${DEPLOY_ONLY:-app}" != app ] || echo "Paperwork is live at $APP_ADDRESS (behind Google sign-in)."
  [ "${DEPLOY_ONLY:-edge}" != edge ] || echo "AI apps, forwarded email and Cloud Scheduler use $URL."
fi
