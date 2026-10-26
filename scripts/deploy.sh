#!/usr/bin/env bash
# Deploys the loan-poc PoC. Single source of the deploy steps, used locally and by .github/workflows/deploy.yml.
#
#   scripts/deploy.sh bootstrap --pubkey <ci_key.pub> [--dry-run]
#       One-time (and re-runnable) VM setup, run by the OWNER from a laptop through `gcloud compute ssh` as
#       themselves: users loandeploy/loanbuild/loanpoc, /opt/loan-poc, the root-owned activation script and SSH gate, a
#       sudoers drop-in for that one script, systemd units, the nginx site, the CI key. Prints the host key line.
#       Re-run it to change units/nginx/scripts or to rotate the CI key.
#   scripts/deploy.sh cert [--dry-run]
#       Owner-run like bootstrap: installs the nginx site (serves the ACME challenge), runs certbot in webroot mode for
#       api.sparsan.com (reusing the VM's existing certbot account; renewal is the existing certbot.timer), then
#       switches the nginx site to the TLS variant. Safe to re-run.
#   scripts/deploy.sh api [--dry-run] [--skip-build]
#       Type-check, `git archive` HEAD into a release tarball, upload it over SSH as loandeploy, activate it.
#   scripts/deploy.sh web-build | web | all [--dry-run] [--skip-build]
#       Build apps/web with VITE_API_BASE; `web` also runs `wrangler pages deploy`; `all` = api + web.
#
# Environment (no infrastructure names are hard-coded; the owner keeps them in the git-ignored deploy/local.env, which
# this script loads if present, without overriding variables already set; see deploy/local.env.example):
#   bootstrap: GCP_PROJECT, VM_NAME, VM_ZONE (all required); DEPLOY_HOST (for the printed known_hosts line; the VM's
#              external IP or DNS name); PROTECTED_NGINX_SITES (space-separated nginx site names of other tenants on
#              the VM; bootstrap aborts if any of them changes; default empty)
#   api:       DEPLOY_HOST (required) DEPLOY_USER (loandeploy) DEPLOY_KEY_FILE (~/.ssh/loan-poc-deploy)
#              DEPLOY_KNOWN_HOSTS_FILE (~/.ssh/known_hosts)
#   web:       API_BASE (https://$API_DOMAIN, default https://api.sparsan.com) PAGES_PROJECT (loan-poc) PAGES_BRANCH (main)
#
# Only our own files are written on the VM: /opt/loan-poc, /usr/local/sbin/loan-poc-*, /etc/sudoers.d/loan-poc-deploy,
# /etc/systemd/system/loan-{api,mocks}.service, the nginx site file loan-poc-api.conf. Other nginx sites and ports are
# never edited; the sites in PROTECTED_NGINX_SITES are checksummed before and after. Secrets live only in
# /opt/loan-poc/.env on the VM.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_ENV="${DEPLOY_LOCAL_ENV:-$ROOT/deploy/local.env}"
if [ -f "$LOCAL_ENV" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"; v="${v%\"}"; v="${v#\"}"
    [ -n "${!k:-}" ] || export "$k=$v"
  done < "$LOCAL_ENV"
fi

GCP_PROJECT="${GCP_PROJECT:-}"
VM_NAME="${VM_NAME:-}"
VM_ZONE="${VM_ZONE:-}"
PROTECTED_NGINX_SITES="${PROTECTED_NGINX_SITES:-}"
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-loandeploy}"
DEPLOY_KEY_FILE="${DEPLOY_KEY_FILE:-$HOME/.ssh/loan-poc-deploy}"
DEPLOY_KNOWN_HOSTS_FILE="${DEPLOY_KNOWN_HOSTS_FILE:-$HOME/.ssh/known_hosts}"
API_BASE="${API_BASE:-https://${API_DOMAIN:-api.sparsan.com}}"
PAGES_PROJECT="${PAGES_PROJECT:-loan-poc}"
PAGES_BRANCH="${PAGES_BRANCH:-main}"

MODE=""
DRY_RUN=0
SKIP_BUILD=0
PUBKEY_FILE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    bootstrap|cert|api|web|web-build|all) MODE="$1" ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --pubkey) shift; PUBKEY_FILE="${1:-}" ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$MODE" ] || { sed -n '2,30p' "$0"; exit 2; }

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

# Emits the shell function install_nginx_site (plus both nginx variants as base64) for a root script run on the VM.
# It installs nginx-api-tls.conf when the certificate exists, else nginx-api.conf; the repo owns the site file.
nginx_function() {
  printf 'NGINX_HTTP_B64=%q\n' "$(base64 < deploy/nginx-api.conf | tr -d '\n')"
  printf 'NGINX_TLS_B64=%q\n' "$(base64 < deploy/nginx-api-tls.conf | tr -d '\n')"
  printf 'PROTECTED_NGINX_SITES=%q\n' "$PROTECTED_NGINX_SITES"
  cat <<'NGINXFN'
install_nginx_site() {
  local SITE=loan-poc-api.conf AVAIL ENABLED BACKUP B64 PROTECTED_BEFORE s
  echo "--> protected nginx sites: ${PROTECTED_NGINX_SITES:-none}"
  site_sums() {
    local s f
    for s in $PROTECTED_NGINX_SITES; do
      for f in "/etc/nginx/sites-available/$s" "/etc/nginx/sites-enabled/$s" "/etc/nginx/conf.d/$s.conf"; do
        if [ -e "$f" ]; then printf '%s %s\n' "$f" "$(readlink -f "$f") $(sha256sum < "$f" | cut -d' ' -f1)"; else printf '%s absent\n' "$f"; fi
      done
    done
  }
  for s in $PROTECTED_NGINX_SITES; do
    case "$s" in loan-poc-api|loan-poc-api.conf) echo "PROTECTED_NGINX_SITES must not name our own site ($s)" >&2; exit 1 ;; esac
  done
  PROTECTED_BEFORE="$(site_sums)"

  echo "--> nginx site $SITE"
  # The certbot webroot (shared with any co-hosted site); create it only if missing, never change an existing one.
  [ -d /var/www/letsencrypt ] || install -d -m 755 /var/www/letsencrypt
  if [ -f /etc/letsencrypt/live/api.sparsan.com/fullchain.pem ]; then B64="$NGINX_TLS_B64"; echo "    certificate found: TLS variant"
  else B64="$NGINX_HTTP_B64"; echo "    no certificate yet: HTTP variant (run: scripts/deploy.sh cert)"; fi
  if [ -d /etc/nginx/sites-available ]; then AVAIL="/etc/nginx/sites-available/$SITE"; ENABLED="/etc/nginx/sites-enabled/$SITE"
  else AVAIL="/etc/nginx/conf.d/$SITE"; ENABLED=""; fi
  BACKUP=""; if [ -f "$AVAIL" ]; then BACKUP="$(mktemp)"; cp "$AVAIL" "$BACKUP"; fi
  put "$AVAIL" 644 root:root "$B64"
  if [ -n "$ENABLED" ]; then ln -sfn "$AVAIL" "$ENABLED"; fi
  if ! nginx -t; then
    echo "nginx -t failed; restoring the previous $SITE" >&2
    if [ -n "$BACKUP" ]; then cp "$BACKUP" "$AVAIL"; else rm -f "$AVAIL"; [ -z "$ENABLED" ] || rm -f "$ENABLED"; fi
    exit 1
  fi
  [ -z "$BACKUP" ] || rm -f "$BACKUP"
  systemctl reload nginx

  if [ "$(site_sums)" != "$PROTECTED_BEFORE" ]; then
    echo "a protected nginx site changed during the nginx install; investigate before continuing:" >&2
    diff <(printf '%s\n' "$PROTECTED_BEFORE") <(site_sums) >&2 || true
    exit 1
  fi
}
NGINXFN
}

bootstrap_script() {
  local pubkey="$1"
  cat <<'HEAD'
set -euo pipefail
umask 022
export LC_ALL=C
APP=/opt/loan-poc
put() { local tmp; tmp="$(mktemp)"; printf '%s' "$4" | base64 -d > "$tmp"; install -m "$2" -o "${3%%:*}" -g "${3##*:}" "$tmp" "$1"; rm -f "$tmp"; }

echo "--> users"
id -u loanpoc >/dev/null 2>&1 || useradd --system --home-dir "$APP" --no-create-home --shell /usr/sbin/nologin loanpoc
id -u loanbuild >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin loanbuild
id -u loandeploy >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/loandeploy --shell /bin/bash loandeploy
passwd -l loandeploy >/dev/null 2>&1 || true

echo "--> directories"
install -d -o root -g root -m 755 "$APP" "$APP/releases"
install -d -o loandeploy -g loandeploy -m 750 "$APP/incoming"
install -d -o loanpoc -g loanpoc -m 750 "$APP/data" "$APP/data/events"
rm -rf "$APP/.npm"   # no shared npm cache: each build gets its own, discarded afterwards
install -d -o root -g root -m 755 /var/lib/loan-poc
[ -f /var/lib/loan-poc/deploy.lock ] || install -o root -g loandeploy -m 640 /dev/null /var/lib/loan-poc/deploy.lock
chown root:loandeploy /var/lib/loan-poc/deploy.lock; chmod 640 /var/lib/loan-poc/deploy.lock
if [ -f "$APP/.env" ]; then chown root:loanpoc "$APP/.env"; chmod 640 "$APP/.env"
else echo "    WARNING: $APP/.env is missing; copy it before the first deploy (deploy/SETUP.md)"; fi

echo "--> kernel link protections and systemd-run"
[ "$(sysctl -n fs.protected_hardlinks)" = 1 ] || { echo "fs.protected_hardlinks must be 1 (sysctl -w fs.protected_hardlinks=1)" >&2; exit 1; }
[ "$(sysctl -n fs.protected_symlinks)" = 1 ] || { echo "fs.protected_symlinks must be 1 (sysctl -w fs.protected_symlinks=1)" >&2; exit 1; }
command -v systemd-run >/dev/null || { echo "systemd-run is required (sandboxed builds)" >&2; exit 1; }
# Units block the metadata server (169.254.169.254, also GCE's DNS) and builds block loopback except the resolved stub:
# name resolution must go through systemd-resolved at 127.0.0.53.
grep -Eq '^nameserver 127\.0\.0\.53' /etc/resolv.conf || { echo "/etc/resolv.conf must use the systemd-resolved stub (127.0.0.53)" >&2; exit 1; }

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
  nginx_function
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

install_nginx_site

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
  local missing="" v
  for v in GCP_PROJECT VM_NAME VM_ZONE; do [ -n "${!v}" ] || missing="$missing $v"; done
  [ -z "$missing" ] || { echo "bootstrap needs:${missing} (set them, or put them in deploy/local.env)" >&2; exit 2; }
  [ -n "$DEPLOY_HOST" ] || echo "note: DEPLOY_HOST is unset; the printed known_hosts line will need the host filled in" >&2

  log "bootstrap ${VM_NAME} (${GCP_PROJECT}/${VM_ZONE}) as $(gcloud config get-value account 2>/dev/null || echo you)"
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] GCP_PROJECT=%s VM_NAME=%s VM_ZONE=%s DEPLOY_HOST=%s PROTECTED_NGINX_SITES=%q\n' \
      "$GCP_PROJECT" "$VM_NAME" "$VM_ZONE" "${DEPLOY_HOST:-<unset>}" "$PROTECTED_NGINX_SITES"
    printf '[dry-run] gcloud compute ssh %s --project %s --zone %s --command "sudo bash -s" <<bootstrap script>>\n' \
      "$VM_NAME" "$GCP_PROJECT" "$VM_ZONE"
    bootstrap_script "$pubkey" | sed -E 's/^(put [^ ]+ [^ ]+ [^ ]+ ).*/\1<base64 of the repo file>/; s/^(NGINX_(HTTP|TLS)_B64=).*/\1<base64 of the nginx variant>/' | sed 's/^/    | /'
  else
    need gcloud
    bootstrap_script "$pubkey" | gcloud compute ssh "$VM_NAME" --project "$GCP_PROJECT" --zone "$VM_ZONE" --command "sudo bash -s"
  fi
}

# ---------------------------------------------------------------------------------------------
# cert: issue/renew the API certificate with certbot in webroot mode, then switch the nginx site to the TLS variant.
# The VM's certbot already has an ACME account (from the co-hosted site), so no email flags are passed and it is reused.
# The nginx site must already serve /.well-known/acme-challenge/ from /var/www/letsencrypt, so the HTTP variant is
# installed first; renewals are handled by the existing certbot.timer, and the deploy hook reloads nginx.
cert_script() {
  cat <<'CERTHEAD'
set -euo pipefail
umask 022
export LC_ALL=C
put() { local tmp; tmp="$(mktemp)"; printf '%s' "$4" | base64 -d > "$tmp"; install -m "$2" -o "${3%%:*}" -g "${3##*:}" "$tmp" "$1"; rm -f "$tmp"; }
CERTHEAD
  nginx_function
  cat <<'CERTTAIL'
command -v certbot >/dev/null || { echo "certbot is not installed on the VM" >&2; exit 1; }
install_nginx_site
echo "--> certbot (webroot)"
certbot certonly --webroot -w /var/www/letsencrypt -d api.sparsan.com --non-interactive --agree-tos --keep-until-expiring --deploy-hook "systemctl reload nginx"
install_nginx_site
echo "Certificate in place; nginx now serves the TLS variant."
CERTTAIL
}

do_cert() {
  local missing="" v
  for v in GCP_PROJECT VM_NAME VM_ZONE; do [ -n "${!v}" ] || missing="$missing $v"; done
  [ -z "$missing" ] || { echo "cert needs:${missing} (set them, or put them in deploy/local.env)" >&2; exit 2; }
  log "cert for api.sparsan.com on ${VM_NAME} (${GCP_PROJECT}/${VM_ZONE})"
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] gcloud compute ssh %s --project %s --zone %s --command "sudo bash -s" <<cert script>>\n' "$VM_NAME" "$GCP_PROJECT" "$VM_ZONE"
    cert_script | sed -E 's/^(NGINX_(HTTP|TLS)_B64=).*/\1<base64 of the nginx variant>/' | sed 's/^/    | /'
  else
    need gcloud
    cert_script | gcloud compute ssh "$VM_NAME" --project "$GCP_PROJECT" --zone "$VM_ZONE" --command "sudo bash -s"
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
  [ -n "$DEPLOY_HOST" ] || { echo "DEPLOY_HOST is required for api (set it, or put it in deploy/local.env)" >&2; exit 2; }
  [ "$DRY_RUN" = 0 ] || printf '[dry-run] DEPLOY_HOST=%s DEPLOY_USER=%s API_BASE=%s\n' "$DEPLOY_HOST" "$DEPLOY_USER" "$API_BASE"
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

  log "activate (verify, sandboxed npm ci as loanbuild, swap, restart, health check, rollback on failure)"
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
  cert) do_cert ;;
  api) deploy_api ;;
  web-build) build_web ;;
  web) deploy_web ;;
  all) deploy_api; deploy_web ;;
esac
if [ "$DRY_RUN" = 1 ]; then log "dry run: nothing was changed"; fi
exit 0
