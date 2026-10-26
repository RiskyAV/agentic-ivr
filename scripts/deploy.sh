#!/usr/bin/env bash
# Deploys the loan-poc PoC. Single source of the deploy steps, used locally and by .github/workflows/deploy.yml.
#
#   scripts/deploy.sh bootstrap --pubkey <ci_key.pub> [--dry-run]
#       One-time (and re-runnable) VM setup, run by the OWNER from a laptop through `gcloud compute ssh` as
#       themselves: users loandeploy/loanpoc, /opt/loan-poc, the root-owned activation script and SSH gate, a
#       sudoers drop-in for that one script, systemd units, the nginx site, the CI key. Prints the host key line.
#       Re-run it to change units/nginx/scripts or to rotate the CI key.
#   scripts/deploy.sh api [--dry-run] [--skip-build]
#       Type-check, `git archive` HEAD into a release tarball, upload it over SSH as loandeploy, activate it.
#   scripts/deploy.sh web-build | web | all [--dry-run] [--skip-build]
#       Build apps/web with VITE_API_BASE; `web` also runs `wrangler pages deploy`; `all` = api + web.
#
# Environment:
#   bootstrap: GCP_PROJECT (GCP_PROJECT) GCP_ZONE (VM_ZONE) GCP_VM (VM_NAME) DEPLOY_HOST (for the
#              printed known_hosts line; the VM's external IP or DNS name)
#   api:       DEPLOY_HOST (required) DEPLOY_USER (loandeploy) DEPLOY_KEY_FILE (~/.ssh/loan-poc-deploy)
#              DEPLOY_KNOWN_HOSTS_FILE (~/.ssh/known_hosts)
#   web:       API_BASE (https://api.sparsan.com) PAGES_PROJECT (loan-poc) PAGES_BRANCH (main)
#
# Only our own files are written on the VM: /opt/loan-poc, /usr/local/sbin/loan-poc-*, /etc/sudoers.d/loan-poc-deploy,
# /etc/systemd/system/loan-{api,mocks}.service, the nginx site file loan-poc-api.conf. Another nginx site (e.g.
# `cohost`) and port 3000 are never touched. App secrets live only in /opt/loan-poc/.env on the VM.
set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-GCP_PROJECT}"
GCP_ZONE="${GCP_ZONE:-VM_ZONE}"
GCP_VM="${GCP_VM:-VM_NAME}"
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-loandeploy}"
DEPLOY_KEY_FILE="${DEPLOY_KEY_FILE:-$HOME/.ssh/loan-poc-deploy}"
DEPLOY_KNOWN_HOSTS_FILE="${DEPLOY_KNOWN_HOSTS_FILE:-$HOME/.ssh/known_hosts}"
API_BASE="${API_BASE:-https://api.sparsan.com}"
PAGES_PROJECT="${PAGES_PROJECT:-loan-poc}"
PAGES_BRANCH="${PAGES_BRANCH:-main}"

MODE=""
DRY_RUN=0
SKIP_BUILD=0
PUBKEY_FILE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    bootstrap|api|web|web-build|all) MODE="$1" ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --pubkey) shift; PUBKEY_FILE="${1:-}" ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$MODE" ] || { sed -n '2,26p' "$0"; exit 2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '\n==> %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = 1 ]; then printf '[dry-run]'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}
need() { command -v "$1" >/dev/null || { echo "$1 is required" >&2; exit 1; }; }

# ---------------------------------------------------------------------------------------------
# Bootstrap: a root script generated locally (repo files embedded as base64) and piped to `sudo bash -s` on the VM.
emit_file() { # <dest> <mode> <owner:group> <local file>
  printf 'put %q %q %q %q\n' "$1" "$2" "$3" "$(base64 < "$4" | tr -d '\n')"
}

bootstrap_script() {
  local pubkey="$1"
  cat <<'HEAD'
set -euo pipefail
umask 022
APP=/opt/loan-poc
put() { local tmp; tmp="$(mktemp)"; printf '%s' "$4" | base64 -d > "$tmp"; install -m "$2" -o "${3%%:*}" -g "${3##*:}" "$tmp" "$1"; rm -f "$tmp"; }

echo "--> users"
id -u loanpoc >/dev/null 2>&1 || useradd --system --home-dir "$APP" --no-create-home --shell /usr/sbin/nologin loanpoc
id -u loandeploy >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/loandeploy --shell /bin/bash loandeploy
passwd -l loandeploy >/dev/null 2>&1 || true

echo "--> directories"
install -d -o root -g root -m 755 "$APP" "$APP/releases"
install -d -o loandeploy -g loandeploy -m 750 "$APP/incoming"
install -d -o loanpoc -g loanpoc -m 750 "$APP/data" "$APP/data/events"
install -d -o loanpoc -g loanpoc -m 700 "$APP/.npm"
if [ -f "$APP/.env" ]; then chown root:loanpoc "$APP/.env"; chmod 640 "$APP/.env"
else echo "    WARNING: $APP/.env is missing; copy it before the first deploy (deploy/SETUP.md)"; fi

echo "--> node and ports"
[ -x /usr/bin/node ] || { echo "/usr/bin/node not found (units expect it)" >&2; exit 1; }
[ "$(runuser -u loanpoc -- /usr/bin/node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "Node >= 22 required" >&2; exit 1; }
for spec in 4000:loan-api 4100:loan-mocks; do
  port="${spec%%:*}"; unit="${spec##*:}"
  if ss -ltnH "( sport = :$port )" | grep -q . && ! systemctl is-active --quiet "$unit"; then
    echo "port $port is in use by something other than $unit; aborting" >&2; exit 1
  fi
done
HEAD
  emit_file /usr/local/sbin/loan-poc-activate 755 root:root deploy/loan-poc-activate
  emit_file /usr/local/sbin/loan-poc-ssh-gate 755 root:root deploy/loan-poc-ssh-gate
  emit_file /etc/systemd/system/loan-mocks.service 644 root:root deploy/loan-mocks.service
  emit_file /etc/systemd/system/loan-api.service 644 root:root deploy/loan-api.service
  printf 'NGINX_B64=%q\n' "$(base64 < deploy/nginx-api.conf | tr -d '\n')"
  printf 'PUBKEY=%q\n' "$pubkey"
  printf 'DEPLOY_HOST=%q\n' "$DEPLOY_HOST"
  cat <<'TAIL'

echo "--> sudoers: loandeploy may run only loan-poc-activate"
tmp="$(mktemp)"
cat > "$tmp" <<'SUDO'
# Managed by loan-poc scripts/deploy.sh bootstrap. The CI deploy user may run exactly one root command.
Defaults:loandeploy !requiretty
loandeploy ALL=(root) NOPASSWD: /usr/local/sbin/loan-poc-activate
SUDO
visudo -cf "$tmp" >/dev/null
install -m 440 -o root -g root "$tmp" /etc/sudoers.d/loan-poc-deploy; rm -f "$tmp"

echo "--> CI key (forced command, no forwarding/pty); root-owned so loandeploy cannot add keys"
install -d -o root -g root -m 755 /var/lib/loandeploy/.ssh
printf 'restrict,command="/usr/local/sbin/loan-poc-ssh-gate" %s\n' "$PUBKEY" > /var/lib/loandeploy/.ssh/authorized_keys
chown root:root /var/lib/loandeploy/.ssh/authorized_keys; chmod 644 /var/lib/loandeploy/.ssh/authorized_keys

echo "--> systemd units"
systemctl daemon-reload
systemctl enable loan-mocks loan-api >/dev/null

echo "--> nginx site loan-poc-api.conf"
SITE=loan-poc-api.conf
if [ -d /etc/nginx/sites-available ]; then AVAIL="/etc/nginx/sites-available/$SITE"; ENABLED="/etc/nginx/sites-enabled/$SITE"
else AVAIL="/etc/nginx/conf.d/$SITE"; ENABLED=""; fi
if [ -f "$AVAIL" ] && grep -q 'managed by Certbot' "$AVAIL"; then
  echo "    $AVAIL is managed by certbot; leaving it unchanged"
else
  BACKUP=""; if [ -f "$AVAIL" ]; then BACKUP="$(mktemp)"; cp "$AVAIL" "$BACKUP"; fi
  put "$AVAIL" 644 root:root "$NGINX_B64"
  if [ -n "$ENABLED" ]; then ln -sfn "$AVAIL" "$ENABLED"; fi
  if ! nginx -t; then
    echo "nginx -t failed; restoring the previous $SITE" >&2
    if [ -n "$BACKUP" ]; then cp "$BACKUP" "$AVAIL"; else rm -f "$AVAIL"; [ -z "$ENABLED" ] || rm -f "$ENABLED"; fi
    exit 1
  fi
  systemctl reload nginx
fi

if [ -L "$APP/current" ]; then
  echo "--> restart (units may have changed)"; systemctl restart loan-mocks loan-api
fi

echo
echo "Bootstrap done. DEPLOY_KNOWN_HOSTS (pin this exact line):"
echo "${DEPLOY_HOST:-<DEPLOY_HOST>} $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
TAIL
}

do_bootstrap() {
  [ -n "$PUBKEY_FILE" ] || { echo "bootstrap needs --pubkey <ci_key.pub>" >&2; exit 2; }
  [ -f "$PUBKEY_FILE" ] || { echo "no such file: $PUBKEY_FILE" >&2; exit 2; }
  local pubkey
  pubkey="$(head -n1 "$PUBKEY_FILE")"
  [[ "$pubkey" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [^\"]*)?$ ]] || { echo "--pubkey must be one ssh-ed25519 public key line" >&2; exit 2; }
  [ -n "$DEPLOY_HOST" ] || echo "note: DEPLOY_HOST is unset; the printed known_hosts line will need the host filled in" >&2

  log "bootstrap ${GCP_VM} (${GCP_PROJECT}/${GCP_ZONE}) as $(gcloud config get-value account 2>/dev/null || echo you)"
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] gcloud compute ssh %s --project %s --zone %s --command "sudo bash -s" <<bootstrap script>>\n' \
      "$GCP_VM" "$GCP_PROJECT" "$GCP_ZONE"
    bootstrap_script "$pubkey" | sed -E 's/^(put [^ ]+ [^ ]+ [^ ]+ ).*/\1<base64 of the repo file>/; s/^(NGINX_B64=).*/\1<base64 of deploy\/nginx-api.conf>/' | sed 's/^/    | /'
  else
    need gcloud
    bootstrap_script "$pubkey" | gcloud compute ssh "$GCP_VM" --project "$GCP_PROJECT" --zone "$GCP_ZONE" --command "sudo bash -s"
  fi
}

# ---------------------------------------------------------------------------------------------
SSH_OPTS=()
ssh_opts() {
  SSH_OPTS=(-i "$DEPLOY_KEY_FILE" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes
            -o UserKnownHostsFile="$DEPLOY_KNOWN_HOSTS_FILE" -o ConnectTimeout=20)
}

deploy_api() {
  need git
  [ -n "$DEPLOY_HOST" ] || { echo "DEPLOY_HOST is required for api" >&2; exit 2; }
  if [ "$DRY_RUN" = 0 ]; then
    need ssh
    [ -f "$DEPLOY_KEY_FILE" ] || { echo "deploy key not found: $DEPLOY_KEY_FILE" >&2; exit 2; }
    [ -f "$DEPLOY_KNOWN_HOSTS_FILE" ] || { echo "known_hosts not found: $DEPLOY_KNOWN_HOSTS_FILE" >&2; exit 2; }
  fi
  ssh_opts

  if [ "$SKIP_BUILD" = 0 ]; then
    log "type-check backend workspaces"
    run npx tsc -b packages/shared packages/domain apps/mock-systems apps/server
  fi

  local sha id tarball sum
  sha="$(git rev-parse --short=12 HEAD)"
  id="$(date -u +%Y%m%dT%H%M%S)-${sha}"
  tarball="${TMPDIR:-/tmp}"; tarball="${tarball%/}/loan-poc-${id}.tgz"
  if [ -n "$(git status --porcelain -- packages apps/server apps/mock-systems scripts/start.sh package.json package-lock.json)" ]; then
    echo "warning: uncommitted backend changes are NOT deployed (the release is HEAD ${sha})" >&2
  fi

  log "package release ${id} (git archive of HEAD)"
  run git archive --format=tar.gz -o "$tarball" HEAD -- \
    package.json package-lock.json tsconfig.base.json packages apps/server apps/mock-systems \
    apps/web/package.json scripts/start.sh

  log "upload to ${DEPLOY_USER}@${DEPLOY_HOST}:/opt/loan-poc/incoming"
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] ssh %s %s@%s "upload %s <sha256>" < %s\n' "${SSH_OPTS[*]}" "$DEPLOY_USER" "$DEPLOY_HOST" "$id" "$tarball"
  else
    sum="$(sha256sum "$tarball" 2>/dev/null || shasum -a 256 "$tarball")"; sum="${sum%% *}"
    ssh "${SSH_OPTS[@]}" "${DEPLOY_USER}@${DEPLOY_HOST}" "upload ${id} ${sum}" < "$tarball"
  fi

  log "activate (verify, npm ci as loanpoc, swap, restart, health check, rollback on failure)"
  run ssh "${SSH_OPTS[@]}" "${DEPLOY_USER}@${DEPLOY_HOST}" "activate ${id}"
  run rm -f "$tarball"
  log "api deployed: release ${id}"
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
  bootstrap) do_bootstrap ;;
  api) deploy_api ;;
  web-build) build_web ;;
  web) deploy_web ;;
  all) deploy_api; deploy_web ;;
esac
if [ "$DRY_RUN" = 1 ]; then log "dry run: nothing was changed"; fi
exit 0
