# One-time setup: repository, GCP, Cloudflare, VM

This is the bootstrap that runs once before `.github/workflows/deploy.yml` can deploy. Every step is a command to run by hand, in order. Nothing here runs automatically. After this, a push to `main` runs CI and then deploys:

- the **API**: `scripts/deploy.sh api` uploads a release to the VM, runs `npm ci --omit=dev`, installs the systemd units and the nginx site, restarts and health-checks;
- the **web app**: Cloudflare Pages.

Fixed names used below:

| What | Value |
|---|---|
| Repository | `RiskyAV/agentic-ivr` (public; only the owner pushes) |
| GCP project / zone / VM | `GCP_PROJECT` / `VM_ZONE` / `VM_NAME` |
| API domain | `api.sparsan.com` → nginx on the VM → `127.0.0.1:4000` |
| Pages project | `loan-poc` (production branch `main`) |
| VM paths | `/opt/loan-poc/{releases,current,data,.env}`, service user `loanpoc` |

The VM already serves another site (`cohost`, port 3000). Nothing here or in `deploy.sh` edits that site or uses that port. Our files are:

- `/etc/nginx/sites-{available,enabled}/loan-poc-api.conf`;
- `/etc/systemd/system/loan-{api,mocks}.service`;
- everything under `/opt/loan-poc`.

```bash
# Shell variables used throughout
export PROJECT=GCP_PROJECT ZONE=VM_ZONE VM=VM_NAME
export REPO=RiskyAV/agentic-ivr
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
export SA_NAME=loan-poc-deployer
export SA=$SA_NAME@$PROJECT.iam.gserviceaccount.com
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

# Allowed actions: GitHub-owned, verified creators, plus the two deploy actions by name.
gh api -X PUT repos/$REPO/actions/permissions -F enabled=true -f allowed_actions=selected
gh api -X PUT repos/$REPO/actions/permissions/selected-actions \
  -F github_owned_allowed=true -F verified_allowed=true \
  -f 'patterns_allowed[]=google-github-actions/auth@*' \
  -f 'patterns_allowed[]=google-github-actions/setup-gcloud@*' \
  -f 'patterns_allowed[]=cloudflare/wrangler-action@*'

# Dependabot alerts, secret scanning and push protection
gh api -X PUT repos/$REPO/vulnerability-alerts
gh api -X PATCH repos/$REPO \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
```

**Pinning trade-off.** The workflows pin actions by major version (`@v4`, `@v2`, `@v3`), and the allow-list above restricts who can publish them. Pinning by commit SHA (`uses: owner/action@<40-hex>`) is stronger: a moved tag cannot change what runs. The cost is that updates become manual, or need Dependabot for `github-actions`. For a public repo whose deploy job holds cloud credentials, SHA pinning is the better default once the workflows are stable. To switch, replace each `@vN` with the SHA that the tag points at today.

### The `production` environment

Both deploy jobs run in the `production` environment. Limit it to `main`, and optionally require the owner's approval for each deploy:

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

Drop the `reviewers` entry to deploy without an approval click.

## 3. GCP: deploy service account and Workload Identity Federation

GitHub Actions authenticates with short-lived OIDC tokens. There is no JSON key anywhere.

```bash
gcloud iam service-accounts create $SA_NAME --project $PROJECT --display-name "loan-poc GitHub deploy"

gcloud iam workload-identity-pools create github --project $PROJECT --location global \
  --display-name "GitHub Actions"

# Only pushes to main (or a manual run on main) of this exact repository can mint a token.
gcloud iam workload-identity-pools providers create-oidc agentic-ivr --project $PROJECT \
  --location global --workload-identity-pool github \
  --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name" \
  --attribute-condition "assertion.repository == '$REPO' && assertion.ref == 'refs/heads/main' && (assertion.event_name == 'push' || assertion.event_name == 'workflow_dispatch')"

# Bind the SA to a single principal: jobs of this repo running in the `production` environment
# (GitHub's subject claim for such jobs is repo:<owner>/<repo>:environment:production).
gcloud iam service-accounts add-iam-policy-binding $SA --project $PROJECT \
  --role roles/iam.workloadIdentityUser \
  --member "principal://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/subject/repo:$REPO:environment:production"
```

You can also pin the repository ID, so that a deleted and re-created repository with the same name cannot match. Get it with `gh api repos/$REPO --jq .id`, then add `&& assertion.repository_id == '<id>'` to the condition.

### Roles: the minimum for `gcloud compute scp/ssh` plus `sudo` on one VM

Pick the variant that matches how the VM accepts SSH today. Do not change its SSH mode just for this, because the other site's operators use it too.

**A. Metadata SSH keys (OS Login off). This is the usual case.** `gcloud compute ssh` adds the SA's key to the instance metadata. The guest agent then creates the user with sudo.

```bash
# Instance-scoped: get the instance and set its metadata
gcloud compute instances add-iam-policy-binding $VM --project $PROJECT --zone $ZONE \
  --member serviceAccount:$SA --role roles/compute.instanceAdmin.v1

# Project-level reads that gcloud needs (project metadata check, operation polling): a tiny custom role
gcloud iam roles create loanPocDeployOps --project $PROJECT --title "loan-poc deploy ops" \
  --permissions compute.projects.get,compute.zoneOperations.get
gcloud projects add-iam-policy-binding $PROJECT \
  --member serviceAccount:$SA --role projects/$PROJECT/roles/loanPocDeployOps

# Setting metadata on a VM that runs as a service account requires actAs on that account
VM_SA=$(gcloud compute instances describe $VM --project $PROJECT --zone $ZONE --format='value(serviceAccounts[0].email)')
gcloud iam service-accounts add-iam-policy-binding $VM_SA --project $PROJECT \
  --member serviceAccount:$SA --role roles/iam.serviceAccountUser
```

**B. OS Login (only if `enable-oslogin=TRUE` is already set on the VM or the project).**

```bash
gcloud compute instances add-iam-policy-binding $VM --project $PROJECT --zone $ZONE \
  --member serviceAccount:$SA --role roles/compute.osAdminLogin
gcloud iam service-accounts add-iam-policy-binding $VM_SA --project $PROJECT \
  --member serviceAccount:$SA --role roles/iam.serviceAccountUser
# plus the loanPocDeployOps custom role above, and compute.instances.get via roles/compute.viewer on the instance
```

**SSH path.** If the VM's port 22 is closed to the internet, use IAP, which is preferred:

1. Allow Google's IAP range to reach port 22.
2. Grant the tunnel role on this instance only.
3. Set the repo variable `GCP_USE_IAP=1` (section 5).

```bash
gcloud compute firewall-rules create allow-iap-ssh-loan-poc --project $PROJECT \
  --network default --direction INGRESS --action allow --rules tcp:22 \
  --source-ranges 35.235.240.0/20 --target-tags "$(gcloud compute instances describe $VM --project $PROJECT --zone $ZONE --format='value(tags.items[0])')"
gcloud compute instances add-iam-policy-binding $VM --project $PROJECT --zone $ZONE \
  --member serviceAccount:$SA --role roles/iap.tunnelResourceAccessor
```

Without IAP, GitHub's runners connect to the VM's external IP on port 22. That works only if an existing firewall rule already allows it (for example `default-allow-ssh`).

Check the grants with a dry run from a shell that impersonates the SA. This is optional, and it needs `roles/iam.serviceAccountTokenCreator` on yourself:

```bash
gcloud compute ssh $VM --project $PROJECT --zone $ZONE --impersonate-service-account $SA --command 'sudo -n true && echo sudo-ok'
```

## 4. First-time VM prep

```bash
# Node 22+ must be installed system-wide (/usr/bin/node or /usr/local/bin/node), so the service user can run it
gcloud compute ssh $VM --project $PROJECT --zone $ZONE --command 'node -v; command -v node; nginx -v; ls /etc/nginx/sites-enabled'

# Service user and app directory (deploy.sh also does this idempotently)
gcloud compute ssh $VM --project $PROJECT --zone $ZONE --command \
  'id -u loanpoc >/dev/null 2>&1 || sudo useradd --system --home-dir /opt/loan-poc --no-create-home --shell /usr/sbin/nologin loanpoc; sudo install -d -m 755 /opt/loan-poc'
```

**The app `.env` lives only on the VM.** No workflow ever writes it. Prepare it on the laptop from `.env.example`. `.env.*` is git-ignored, so this file cannot be committed.

```bash
cp .env.example .env.production
# Edit .env.production:
#   GEMINI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID   real keys
#   LLM_PROVIDER=gemini
#   SESSION_SECRET=<output of: openssl rand -hex 32>         sessions survive restarts
#   DEMO_ACCESS_CODE=<a code you share with reviewers>       gates login and chaos changes
#   WEB_ORIGIN=https://loan-poc.pages.dev[,https://<web domain>]   CORS for the Pages site
#   MAX_VOICE_SESSIONS=5
# Do NOT set TEST_HOOKS (refused in production), HOST, TRUST_PROXY or EVENT_LOG_DIR (the systemd unit sets those;
# values in the env file would override them).

gcloud compute scp .env.production $VM:/tmp/loan-poc.env --project $PROJECT --zone $ZONE
gcloud compute ssh $VM --project $PROJECT --zone $ZONE --command \
  'sudo install -o root -g loanpoc -m 640 /tmp/loan-poc.env /opt/loan-poc/.env && rm -f /tmp/loan-poc.env'
rm .env.production    # or keep it in a password manager
```

To rotate a key later, edit `/opt/loan-poc/.env` on the VM, then run `sudo systemctl restart loan-api loan-mocks`.

## 5. Repository variables and secrets

```bash
gh variable set GCP_WIF_PROVIDER --repo $REPO \
  --body "projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/agentic-ivr"
gh variable set GCP_DEPLOY_SA --repo $REPO --body "$SA"
gh variable set GCP_USE_IAP   --repo $REPO --body 0          # 1 if you set up IAP in section 3
gh variable set API_BASE      --repo $REPO --body https://api.sparsan.com

# Cloudflare credentials as environment secrets: only jobs in `production` can read them
gh secret set CLOUDFLARE_API_TOKEN  --repo $REPO --env production   # paste the token (section 6)
gh secret set CLOUDFLARE_ACCOUNT_ID --repo $REPO --env production
```

## 6. Cloudflare: Pages project, API token, DNS

```bash
npx wrangler login
npx wrangler pages project create loan-poc --production-branch main
```

**API token.** Go to Cloudflare dashboard → My Profile → API Tokens → Create Custom Token, with:

- permissions: **Account → Cloudflare Pages → Edit**;
- account resources: only your account;
- no zone permissions;
- an optional TTL.

Store the token with `gh secret set` (section 5). The account ID is shown on the Workers & Pages overview page.

**DNS** (zone `sparsan.com`):

| Record | Value | Proxy |
|---|---|---|
| `A api` | the VM's external IP: `gcloud compute instances describe $VM --project $PROJECT --zone $ZONE --format='value(networkInterfaces[0].accessConfigs[0].natIP)'` | DNS only (grey cloud): certbot issues the certificate on the VM and long-lived voice WebSockets are not cut by the proxy's idle timeout |
| optional custom web domain | Pages → `loan-poc` → Custom domains → add it (Cloudflare creates the CNAME) | proxied |

**TLS for the API.** Do this once, after the first API deploy has installed the nginx site:

```bash
gcloud compute ssh $VM --project $PROJECT --zone $ZONE --command 'sudo certbot --nginx -d api.sparsan.com --redirect'
```

certbot edits `loan-poc-api.conf` to add the 443 server block. From then on `deploy.sh` sees "managed by Certbot" and leaves that file alone. To change the proxy settings later, edit the file on the VM, then run `nginx -t && systemctl reload nginx`.

## 7. First deploy and check

```bash
scripts/deploy.sh all --dry-run   # prints every step and the remote script; changes nothing
scripts/deploy.sh api             # first API deploy from the laptop (your own gcloud login)
# then section 6 TLS, then:
curl -fsS https://api.sparsan.com/api/health
scripts/deploy.sh web             # or push to main and let the workflow do both
```

From now on, a push to `main` runs `CI` and then `Deploy`: `api` (WIF → `deploy.sh api` → public health check), then `web` (`deploy.sh web-build` → `wrangler pages deploy`). Pull requests run CI only; the deploy workflow has no PR trigger.
