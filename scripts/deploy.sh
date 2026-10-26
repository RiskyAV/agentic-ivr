#!/usr/bin/env bash
# Deploys the loan-poc PoC. Single source of the deploy steps, used locally and by .github/workflows/deploy.yml.
#
#   scripts/deploy.sh [api|web|web-build|all] [--dry-run] [--skip-build]
#
#   api        type-check the backend, upload a release of HEAD to the VM, npm ci --omit=dev there,
#              install/refresh the systemd units and the nginx site for $API_DOMAIN, restart, health-check.
#   web-build  build apps/web with VITE_API_BASE=$API_BASE (CI deploys the result with wrangler-action).
#   web        web-build, then `npx wrangler pages deploy` to the Cloudflare Pages project.
#   all        api, then web (default).
#   --dry-run  print every action (including the remote script) and change nothing.
#
# It only ever writes its own files: /opt/loan-poc, /etc/systemd/system/loan-{api,mocks}.service and the nginx
# site file loan-poc-api.conf. It never edits another nginx site (e.g. `cohost`) and never uses port 3000.
# The app secrets live only on the VM in /opt/loan-poc/.env (see deploy/SETUP.md); this script never writes it.
set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-GCP_PROJECT}"
GCP_ZONE="${GCP_ZONE:-VM_ZONE}"
GCP_VM="${GCP_VM:-VM_NAME}"
GCP_USE_IAP="${GCP_USE_IAP:-0}"            # 1 = gcloud compute ssh/scp --tunnel-through-iap
API_DOMAIN="${API_DOMAIN:-api.sparsan.com}"
API_BASE="${API_BASE:-https://${API_DOMAIN}}"
PAGES_PROJECT="${PAGES_PROJECT:-loan-poc}"
PAGES_BRANCH="${PAGES_BRANCH:-main}"

MODE=all
DRY_RUN=0
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    api|web|web-build|all) MODE="$arg" ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '\n==> %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = 1 ]; then printf '[dry-run]'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

GCLOUD_FLAGS=(--project "$GCP_PROJECT" --zone "$GCP_ZONE" --quiet)
[ "$GCP_USE_IAP" = 1 ] && GCLOUD_FLAGS+=(--tunnel-through-iap)

# ---------------------------------------------------------------------------------------------
# Runs on the VM as root (piped to `sudo bash -s`). Arguments come in as environment variables.
remote_script() {
  cat <<'REMOTE'
set -euo pipefail
APP=/opt/loan-poc
SVC_USER=loanpoc
SITE=loan-poc-api.conf
TARBALL="/tmp/${RELEASE}.tgz"
R="$APP/releases/$RELEASE"

# Our names only; refuse anything that could collide with the existing site.
case "$SITE" in *cohost*) echo "refusing to write an nginx file named $SITE" >&2; exit 1 ;; esac

echo "--> service user and directories"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
install -d -o root -g root -m 755 "$APP" "$APP/releases"
install -d -o "$SVC_USER" -g "$SVC_USER" -m 750 "$APP/data" "$APP/data/events"
if [ ! -f "$APP/.env" ]; then
  echo "missing $APP/.env: copy it to the VM first (deploy/SETUP.md, first-time VM prep)" >&2; exit 1
fi
chown root:"$SVC_USER" "$APP/.env"; chmod 640 "$APP/.env"

echo "--> node"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node not found on PATH" >&2; exit 1; }
NODE_BIN="$(readlink -f "$NODE_BIN")"
MAJOR="$(sudo -u "$SVC_USER" "$NODE_BIN" -p 'process.versions.node.split(".")[0]')" \
  || { echo "$NODE_BIN is not executable by $SVC_USER (install Node 22 system-wide)" >&2; exit 1; }
[ "$MAJOR" -ge 22 ] || { echo "Node >= 22 required, found $MAJOR" >&2; exit 1; }
NPM_BIN="$(dirname "$NODE_BIN")/npm"; [ -x "$NPM_BIN" ] || NPM_BIN="$(command -v npm)"

echo "--> ports 4000/4100 must be free or ours"
for spec in 4000:loan-api 4100:loan-mocks; do
  port="${spec%%:*}"; unit="${spec##*:}"
  if ss -ltnH "( sport = :$port )" | grep -q . && ! systemctl is-active --quiet "$unit"; then
    echo "port $port is in use by something other than $unit; aborting" >&2; exit 1
  fi
done

echo "--> release $RELEASE"
rm -rf "$R"; mkdir -p "$R"
tar -xzf "$TARBALL" -C "$R"
(cd "$R" && HOME=/root "$NPM_BIN" ci --omit=dev --no-audit --no-fund \
  --workspace @app/server --workspace @app/mock-systems --include-workspace-root)
chown -R root:root "$R"; chmod -R a+rX "$R"
ln -sfn "$R" "$APP/current.new" && mv -T "$APP/current.new" "$APP/current"

echo "--> systemd units"
for u in loan-mocks loan-api; do
  sed "s#/usr/bin/node#$NODE_BIN#" "$R/deploy/$u.service" > "/etc/systemd/system/$u.service.new"
  mv "/etc/systemd/system/$u.service.new" "/etc/systemd/system/$u.service"
done
systemctl daemon-reload
systemctl enable loan-mocks loan-api >/dev/null

echo "--> nginx site $SITE"
if [ -d /etc/nginx/sites-available ]; then
  AVAIL="/etc/nginx/sites-available/$SITE"; ENABLED="/etc/nginx/sites-enabled/$SITE"
else
  AVAIL="/etc/nginx/conf.d/$SITE"; ENABLED=""
fi
if [ -f "$AVAIL" ] && grep -q 'managed by Certbot' "$AVAIL"; then
  echo "    $AVAIL is managed by certbot; leaving it unchanged"
else
  BACKUP=""
  if [ -f "$AVAIL" ]; then BACKUP="$(mktemp)"; cp "$AVAIL" "$BACKUP"; fi
  install -m 644 "$R/deploy/nginx-api.conf" "$AVAIL"
  [ -n "$ENABLED" ] && ln -sfn "$AVAIL" "$ENABLED"
  if ! nginx -t; then
    echo "nginx -t failed; restoring the previous $SITE" >&2
    if [ -n "$BACKUP" ]; then cp "$BACKUP" "$AVAIL"; else rm -f "$AVAIL" ${ENABLED:+"$ENABLED"}; fi
    exit 1
  fi
  systemctl reload nginx
fi

echo "--> restart"
systemctl restart loan-mocks
systemctl restart loan-api

echo "--> local health check"
for i in $(seq 1 30); do
  if "$NODE_BIN" -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then
    echo "    healthy after ${i}s"; break
  fi
  [ "$i" = 30 ] && { echo "API not healthy after 30 s" >&2; journalctl -u loan-api -n 40 --no-pager >&2; exit 1; }
  sleep 1
done

echo "--> prune old releases (keep 5)"
ls -1dt "$APP"/releases/* | tail -n +6 | while read -r old; do
  [ "$(readlink -f "$APP/current")" = "$old" ] || rm -rf "$old"
done
rm -f "$TARBALL"
REMOTE
}

# ---------------------------------------------------------------------------------------------
deploy_api() {
  command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
  [ "$DRY_RUN" = 1 ] || command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 1; }

  if [ "$SKIP_BUILD" = 0 ]; then
    log "type-check backend workspaces"
    run npx tsc -b packages/shared packages/domain apps/mock-systems apps/server
  fi

  local sha release tarball
  sha="$(git rev-parse --short=12 HEAD)"
  release="${sha}-$(date -u +%Y%m%d%H%M%S)"
  tarball="${TMPDIR:-/tmp}"; tarball="${tarball%/}/loan-poc-${release}.tgz"
  if [ -n "$(git status --porcelain -- packages apps/server apps/mock-systems deploy scripts/start.sh package.json package-lock.json)" ]; then
    echo "warning: uncommitted backend changes are NOT deployed (the release is HEAD ${sha})" >&2
  fi

  log "package release ${release} (git archive of HEAD)"
  run git archive --format=tar.gz -o "$tarball" HEAD -- \
    package.json package-lock.json tsconfig.base.json packages apps/server apps/mock-systems \
    apps/web/package.json scripts/start.sh deploy

  log "upload to ${GCP_VM} (${GCP_PROJECT}/${GCP_ZONE}, IAP tunnel: $([ "$GCP_USE_IAP" = 1 ] && echo on || echo off))"
  run gcloud compute scp "${GCLOUD_FLAGS[@]}" "$tarball" "${GCP_VM}:/tmp/${release}.tgz"

  log "install on the VM"
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] gcloud compute ssh %s %s --command "sudo RELEASE=%s bash -s" <<remote script>>\n' \
      "${GCLOUD_FLAGS[*]}" "$GCP_VM" "$release"
    remote_script | sed 's/^/    | /'
  else
    remote_script | gcloud compute ssh "${GCLOUD_FLAGS[@]}" "$GCP_VM" --command "sudo RELEASE='${release}' bash -s"
  fi
  run rm -f "$tarball"
  log "api deployed: release ${release}"
}

build_web() {
  log "build web (VITE_API_BASE=${API_BASE})"
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] VITE_API_BASE=%q npm run build -w @app/web\n' "$API_BASE"
  else
    VITE_API_BASE="$API_BASE" npm run build -w @app/web
  fi
}

deploy_web() {
  [ "$SKIP_BUILD" = 1 ] || build_web
  log "deploy web to Cloudflare Pages project ${PAGES_PROJECT} (branch ${PAGES_BRANCH})"
  run npx wrangler pages deploy apps/web/dist --project-name "$PAGES_PROJECT" --branch "$PAGES_BRANCH"
}

case "$MODE" in
  api) deploy_api ;;
  web-build) build_web ;;
  web) deploy_web ;;
  all) deploy_api; deploy_web ;;
esac
[ "$DRY_RUN" = 1 ] && log "dry run: nothing was changed"
exit 0
