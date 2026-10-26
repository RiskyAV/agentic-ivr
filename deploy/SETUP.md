# One-time setup: repository, deploy key, VM, Cloudflare

This is the bootstrap that runs once before `.github/workflows/deploy.yml` can deploy. Every step is a command for the owner to run by hand, in order. Nothing here runs automatically. After this, a push to `main` runs CI and then deploys:

- **API.** The `api` job runs `scripts/deploy.sh api`. It uploads a `git archive` tarball of the commit over SSH as the locked-down user `loandeploy`. The root-owned activation script on the VM then:
  - verifies the tarball;
  - unpacks it and runs `npm ci --omit=dev --ignore-scripts` as the build user `loanbuild`, in a sandboxed transient systemd unit;
  - swaps the `current` symlink;
  - restarts the units and health-checks, rolling back on failure.
- **Web.** The `web` job deploys the app to Cloudflare Pages.

CI holds **no cloud credentials**: there is no GCP service account and no Workload Identity Federation. Only the owner's own `gcloud` login is used, and only for the one-time bootstrap.

Fixed names used below:

| What | Value |
|---|---|
| Repository | `RiskyAV/agentic-ivr` (public; only the owner pushes) |
| GCP project / zone / VM | `$GCP_PROJECT` / `$VM_ZONE` / `$VM_NAME`, kept in the git-ignored `deploy/local.env` (template: `deploy/local.env.example`). The VM has metadata SSH keys, port 22 open, Node 22 at `/usr/bin/node` and certbot installed |
| API domain | `api.sparsan.com` → nginx on the VM → `127.0.0.1:4000` |
| Pages project | `loan-poc` (production branch `main`) |
| VM users | `loandeploy` (CI uploads and activation only), `loanbuild` (builds releases), `loanpoc` (runs the app); only `loandeploy` has a shell, and it is reachable only through the forced command |
| VM paths | `/opt/loan-poc/{incoming,releases,current,data,.env}` |

The VM may already serve an existing co-hosted site, which holds `default_server` on 80/443 and uses its own port. Nothing here or in `deploy.sh` edits that site, changes the default server or uses that port. List its nginx site name(s) in `PROTECTED_NGINX_SITES` (in `deploy/local.env`; default empty): bootstrap checksums those site files before and after and aborts if any changed. Our block matches only `server_name api.sparsan.com`. Our files are:

- `/etc/nginx/sites-{available,enabled}/loan-poc-api.conf`;
- `/etc/systemd/system/loan-{api,mocks}.service`;
- `/usr/local/sbin/loan-poc-{activate,ssh-gate}`;
- `/etc/sudoers.d/loan-poc-deploy`;
- `/var/lib/loandeploy`;
- everything under `/opt/loan-poc`.

```bash
# Shell variables used throughout (deploy/local.env holds GCP_PROJECT, VM_NAME, VM_ZONE, DEPLOY_HOST, PROTECTED_NGINX_SITES)
set -a; . deploy/local.env; set +a
export PROJECT=$GCP_PROJECT ZONE=$VM_ZONE VM=$VM_NAME
export REPO=RiskyAV/agentic-ivr
export DEPLOY_HOST=${DEPLOY_HOST:-$(gcloud compute instances describe $VM --project $PROJECT --zone $ZONE \
  --format='value(networkInterfaces[0].accessConfigs[0].natIP)')}   # the VM's external IP (make sure it is static)
```

---

## 1. Before the first push

Run these from the repo root. The repository must contain no secrets in any commit, and the local-only folders must be ignored.

```bash
gitleaks git --redact -v .                       # full history; must end with "no leaks found"
git check-ignore -v .env .data/x .superpowers/x .idea/x   # each line must name a .gitignore rule
git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '^\.env\.example$' && echo "STOP: env file tracked" || echo "ok: no env files tracked"
git ls-files .data .superpowers .idea | head      # must print nothing
```

`gitleaks dir .` (the working tree) reports the real keys in `.env`. That is expected, because `.env` is ignored and never committed. The scan that matters is `gitleaks git` over the history.

## 2. Create the repository and harden it

```bash
gh repo create $REPO --public --source . --remote origin --disable-wiki \
  --description "AI loan-servicing PoC: voice + text agent over mock enterprise systems"

# Wiki, projects and discussions off
gh repo edit $REPO --enable-wiki=false --enable-projects=false --enable-discussions=false

# No collaborators: this must print only the owner
gh api repos/$REPO/collaborators --jq '.[].login'

# Ruleset on main: no deletion, no force push. Only repository admins (the owner) can update it:
# the "update" rule blocks everyone else, and admins bypass.
gh api -X POST repos/$REPO/rulesets --input - <<'JSON'
{
  "name": "main: owner only",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [ { "type": "deletion" }, { "type": "non_fast_forward" }, { "type": "update" } ],
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ]
}
JSON

# Interaction limits: only collaborators may open issues/PRs or comment. Six months is the longest;
# re-run this command when it expires.
gh api -X PUT repos/$REPO/interaction-limits -f limit=collaborators_only -f expiry=six_months

# Fork PR workflows need approval for every outside contributor.
gh api -X PUT repos/$REPO/actions/permissions/fork-pr-contributor-approval \
  -f approval_policy=all_external_contributors

# The default GITHUB_TOKEN is read-only, and workflows cannot approve PRs.
gh api -X PUT repos/$REPO/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

# Allowed actions: GitHub-owned, verified creators, plus the Pages deploy action by name.
gh api -X PUT repos/$REPO/actions/permissions -F enabled=true -f allowed_actions=selected
gh api -X PUT repos/$REPO/actions/permissions/selected-actions \
  -F github_owned_allowed=true -F verified_allowed=true \
  -f 'patterns_allowed[]=cloudflare/wrangler-action@*'

# Dependabot alerts, secret scanning and push protection
gh api -X PUT repos/$REPO/vulnerability-alerts
gh api -X PATCH repos/$REPO \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
```

**Pinning trade-off.** The workflows pin actions by major version (`@v4`, `@v3`), and the allow-list above restricts who can publish them. Pinning by commit SHA (`uses: owner/action@<40-hex>`) is stronger: a moved tag cannot change what runs. The cost is that updates become manual, or need Dependabot for `github-actions`. For a public repo whose deploy job holds a deploy key and a Cloudflare token, SHA pinning is the better default once the workflows are stable. To switch, replace each `@vN` with the SHA that the tag points at today.

### The `production` environment

Both deploy jobs (`api` and `web`) run in the `production` environment, which holds the deploy secrets. Limit it to `main`. You can also add the owner as a required reviewer: every job that uses the environment then waits for approval, so one deploy asks for **two** approvals (api, then web). Both can be approved from the same workflow run page.

```bash
OWNER_ID=$(gh api users/RiskyAV --jq .id)
gh api -X PUT repos/$REPO/environments/production --input - <<JSON
{
  "reviewers": [ { "type": "User", "id": $OWNER_ID } ],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
JSON
gh api -X POST repos/$REPO/environments/production/deployment-branch-policies -f name=main -f type=branch
```

Drop the `reviewers` entry to deploy without approval clicks.

## 3. Deploy key and VM bootstrap

### Generate the CI deploy key (locally, never committed)

```bash
ssh-keygen -t ed25519 -N '' -C 'loan-poc-ci' -f ~/.ssh/loan-poc-deploy
# ~/.ssh/loan-poc-deploy      private key: goes ONLY into the GitHub environment secret (section 4)
# ~/.ssh/loan-poc-deploy.pub  public key: installed on the VM by bootstrap
```

The key lives in `~/.ssh`, outside the repository. Never copy it into the repo folder. `gitleaks` in CI would flag it, but do not rely on that.

### The app `.env` (only on the VM)

No workflow ever writes this file. Prepare it on the laptop from `.env.example`. `.env.*` is git-ignored, so this file cannot be committed.

```bash
cp .env.example .env.production
# Edit .env.production:
#   GEMINI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID   real keys
#   LLM_PROVIDER=gemini
#   SESSION_SECRET=<output of: openssl rand -hex 32>         sessions survive restarts
#   DEMO_ACCESS_CODE=<a code you share with reviewers>       gates login and chaos changes (a warning is logged if empty)
#   WEB_ORIGIN=https://loan-poc.pages.dev[,https://<web domain>]   CORS for the Pages site: required, or the browser is blocked
#   MAX_VOICE_SESSIONS=5
# Do NOT set TEST_HOOKS (refused in production), HOST, TRUST_PROXY or EVENT_LOG_DIR (the systemd unit sets those;
# values in the env file would override them).

gcloud compute ssh $VM --project $PROJECT --zone $ZONE --command 'sudo install -d -m 755 /opt/loan-poc'
gcloud compute scp .env.production $VM:/tmp/loan-poc.env --project $PROJECT --zone $ZONE
gcloud compute ssh $VM --project $PROJECT --zone $ZONE --command \
  'sudo install -o root -g root -m 600 /tmp/loan-poc.env /opt/loan-poc/.env && rm -f /tmp/loan-poc.env'
rm .env.production    # or keep it in a password manager
```

Bootstrap then sets the file to `root:loanpoc 640`. To change a value later, edit `/opt/loan-poc/.env` on the VM, then run `sudo systemctl restart loan-api loan-mocks`.

### Bootstrap (run by the owner, as themselves)

```bash
scripts/deploy.sh bootstrap --pubkey ~/.ssh/loan-poc-deploy.pub --dry-run   # shows the exact root script; changes nothing
scripts/deploy.sh bootstrap --pubkey ~/.ssh/loan-poc-deploy.pub
```

It runs over `gcloud compute ssh` with your own account and `sudo`, and it is idempotent. It:

1. creates three users:
   - `loanpoc` (runtime, no login shell);
   - `loanbuild` (extracts and installs releases, no login shell);
   - `loandeploy` (password locked, shell `/bin/bash`, home `/var/lib/loandeploy`);
2. creates `/opt/loan-poc/{releases,incoming,data}` (only `incoming/` belongs to `loandeploy`) and the deploy lock `/var/lib/loan-poc/deploy.lock` (`root:loandeploy 640`);
3. checks Node 22 at `/usr/bin/node`, that `systemd-run` exists, that DNS goes through the systemd-resolved stub (`nameserver 127.0.0.53`, because the units block 169.254.169.254, which is also GCE's DNS server), that `fs.protected_hardlinks` and `fs.protected_symlinks` are 1, and that ports 4000/4100 are free or already ours;
4. installs the root-owned `/usr/local/sbin/loan-poc-activate` and `/usr/local/sbin/loan-poc-ssh-gate` (sources in `deploy/`);
5. writes `/etc/sudoers.d/loan-poc-deploy`, validated with `visudo -cf`: `loandeploy` may run **only** `loan-poc-activate`, with NOPASSWD;
6. writes the CI public key to `/var/lib/loandeploy/.ssh/authorized_keys` as `restrict,command="/usr/local/sbin/loan-poc-ssh-gate" ssh-ed25519 …`. The file and its directory are root-owned;
7. installs the systemd units and the nginx site. It installs `deploy/nginx-api-tls.conf` if `/etc/letsencrypt/live/api.sparsan.com/fullchain.pem` exists, else the HTTP-only `deploy/nginx-api.conf`, and creates `/var/www/letsencrypt` if missing. The repo owns the site file in both states. It runs `nginx -t` before reloading and restores the old file on failure;
8. prints the line to pin as `DEPLOY_KNOWN_HOSTS`, for example `203.0.113.10 ssh-ed25519 AAAA…`. Check it against `gcloud compute ssh $VM … --command 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'`.

There is no shared npm cache. Each build gets its own cache inside its build directory, and the cache is deleted with it.

Re-run bootstrap whenever `deploy/*.service`, `deploy/nginx-api.conf`, `deploy/nginx-api-tls.conf` or the two scripts change. **A normal deploy never changes them.**

### What the deploy key can do (blast radius)

- `restrict` turns off port, agent and X11 forwarding, PTY allocation and `~/.ssh/rc`.
- The forced command `loan-poc-ssh-gate` ignores what the client asks for and accepts exactly two requests:
  - `upload <id> <sha256>`: stdin is written to `/opt/loan-poc/incoming/<id>.tgz`. Each upload is capped at 50 MB, with at most 3 pending uploads and 200 MB in total. An id that already exists is refused and the deploy lock is taken. Partial uploads, and uploads that were never activated, are removed after 1 hour;
  - `activate <id>`: runs `sudo /usr/local/sbin/loan-poc-activate <id>`.

  There is no shell, and no scp or sftp. The scripts upload by streaming over SSH instead of scp, because a forced command and scp do not mix safely.
- The activation script takes one argument matching `^[0-9]{8}T[0-9]{6}-[0-9a-f]{7,40}$`. Under the deploy lock it reads the upload **as `loandeploy`** into a root-only staging directory, so a swapped or symlinked upload cannot trick root. It then removes the upload and checks only that private copy:
  - checksum and size;
  - regular files and directories only (no symlinks, hardlinks, devices or fifos);
  - no absolute paths and no `..`;
  - no `.npmrc` or `.yarnrc*` anywhere.

  The upload is deleted on every exit path.
- **The build** extracts the archive and runs `npm ci --omit=dev --ignore-scripts --git=/bin/false` **as `loanbuild`**, with user and global npm config pointed at empty root-owned files. It runs inside a transient systemd unit (`systemd-run --wait`) with these limits:
  - its own cgroup, killed at the end;
  - `ProtectSystem=strict`, with the build directory as the only writable path;
  - `PrivateTmp`, `PrivateDevices`, `NoNewPrivileges` and `RestrictSUIDSGID`;
  - 1 GB of memory and 10 minutes of runtime;
  - `PrivateIPC`/`RemoveIPC`;
  - no network access to the metadata server or to loopback, except the DNS stub `127.0.0.53`.

  The build directory, which holds its own npm cache, cannot be reached by `loanpoc` (the live app) or `loandeploy`. Afterwards every `loanbuild` process is killed, and the deploy aborts if any survives. Root then locks the tree, aborts if any file has extra hardlinks, and changes ownership to root and the tree to read-only without following links. Only then is it moved into place. If a first deploy fails, it stops the units and removes the release. A later failure rolls back to the previous release.
- It never installs units, nginx config or sudoers from the tarball.

So a leaked key lets an attacker deploy arbitrary **application code that runs as `loanpoc`**. During a build, the attacker's archive also influences what `npm ci` does inside the sandbox as `loanbuild`, but nothing from the build outlives it: the processes are killed, the per-build cache is deleted, and the tree becomes root-owned. That application code can read `/opt/loan-poc/.env` (the app's API keys) and serve traffic on `api.sparsan.com`. Neither app code nor build code can reach the GCE metadata server (`IPAddressDeny=169.254.169.254`), so it cannot obtain the VM service account's tokens. The units also run with `ProtectSystem=strict` (only `/opt/loan-poc/data` is writable) and `RemoveIPC`. Build code also cannot reach loopback services (only the resolved DNS stub). **App code, however, can still reach other loopback services on this shared VM at the network level, for example the co-hosted site's backend port.** It needs loopback to talk to its mocks, and isolating that would need a network namespace. For production, run this app on its own VM (or container host) rather than next to another site. It cannot get a shell as `loandeploy`, run other root commands, touch the co-hosted site, change nginx/systemd/sudoers, or read other users' files beyond what `loanpoc` can. **Recovery** if the key leaks:
1. Rotate the key (below). This removes the key holder's only foothold, because no build-time process or cache survives a deploy.
2. Redeploy a known-good commit, which replaces the attacker's app code.
3. Rotate the secrets in `.env`, since attacker code running as `loanpoc` could have read them.

### Rotating the deploy key

```bash
ssh-keygen -t ed25519 -N '' -C 'loan-poc-ci' -f ~/.ssh/loan-poc-deploy-new
scripts/deploy.sh bootstrap --pubkey ~/.ssh/loan-poc-deploy-new.pub        # replaces authorized_keys (old key stops working)
gh secret set DEPLOY_SSH_KEY --repo $REPO --env production < ~/.ssh/loan-poc-deploy-new
mv ~/.ssh/loan-poc-deploy-new ~/.ssh/loan-poc-deploy && mv ~/.ssh/loan-poc-deploy-new.pub ~/.ssh/loan-poc-deploy.pub
```

If the VM's host key changes (re-created VM), update `DEPLOY_KNOWN_HOSTS` with the line bootstrap prints. Strict host-key checking will otherwise fail the deploy, as it should.

## 4. Repository variables and environment secrets

```bash
gh variable set DEPLOY_HOST --repo $REPO --body "$DEPLOY_HOST"
gh variable set API_BASE    --repo $REPO --body https://api.sparsan.com

# Environment secrets: readable only by jobs that run in `production` (main only). Never commit these files.
gh secret set DEPLOY_SSH_KEY     --repo $REPO --env production < ~/.ssh/loan-poc-deploy
gh secret set DEPLOY_KNOWN_HOSTS --repo $REPO --env production --body "<the line bootstrap printed>"
gh secret set CLOUDFLARE_API_TOKEN  --repo $REPO --env production   # paste the token (section 5)
gh secret set CLOUDFLARE_ACCOUNT_ID --repo $REPO --env production
```

In the workflow, the key is written with `umask 077` to the runner's temp directory, used with `StrictHostKeyChecking=yes` against the pinned known-hosts line, and deleted in an `always()` step.

## 5. Cloudflare: Pages project, API token, DNS

```bash
npx wrangler login
npx wrangler pages project create loan-poc --production-branch main
```

**API token.** Go to Cloudflare dashboard → My Profile → API Tokens → Create Custom Token, with:

- permissions: **Account → Cloudflare Pages → Edit**;
- account resources: only your account;
- no zone permissions;
- an optional TTL.

Store the token with `gh secret set` (section 4). The account ID is shown on the Workers & Pages overview page.

**Shared demo password.** One password gates the whole demo: it is `SITE_PASSWORD` on Cloudflare Pages (HTTP Basic Auth in `functions/_middleware.ts`, any username) and must equal `DEMO_ACCESS_CODE` in the VM's `.env` (the API checks it as the `X-Access-Code` header and on login). Set it once, before the first deploy that includes the functions:

```bash
npx wrangler pages secret put SITE_PASSWORD --project-name loan-poc   # paste the password at the prompt
# and on the VM: DEMO_ACCESS_CODE=<the same value> in /opt/loan-poc/.env, then restart the service
```

Without `SITE_PASSWORD` the site answers 503 (fail closed). Wrangler deploys `functions/` from the repository root, so run `pages deploy` from there (`scripts/deploy.sh web` and the workflow both do). **Rotation:** put the new value into both places (Pages secret, then redeploy so it takes effect; VM `.env`, then restart), and tell reviewers; the 12-hour `demo_access` cookie and old sessions stop working once the API restarts. For local checks of the functions, put `SITE_PASSWORD=...` in the git-ignored `.dev.vars` and run `npx wrangler pages dev apps/web/dist`.

**DNS** (zone `sparsan.com`):

| Record | Value | Proxy |
|---|---|---|
| `A api` | the VM's external IP: `gcloud compute instances describe $VM --project $PROJECT --zone $ZONE --format='value(networkInterfaces[0].accessConfigs[0].natIP)'` | DNS only (grey cloud): certbot issues the certificate on the VM and long-lived voice WebSockets are not cut by the proxy's idle timeout |
| optional custom web domain | Pages → `loan-poc` → Custom domains → add it (Cloudflare creates the CNAME) | proxied |

**TLS for the API.** Do this once, after bootstrap has installed the nginx site and the DNS record resolves:

```bash
scripts/deploy.sh cert --dry-run   # prints the root script that runs on the VM
scripts/deploy.sh cert
```

`cert` installs the HTTP nginx site (it serves `/.well-known/acme-challenge/` from `/var/www/letsencrypt`), runs `certbot certonly --webroot -w /var/www/letsencrypt -d api.sparsan.com --keep-until-expiring --deploy-hook "systemctl reload nginx"`, then re-installs the site as the TLS variant (443 with HSTS, 80 redirects to https), with `nginx -t` and restore-on-failure. The VM's certbot has no nginx plugin and already has an ACME account (from the co-hosted site), so no email flags are passed and the account is reused. `cert` assumes an existing ACME account (the VM has one); otherwise run certbot once on the VM with `--register-unsafely-without-email` or an email. Renewal is the existing `certbot.timer`; the stored webroot config and the deploy hook reload nginx. Re-running bootstrap later keeps the TLS variant because the certificate exists. To change proxy settings, edit `deploy/nginx-api.conf` and `deploy/nginx-api-tls.conf` together and re-run bootstrap.

## 6. First deploy and check

```bash
DEPLOY_HOST=$DEPLOY_HOST scripts/deploy.sh all --dry-run   # prints every step; changes nothing
# Local first deploy with the same key CI uses (pin the host key first):
echo "<the line bootstrap printed>" >> ~/.ssh/known_hosts
DEPLOY_HOST=$DEPLOY_HOST scripts/deploy.sh api
# then the TLS step in section 5, then:
curl -fsS https://api.sparsan.com/api/health                # {"ok":true}
scripts/deploy.sh web                                         # or push to main and let the workflow do both
```

From now on, a push to `main` runs `CI` and then `Deploy`:

1. **`api`**: deploy key → `deploy.sh api` (upload, activate with health check and rollback) → the public health check must return `"ok":true`.
2. **`web`**: `deploy.sh web-build` → `wrangler pages deploy`.

Pull requests run CI only; the deploy workflow has no PR trigger. To roll back by hand, use `gcloud compute ssh $VM … --command 'ls /opt/loan-poc/releases'`. Then re-run the deploy workflow on an older commit, or (as owner) repoint `current` and restart the units.
