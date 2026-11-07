#!/usr/bin/env bash
# One-time Google Cloud setup for Paperwork: APIs (including Google Drive), the Firestore database, its rules
# and the vector index for search, service accounts, secrets, the Inbox schedule, and deploys from GitHub Actions.
# Safe to run again; run it again after changing a secret in .env (e.g. a new Gemini key). What deploy/protect.sh
# set up later (the app and its public edge as two services) stays as it is.
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/config.sh
# The first time: which project (kept in .env), then everything named after it again
if [ -z "$PROJECT_ID" ]; then
  echo "Which Google Cloud project should Paperwork run in? Make one at https://console.cloud.google.com/projectcreate"
  echo "(billing must be on; one person stays within the free tiers). Its ID, not its name:"
  PROJECT_ID="$(ask_setting PROJECT_ID "Project ID" "$(gcloud config get-value project 2>/dev/null || true)")"
  export PROJECT_ID
  source deploy/config.sh
fi
check_access
P=(--project "$PROJECT_ID")

if [ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null)" = "False" ]; then
  die "Billing is off for $PROJECT_ID. Cloud Run needs a billing account (one person stays within the free tier): https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID"
fi

echo "Turning on the APIs…"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com firebaserules.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com drive.googleapis.com \
  picker.googleapis.com apikeys.googleapis.com "${P[@]}"

# Run as two services (protect.sh split), the edge's account gets the secrets too
split_mode "$(describe_service "$SERVICE")"

echo "Firestore database ${FIRESTORE_DB}…"
if ! gcloud firestore databases describe --database="$FIRESTORE_DB" "${P[@]}" >/dev/null 2>&1; then
  gcloud firestore databases create --database="$FIRESTORE_DB" --location="$FIRESTORE_LOCATION" --type=firestore-native "${P[@]}"
fi

# Searching by meaning asks Firestore for the pieces of text nearest to the question (server/docIndex.ts), which
# only works with a vector index on their embeddings: 768 numbers each, as server/gemini.ts asks the embedding
# model for. Listing first keeps this safe to run again. Firestore names an index's collection group only in
# its resource name.
echo "Firestore vector index for search…"
VECTOR_INDEX="$(gcloud firestore indexes composite list --database="$FIRESTORE_DB" --format=json "${P[@]}" | node -e '
  let s = "";
  process.stdin.on("data", d => (s += d)).on("end", () => {
    const index = JSON.parse(s || "[]").find(i =>
      (i.collectionGroup === "paperworkChunks" || (i.name || "").includes("/collectionGroups/paperworkChunks/")) &&
      (i.fields || []).some(f => f.fieldPath === "embedding" && f.vectorConfig && Number(f.vectorConfig.dimension) === 768));
    process.stdout.write(index ? index.state || "READY" : "");
  });
')"
if [ -z "$VECTOR_INDEX" ]; then
  gcloud firestore indexes composite create --database="$FIRESTORE_DB" --collection-group=paperworkChunks --query-scope=COLLECTION \
    --field-config=field-path=embedding,vector-config='{"dimension":"768","flat":"{}"}' --async "${P[@]}" >/dev/null
  echo "  Created. Firestore takes a few minutes to build it. Searching by meaning starts working once it is ready;"
  echo "  searching by words works meanwhile."
elif [ "$VECTOR_INDEX" = "CREATING" ]; then
  echo "  Still being built. Searching by meaning starts working once it is ready; searching by words works"
  echo "  meanwhile."
elif [ "$VECTOR_INDEX" != "READY" ]; then
  # NEEDS_REPAIR: building it failed. Firestore asks for the index to be deleted and created again.
  echo "  Firestore reports it as $VECTOR_INDEX. Delete it under Firestore › Indexes in the Cloud console, then run"
  echo "  this script again to create it anew. Searching by words works meanwhile."
else
  echo "  ready"
fi

# Only the server reads and writes Firestore (with its service account); the rules shut out browsers.
# A database that already has rules (e.g. shared with another app that uses the same deny-all rules) keeps working.
echo "Firestore rules…"
TOKEN="$(gcloud auth print-access-token)"
RULESET="$(node -e '
  const fs = require("fs");
  process.stdout.write(JSON.stringify({ source: { files: [{ name: "firestore.rules", content: fs.readFileSync("firestore.rules", "utf8") }] } }));
' | curl -sf -X POST "https://firebaserules.googleapis.com/v1/projects/$PROJECT_ID/rulesets" \
  -H "Authorization: Bearer $TOKEN" -H "X-Goog-User-Project: $PROJECT_ID" -H "Content-Type: application/json" --data-binary @- |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).name))')" || RULESET=""
if [ -n "$RULESET" ]; then
  RELEASE="cloud.firestore"
  [ "$FIRESTORE_DB" != "(default)" ] && RELEASE="cloud.firestore/$FIRESTORE_DB"
  BODY="{\"release\":{\"name\":\"projects/$PROJECT_ID/releases/$RELEASE\",\"rulesetName\":\"$RULESET\"}}"
  curl -sf -X PATCH "https://firebaserules.googleapis.com/v1/projects/$PROJECT_ID/releases/$RELEASE" \
    -H "Authorization: Bearer $TOKEN" -H "X-Goog-User-Project: $PROJECT_ID" -H "Content-Type: application/json" -d "$BODY" >/dev/null ||
    curl -sf -X POST "https://firebaserules.googleapis.com/v1/projects/$PROJECT_ID/releases" \
      -H "Authorization: Bearer $TOKEN" -H "X-Goog-User-Project: $PROJECT_ID" -H "Content-Type: application/json" \
      -d "{\"name\":\"projects/$PROJECT_ID/releases/$RELEASE\",\"rulesetName\":\"$RULESET\"}" >/dev/null ||
    echo "  Could not activate the rules; deploy firestore.rules in the Firebase console if browsers could reach this database."
else
  echo "  Could not upload the rules (is the Firebase Rules API allowed?); the server works without them."
fi

echo "Service accounts…"
for sa in "paperwork-server:Paperwork server" "paperwork-scheduler:Paperwork scheduler"; do
  name="${sa%%:*}"
  gcloud iam service-accounts describe "$name@$PROJECT_ID.iam.gserviceaccount.com" "${P[@]}" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$name" --display-name "${sa#*:}" "${P[@]}"
done
# The server may use Paperwork's database only, never the project's others (other apps'). An older grant of
# every database stays until deploy/protect.sh isolate takes it away.
CONDITION_FILE="$(mktemp)"
db_condition "$FIRESTORE_DB" >"$CONDITION_FILE"
retry gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$RUN_SA" --role roles/datastore.user \
  --condition-from-file="$CONDITION_FILE" >/dev/null
rm -f "$CONDITION_FILE"
# Deploying from source builds the image in Cloud Build, which runs as the default compute account
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role roles/run.builder --condition=None >/dev/null

# The server reads the secrets; as two services, so does the edge
grant_secret() {
  local sa
  for sa in "$RUN_SA" ${SPLIT:+"$EDGE_SA"}; do
    retry gcloud secrets add-iam-policy-binding "$1" --member "serviceAccount:$sa" --role roles/secretmanager.secretAccessor "${P[@]}" >/dev/null
  done
}

# Secrets in Secret Manager. Values come from .env on this machine and are never printed.
put_secret() {
  local name="$1" value="$2"
  [ -n "$value" ] || die "No value for $name. Add it to .env first."
  if ! gcloud secrets describe "$name" "${P[@]}" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets create "$name" --data-file=- --replication-policy=automatic "${P[@]}" >/dev/null
    echo "  $name: created"
  elif [ "$(gcloud secrets versions access latest --secret "$name" "${P[@]}" 2>/dev/null | shasum -a 256)" != "$(printf '%s' "$value" | shasum -a 256)" ]; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- "${P[@]}" >/dev/null
    echo "  $name: updated"
  else
    echo "  $name: unchanged"
  fi
  grant_secret "$name"
}

# Made once and kept: a new APP_SECRET would sign everyone out and lose the Drive connection (its token is
# encrypted with it); a new email secret would have to be given to the email service again.
generated_secret() {
  local name="$1"
  if gcloud secrets describe "$name" "${P[@]}" >/dev/null 2>&1; then
    echo "  $name: unchanged"
    grant_secret "$name"
  else
    put_secret "$name" "$(node -e 'process.stdout.write(require("crypto").randomBytes(36).toString("base64url"))')"
  fi
}

echo "Secrets…"
# A secret already in Secret Manager is kept when .env doesn't have it, so a second run asks for nothing
secret_exists() { gcloud secrets describe "$1" "${P[@]}" >/dev/null 2>&1; }
# $1 the secret, $2 the setting in .env, $3 the question when neither has it
secret_from() {
  local value
  value="$(env_value "$2")"
  if [ -n "$value" ]; then
    put_secret "$1" "$value"
  elif secret_exists "$1"; then
    echo "  $1: unchanged"
    grant_secret "$1"
  else
    put_secret "$1" "$(ask_setting "$2" "$3" "" secret)"
  fi
}

secret_exists paperwork-gemini-api-key || [ -n "$(env_value GEMINI_API_KEY)" ] ||
  echo "  A Gemini API key reads and names the documents. Make one at https://aistudio.google.com/apikey"
secret_from paperwork-gemini-api-key GEMINI_API_KEY "  Gemini API key (not shown)"

# Signing in and Drive access go through a Google OAuth client of type "Web application" (DEPLOY.md, "Google sign-in
# and Drive access"): its ID is kept in .env, its secret only in Secret Manager
CLIENT_ID="$(env_value GOOGLE_CLIENT_ID)"
if [ -z "$CLIENT_ID" ]; then
  echo "  Paperwork signs you in with Google and files into your Drive through an OAuth client of type \"Web"
  echo "  application\": https://console.cloud.google.com/apis/credentials?project=$PROJECT_ID (DEPLOY.md, \"Google"
  echo "  sign-in and Drive access\", has the steps; its redirect addresses are printed at the end of this script)."
  CLIENT_ID="$(ask_setting GOOGLE_CLIENT_ID "  Client ID")"
fi
secret_from paperwork-google-client-secret GOOGLE_CLIENT_SECRET "  Client secret (not shown)"

# Who may sign in (deploy.sh reads it from .env)
if [ -z "$(env_value ALLOWED_EMAILS)" ]; then
  echo "  Only the Google accounts you name may sign in (comma-separated)."
  ask_setting ALLOWED_EMAILS "  Allowed accounts" "$(gcloud config get-value account 2>/dev/null || true)" >/dev/null
fi
generated_secret paperwork-app-secret
generated_secret paperwork-inbound-email-secret

URL="$(service_url)"
# The address the owner opens: the app's, as two services
APP_ADDRESS="$URL"
[ -z "$SPLIT" ] || APP_ADDRESS="$(service_url_for "$APP_SERVICE")"

# Google's file picker runs in the browser and needs a browser key: made once, limited to the Picker API and
# to Paperwork's pages (deploy.sh hands it to the app)
echo "Browser key for Google's file picker…"
if [ -z "$(picker_key)" ]; then
  REFERRERS="$URL/*,http://localhost:3000/*"
  [ -z "$SPLIT" ] || REFERRERS="$APP_ADDRESS/*,$REFERRERS"
  gcloud services api-keys create --display-name="$PICKER_KEY_NAME" --api-target=service=picker.googleapis.com \
    --allowed-referrers="$REFERRERS" "${P[@]}" >/dev/null 2>&1 ||
    echo "  Could not make the key; picking files from Drive stays off until setup.sh runs again."
fi

# Cloud Scheduler calls the one service, or the public edge (which hands the run on to the app)
echo "Inbox schedule ($CRON_SCHEDULE)…"
JOB=(paperwork-inbox --location "$REGION" "${P[@]}" --schedule "$CRON_SCHEDULE" --time-zone "$APP_TIMEZONE"
  --uri "$URL/internal/cron" --http-method POST --oidc-service-account-email "$CRON_SA" --oidc-token-audience "$URL" --attempt-deadline 600s)
if gcloud scheduler jobs describe paperwork-inbox --location "$REGION" "${P[@]}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${JOB[@]}" >/dev/null
else
  gcloud scheduler jobs create http "${JOB[@]}" >/dev/null
fi

# Images: GitHub Actions pushes one per deploy; manual deploys build into cloud-run-source-deploy. Only the
# latest few are kept, so storage stays within the free 0.5 GB.
echo "Image repository…"
gcloud artifacts repositories describe "$REPOSITORY" --location "$REGION" "${P[@]}" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$REPOSITORY" --repository-format docker --location "$REGION" --description "Paperwork images" "${P[@]}"
for repo in "$REPOSITORY" cloud-run-source-deploy; do
  if gcloud artifacts repositories describe "$repo" --location "$REGION" "${P[@]}" >/dev/null 2>&1; then
    gcloud artifacts repositories set-cleanup-policies "$repo" --location "$REGION" --policy deploy/image-cleanup.json --no-dry-run "${P[@]}" >/dev/null
  fi
done

# Deploys from GitHub Actions: GitHub's sign-in token for a push to the deploy branch of this repository is
# exchanged for the deploy account, which may push images and deploy new revisions, nothing else. The pool may
# already exist for another app in this project; Paperwork adds its own provider.
if [ -n "$GITHUB_REPO" ]; then
  echo "Deploys from GitHub ($GITHUB_REPO, $DEPLOY_BRANCH branch)…"
  POOL=github-actions
  PROVIDER_ID=paperwork
  gcloud iam workload-identity-pools describe "$POOL" --location global "${P[@]}" >/dev/null 2>&1 ||
    gcloud iam workload-identity-pools create "$POOL" --location global --display-name "GitHub Actions" "${P[@]}"
  PROVIDER=("$PROVIDER_ID" --location global --workload-identity-pool "$POOL" "${P[@]}"
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref"
    --attribute-condition "assertion.repository == '$GITHUB_REPO' && assertion.ref == 'refs/heads/$DEPLOY_BRANCH'")
  if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --location global --workload-identity-pool "$POOL" "${P[@]}" >/dev/null 2>&1; then
    gcloud iam workload-identity-pools providers update-oidc "${PROVIDER[@]}" >/dev/null
  else
    gcloud iam workload-identity-pools providers create-oidc "${PROVIDER[@]}" --issuer-uri https://token.actions.githubusercontent.com >/dev/null
  fi

  gcloud iam service-accounts describe "$DEPLOY_SA" "${P[@]}" >/dev/null 2>&1 ||
    gcloud iam service-accounts create paperwork-deployer --display-name "Paperwork deploys from GitHub" "${P[@]}"
  for role in roles/run.developer roles/serviceusage.serviceUsageConsumer; do
    retry gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$DEPLOY_SA" --role "$role" --condition=None >/dev/null
  done
  retry gcloud artifacts repositories add-iam-policy-binding "$REPOSITORY" --location "$REGION" --member "serviceAccount:$DEPLOY_SA" \
    --role roles/artifactregistry.writer "${P[@]}" >/dev/null
  # New revisions run as the server account
  retry gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" --member "serviceAccount:$DEPLOY_SA" \
    --role roles/iam.serviceAccountUser "${P[@]}" >/dev/null
  retry gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role roles/iam.workloadIdentityUser "${P[@]}" \
    --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$GITHUB_REPO" >/dev/null

  # Where GitHub Actions deploys to; committed with the code (nothing in it is secret). What protect.sh added
  # (two services) stays.
  KEPT="$(grep -E '^(GCP_APP_SERVICE|GCP_EDGE_SERVICE_ACCOUNT)=' deploy/github-deploy.env 2>/dev/null || true)"
  cat >deploy/github-deploy.env <<TEXT
# Where GitHub Actions deploys Paperwork (.github/workflows/deploy.yml). Written by deploy/setup.sh; GitHub
# repository variables of the same names take precedence. Nothing here is secret: Google accepts GitHub's sign-in
# for the deploy account only from pushes to this repository's deploy branch (see deploy/setup.sh).
GCP_PROJECT_ID=$PROJECT_ID
GCP_PROJECT_NUMBER=$PROJECT_NUMBER
GCP_REGION=$REGION
GCP_WORKLOAD_IDENTITY_PROVIDER=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER_ID
GCP_DEPLOY_SERVICE_ACCOUNT=$DEPLOY_SA
TEXT
  [ -z "$KEPT" ] || echo "$KEPT" >>deploy/github-deploy.env
  echo "  Pushes to $DEPLOY_BRANCH deploy once deploy/github-deploy.env is committed there (git status shows whether it changed)."
fi

cat <<TEXT

Setup done.
1. Add these two "Authorized redirect URIs" to the Google sign-in client (one click in the console, then Save):
     $APP_ADDRESS/auth/callback
     http://localhost:3000/auth/callback
   https://console.cloud.google.com/apis/credentials/oauthclient/$CLIENT_ID?project=$PROJECT_ID
2. Deploy once from this machine (the accounts in ALLOWED_EMAILS in .env may sign in):
     deploy/deploy.sh
3. Deploys from GitHub: commit deploy/github-deploy.env and push it to $DEPLOY_BRANCH. Then protect the repository
   (only you may push to $DEPLOY_BRANCH, secret scanning, approval before strangers' pull requests run workflows):
     deploy/github-settings.sh
4. Recommended: the app behind Google's Identity-Aware Proxy, each account limited to Paperwork's database:
     deploy/protect.sh (it explains each step and asks before every change)
5. Email (optional): give the email worker the shared secret without printing it:
     gcloud secrets versions access latest --secret paperwork-inbound-email-secret --project $PROJECT_ID | (cd email-worker && npx wrangler secret put INBOUND_EMAIL_SECRET)
TEXT
