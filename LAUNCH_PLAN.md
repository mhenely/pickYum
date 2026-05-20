# PickYum Launch Plan

A phased plan for taking PickYum from dev-ready to live in production. Last updated 2026-05-19.

This document tracks the work needed to ship PickYum publicly. It does **not** duplicate deployment mechanics — for the "how" of building/deploying, see [DEPLOYMENT.md](DEPLOYMENT.md). This file focuses on the **what** and **why**: phase status, key decisions, and what's blocking what.

## Locked-in infrastructure decisions

These were settled during planning and are the basis for the rest of this doc. If any change, update this file + [DEPLOYMENT.md](DEPLOYMENT.md) in lockstep.

| Concern | Choice |
|---|---|
| Frontend domain | `pick-yum.com` |
| Backend domain | `api.pick-yum.com` |
| Frontend hosting | AWS Amplify |
| Backend hosting | AWS ECS Express Mode (replacing App Runner, which closed to new customers in late 2025) |
| DNS | Cloudflare (moved from Route 53 to enable Email Routing) |
| Database | Supabase Postgres |
| Redis | Upstash (planned) |
| Transactional email | Resend (sending from `noreply@pick-yum.com`) |
| Inbound email | Cloudflare Email Routing (`contact@pick-yum.com` forwarded) |
| Error reporting | Sentry (separate projects: frontend + backend) |
| Jurisdiction (Terms) | State of Oregon, USA |

## Phase 1 — Code blockers ✅ DONE

Pure code changes that had no external dependencies.

- [x] `API_URL` startup validation — promoted to required-in-prod in [server/src/lib/validateEnv.ts](server/src/lib/validateEnv.ts); silent OAuth fallback to localhost is no longer possible
- [x] `GOOGLE_PLACES_API_KEY` promoted to required-in-prod (was warn-only)
- [x] `avatarUpdateLimiter` added ([server/src/middleware/rateLimits.ts](server/src/middleware/rateLimits.ts)) — 20 uploads/hour per user, keyed by userId so shared NATs don't cross-pollute
- [x] 14 new tests covering all three changes
- [x] Found + fixed a real prod bug along the way: route-local `express.json({ limit: '200kb' })` was dead code because the global 32KB parser ran first; reordered in [app.ts](server/src/app.ts)

## Phase 2 — Content & legal ✅ DONE

- [x] [PrivacyPage.jsx](src/routes/PrivacyPage.jsx) — `[your contact email]` → `contact@pick-yum.com` (mailto link)
- [x] [TermsPage.jsx](src/routes/TermsPage.jsx) — `[your jurisdiction]` → `the State of Oregon, USA`
- [x] [TermsPage.jsx](src/routes/TermsPage.jsx) — `[your contact email]` → `contact@pick-yum.com` (mailto link)
- [x] Removed self-undermining disclaimer banners from both pages (text that said "replace this with a lawyer-reviewed version" was admitting inadequacy publicly)
- [x] Bumped "Last updated" dates to 2026-05-19

Optional follow-up: lawyer review of the actual privacy/terms text. The text is reasonable for a small launching app but isn't legally vetted.

## Phase 3 — External infrastructure 🟡 IN PROGRESS (user-side)

These are dashboard / DNS tasks, not code. Roughly in dependency order:

### 3a. DNS migration: Route 53 → Cloudflare
1. Sign up for Cloudflare (free tier)
2. Add `pick-yum.com` as a site — Cloudflare auto-imports existing Route 53 records
3. Copy Cloudflare's nameservers
4. AWS Console → Registered Domains → swap nameservers from Route 53 to Cloudflare's
5. Wait 1–4h for propagation (`dig NS pick-yum.com` to verify)

### 3b. Cloudflare Email Routing
1. Cloudflare → Email → Email Routing → Enable
2. Add rule: `contact@pick-yum.com` → your existing inbox
3. Confirm destination via the confirmation email Cloudflare sends

### 3c. Resend (transactional email)
1. Sign up for Resend
2. Add `pick-yum.com` as a verified domain
3. Add the SPF/DKIM/DMARC records Resend provides to Cloudflare DNS
4. Wait for verification (~1h)
5. Generate a production API key; save as `RESEND_API_KEY`

### 3d. ECS Express Mode backend
1. Push the existing Docker image to ECR (GitHub Actions workflow already does this)
2. Create an ECS Express service pointing at the ECR image
3. Set all required env vars (see [DEPLOYMENT.md § 2.0](DEPLOYMENT.md))
4. Wire `/api/health/ready` as the health check path
5. Add custom domain `api.pick-yum.com` (Route 53 alias or Cloudflare-proxied CNAME)
6. Provision an ACM certificate for `api.pick-yum.com` (or use Cloudflare's edge TLS)

### 3e. Redis (Upstash)
1. Create an Upstash database (Redis-compatible, free tier covers low traffic)
2. Copy the connection URL
3. Set `REDIS_URL` in the ECS Express service env

### 3f. Amplify (frontend)
1. Amplify Console → connect to GitHub repo
2. Add `pick-yum.com` as the production domain (DNS records get added in Cloudflare manually since DNS lives there)
3. Set `VITE_API_BASE_URL=https://api.pick-yum.com` and other `VITE_*` env vars

### 3g. OAuth provider consoles
- **Google Cloud Console** → OAuth 2.0 Client → Authorized redirect URIs:
  - `https://api.pick-yum.com/api/auth/google/callback`
- **Facebook Developer Portal** → Facebook Login → Valid OAuth Redirect URIs:
  - `https://api.pick-yum.com/api/auth/facebook/callback`
- **Supabase** (if using Supabase OAuth) → Authentication → URL Configuration:
  - `https://pick-yum.com/auth/callback`

### 3h. Sentry
1. Create a Sentry project for the backend → get DSN → set `SENTRY_DSN`
2. Create a separate project for the frontend → get DSN → set `VITE_SENTRY_DSN`

### 3i. Google Cloud / Maps key hardening
- Confirm the Places API key (server) is restricted to Places API + backend IPs (if static IPs are available)
- Confirm the Maps JS key (`VITE_GOOGLE_MAPS_API_KEY`) is restricted to Maps JS API + HTTP referrer `https://pick-yum.com/*`
- Set billing alerts in Google Cloud so unexpected spend doesn't compound

## Phase 4 — Deploy & verify ⏳ BLOCKED on Phase 3

In dependency order:

1. **Staging deploy first** — set up a `pickyum-server-staging` ECS service alongside production; same infra shape, separate env vars
2. **Smoke-test critical paths in staging:**
   - Register → receive verification email → click link → `emailVerified` flips
   - Forgot password → receive email → reset → sign in works
   - Google OAuth login end-to-end
   - Facebook OAuth login end-to-end
   - Create group → invite second account → vote → confirm real-time SSE update
   - Upload avatar → persists + renders in navbar
   - Export data (`/danger zone` on profile) → confirm download is well-formed JSON
3. **Verify `/api/health/ready` returns 200** with both DB + Redis green
4. **Backup restore dry-run** — pick a Supabase backup, restore to a temp project, verify data integrity. Document the runbook
5. **Wire `/api/health/ready` into ECS health check config** so unhealthy instances get pulled from rotation
6. **Production deploy** — promote staging → prod once smoke tests pass

## Phase 5 — Post-launch polish 🟡 PARTIAL

- [x] **Bundle analyzer** — `npm run build:analyze` produces `dist/stats.html` (gzip + brotli treemap). Opt-in via `ANALYZE=1` env so normal builds and CI stay fast
- [x] **DEPLOYMENT.md updated** for new env validation rules + flagged ECS Express migration points with `[ECS Express: TODO]` markers
- [ ] **PWA manifest** — deferred, needs real icon assets (192×192 + 512×512 PNGs). Adding it pointing at the placeholder `vite.svg` would render badly on home screens
- [ ] **Connection pool tuning** — deferred until prod traffic data exists. Tweak `?connection_limit=N` on `DATABASE_URL` once you see pool exhaustion in logs
- [ ] **Sentry alerts** — needs Sentry accounts provisioned first (Phase 3h). Then wire alerts to email / Slack / PagerDuty
- [ ] **Avatar storage migration** — current data-URL approach is fine until `User` rows bloat measurably. Migration path: Supabase Storage / S3, replace data URL with a URL string
- [ ] **Cookie banner** — only needed if analytics with tracking cookies are added later

## Test coverage at launch

- Server: **478 tests** across 19 suites
- Frontend: **184 tests** across 18 files
- Critical paths verified by tests: auth (login, register, reset, verify), groups, trips, sessions/voting (simple + ranked), recommendations, social graph, restaurants, places, health, notifications stream, email lib, eventLifecycle, validateEnv

## Notes for resuming this work

- **Phase state changes over time** — verify against the actual repo (`git log`, `DEPLOYMENT.md`) before assuming any checkbox is still current
- **Phase 3 has the longest wall-clock path** because of DNS propagation (1–4h) and Resend domain verification (~1h)
- **None of the Phase 3 substeps depend on each other except DNS migration** (3a) which must come first — everything else can happen in parallel once Cloudflare is the nameserver
- **Phase 5 deferred items aren't launch blockers** — they're things to revisit once you have traffic and signal
