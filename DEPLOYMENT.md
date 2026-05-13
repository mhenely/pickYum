# Deployment Guide

PickYum's deploy story is split:

- **Frontend** → AWS Amplify Hosting. Amplify watches the repo directly and rebuilds on every push to a tracked branch. GitHub Actions plays no role in frontend deploys — Amplify is its own CI/CD pipeline.
- **Backend** → AWS Amazon ECR (image registry) + AWS App Runner (compute). GitHub Actions (`.github/workflows/deploy.yml`) builds the Docker image, pushes to ECR, and triggers App Runner.

CI (tests + typecheck) runs in GitHub Actions on every push and PR — both Amplify and the backend deploy wait for CI to pass via branch protection.

---

## Part 1 — Frontend on AWS Amplify Hosting

### 1.1 Create the Amplify app

1. AWS Console → **Amplify** → "Create new app" → "Host web app".
2. Choose **GitHub** as the source and authorize AWS Amplify Hosting (it's a GitHub App that asks for access to specific repos — grant just this one).
3. Select the `pickYum` repo and the `main` branch.
4. Amplify auto-detects `amplify.yml` at the repo root and shows the build settings. Confirm them — no changes needed.
5. Click "Save and deploy". The first build takes ~3–5 minutes.

### 1.2 Configure environment variables

In the Amplify Console for this app → **Hosting → Environment variables** → "Manage variables". Add:

| Variable | Value | Notes |
|---|---|---|
| `VITE_API_BASE_URL` | `https://api.pickyum.com` (or your backend URL) | The Express server. **Must** match the CORS `CLIENT_URL` on the backend. |
| `VITE_SUPABASE_URL` | from Supabase project settings | For OAuth flows. |
| `VITE_SUPABASE_ANON_KEY` | from Supabase project settings | Safe to expose — it's a public anon key. |
| `VITE_SENTRY_DSN` | from Sentry web project | Optional. Leave blank to disable client error reporting. |
| `VITE_SENTRY_RELEASE` | `$AWS_COMMIT_ID` | Optional. Ties Sentry events to the deployed commit. |

After saving, **redeploy** — Amplify only bakes env vars in at build time, so existing builds won't pick them up. Use the "Redeploy this version" button on the build history page.

### 1.3 SPA rewrite rule (required)

React Router uses client-side routing. Without a rewrite rule, refreshing `/socials` returns 404 because Amplify looks for a literal `/socials` file in the build output. Fix:

1. Amplify Console → **Hosting → Rewrites and redirects** → "Manage rewrites".
2. Add a single rule:
   - **Source**: `</^[^.]+$|\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>`
   - **Target**: `/index.html`
   - **Type**: `200 (Rewrite)`
   - **Country code**: blank

This serves `index.html` for any request that isn't an asset, letting React Router resolve the path client-side.

### 1.4 Branch tracking

Amplify supports per-branch deploys out of the box:

- **`main`** → production environment (`pickyum.com` / Amplify-provided URL).
- **Feature branches matching `feature/*`** → PR previews with unique URLs. Enable via "Hosting → Build settings → Build settings" → toggle "Auto build" + "Auto deploy" for branches matching `feature/*`.
- **Pull request previews** (cross-fork) → enable "Branch auto-detection → Pull request previews". Each PR gets its own ephemeral deployment.

### 1.5 Custom domain (optional)

Hosting → Domain management → "Add domain". Either:
- Transfer DNS to Route 53 (Amplify wires everything automatically), or
- Keep DNS at your registrar and add the CNAME records Amplify shows you.

TLS certificates are issued automatically via ACM. Verification takes ~5 minutes.

### 1.6 Gate Amplify deploys on CI passing

Amplify doesn't have a built-in "wait for GitHub Actions" check, but you can achieve the same effect via **branch protection on main**:

1. GitHub → Settings → Branches → "Add branch protection rule" for `main`.
2. Enable **"Require status checks to pass before merging"** and tick the `CI` workflow checks (`backend (typecheck + Jest)` and `frontend (typecheck + Vitest)`).
3. Now PRs can't merge if CI fails — and since Amplify only deploys after merges to main, broken builds never reach production.

For pushes directly to main (rare on a protected branch), Amplify will still build. If you want to be paranoid, also turn off "Auto build" for main and trigger builds manually from the Amplify Console after CI passes — but that defeats the convenience of Amplify.

---

## Part 2 — Backend on AWS (ECR + App Runner)

### 2.1 One-time AWS setup

#### 2.1a — Create the ECR repository

```bash
aws ecr create-repository \
  --repository-name pickyum-server \
  --image-scanning-configuration scanOnPush=true \
  --region us-east-1
```

Note the URI it returns (`<account-id>.dkr.ecr.<region>.amazonaws.com/pickyum-server`).

#### 2.1b — Create the IAM role for GitHub OIDC

GitHub Actions uses OIDC to assume a role temporarily — no long-lived AWS keys stored as GitHub secrets. One-time setup:

1. **Create the OIDC provider** in AWS IAM (if you haven't already used GitHub OIDC):
   - IAM → Identity providers → "Add provider"
   - Provider type: **OpenID Connect**
   - Provider URL: `https://token.actions.githubusercontent.com`
   - Audience: `sts.amazonaws.com`

2. **Create the IAM role** that the workflow will assume:
   - IAM → Roles → "Create role" → "Web identity"
   - Identity provider: the one you just created
   - Audience: `sts.amazonaws.com`
   - GitHub organization: `<your-username-or-org>`
   - GitHub repository: `pickYum` (or whatever the repo is named)
   - Branch: leave blank to trust any branch, or restrict to `main`
   - Permissions: attach a custom policy with the actions needed (example below).
   - Name it `github-actions-pickyum-deploy`.

3. **The trust policy** AWS generates is fine, but verify it looks like this:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Federated": "arn:aws:iam::<your-account-id>:oidc-provider/token.actions.githubusercontent.com"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
           },
           "StringLike": {
             "token.actions.githubusercontent.com:sub": "repo:<your-github-org>/pickYum:*"
           }
         }
       }
     ]
   }
   ```

4. **Permissions policy** for the role — minimum required actions:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "ECRPush",
         "Effect": "Allow",
         "Action": [
           "ecr:GetAuthorizationToken",
           "ecr:BatchCheckLayerAvailability",
           "ecr:InitiateLayerUpload",
           "ecr:UploadLayerPart",
           "ecr:CompleteLayerUpload",
           "ecr:PutImage"
         ],
         "Resource": "*"
       },
       {
         "Sid": "AppRunnerDeploy",
         "Effect": "Allow",
         "Action": ["apprunner:StartDeployment", "apprunner:DescribeService"],
         "Resource": "arn:aws:apprunner:*:<your-account-id>:service/pickyum-server-*/*"
       }
     ]
   }
   ```

5. **Note the role ARN** — you'll set it as a GitHub secret.

#### 2.1c — Create the App Runner service

In the AWS Console, App Runner → "Create service":
- **Source**: Container registry → Amazon ECR
- **Provider**: Browse → select `pickyum-server` → choose tag `latest`
- **Deployment trigger**: Manual (we trigger via the workflow)
- **ECR access role**: Let App Runner create one
- **Service config**:
  - Name: `pickyum-server-staging` (and a separate `pickyum-server-production` for prod)
  - vCPU: `0.25` / Memory: `0.5 GB` for staging; bump for prod
  - Port: `3000`
  - Environment variables: paste in everything from `server/.env.example` (real values per environment — different `DATABASE_URL`, `JWT_SECRET`, `RESEND_API_KEY`, etc. for staging vs prod)
  - Health check path: `/api/health`
  - Auto-scaling: defaults (1 min instance, scales out under load)
- **Networking**: VPC connector if you want Redis/RDS in a private VPC; public access otherwise.

Note the **Service ARN** App Runner displays after creation — you'll need it for the GitHub secret.

### 2.2 GitHub secrets and variables

Repo → Settings → Secrets and variables → Actions.

#### Secrets (under "Secrets" tab)

| Secret | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | The role ARN from step 2.1b. |
| `AWS_DEPLOY_ROLE_ARN_PRODUCTION` | A separate role with prod-only permissions (or same as above if you trust GitHub Environments to gate access). |
| `APP_RUNNER_SERVICE_ARN_STAGING` | ARN from staging service in step 2.1c. |
| `APP_RUNNER_SERVICE_ARN_PRODUCTION` | ARN from production service. |

#### Variables (under "Variables" tab — non-sensitive flags)

| Variable | Value |
|---|---|
| `AWS_REGION` | e.g. `us-east-1` |
| `APP_RUNNER_ENABLED` | `true` |
| `STAGING_BACKEND_URL` | e.g. `https://api-staging.pickyum.com` |
| `PRODUCTION_BACKEND_URL` | e.g. `https://api.pickyum.com` |

### 2.3 Production approval gate

Repo → Settings → Environments → "New environment" → `production`.
- **Required reviewers**: add yourself.
- **Deployment branches**: restrict to `main`.

The `deploy-production` job in `deploy.yml` references this environment — GitHub will pause for your manual approval before running it.

### 2.4 First deploy

1. Push something to main → CI runs.
2. After CI passes, the deploy workflow auto-runs: builds image, pushes to ECR, calls `aws apprunner start-deployment` on staging.
3. Watch the App Runner service in the AWS Console — it pulls the new image and rolls over in ~3–5 minutes.
4. Hit `https://api-staging.pickyum.com/api/health/ready` — should return `{"status":"ready","checks":...}`.
5. To promote to production: Actions tab → "Backend Deploy" → "Run workflow" → choose `main`. The workflow pauses at the production job for your approval click.

---

## Part 3 — Operations

### Health checks

- App Runner pings `/api/health` (liveness) every 5s by default. Configure under Service settings → Health check.
- For external uptime monitoring (UptimeRobot / BetterStack), point at `/api/health/ready` so checks fail when DB/Redis are down — not just when the process is up.

### Logs

- Amplify Console → Hosting → Build history shows build/deploy logs for the frontend.
- App Runner Console → Service → Logs streams the Pino JSON logs from the backend (CloudWatch Logs under the hood).
- For aggregation, point CloudWatch Logs to a destination of your choice (Datadog, Logtail, etc.) via subscription filters.

### Rollbacks

- **Frontend**: Amplify keeps every build artifact. Hosting → Build history → "Redeploy this version" on any prior build.
- **Backend**: App Runner Console → Service → Activity → "Roll back" or manually re-run a prior `start-deployment` with `--source-configuration` pointing at an older image tag.

### Cost ballparks (May 2026)

- **Amplify Hosting**: ~$0.01/build minute + $0.15/GB served. A typical solo-project month: $1–5.
- **ECR**: $0.10/GB/month stored. ~$0.50/month for a few image versions.
- **App Runner**: ~$0.064/vCPU-hour + $0.007/GB-hour memory. Smallest (0.25 vCPU / 0.5 GB) running 24/7 ≈ $13/month.
- **Data egress**: usually negligible for an app like this.

Total: ~$15–25/month at low traffic. Cheaper than Vercel + Fly equivalent.

---

## Quick reference

| Concern | Where it lives |
|---|---|
| Frontend build spec | `amplify.yml` (this repo, root) |
| Frontend env vars | Amplify Console → Environment variables |
| Frontend rewrites | Amplify Console → Rewrites and redirects |
| Backend Dockerfile | `server/Dockerfile` |
| Backend deploy workflow | `.github/workflows/deploy.yml` |
| Backend env vars | App Runner service config (per environment) |
| CI (tests + typecheck) | `.github/workflows/ci.yml` |
| Branch protection | GitHub → Settings → Branches |
| Production approval gate | GitHub → Settings → Environments → production |
