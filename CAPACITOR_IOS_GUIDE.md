# Capacitor iOS shipping guide

Reference for wrapping pickYum's React SPA in a Capacitor native shell
and shipping it to the App Store, in the order you'd actually do it.

**Current status: deferred.** We're running as a PWA today (manifest +
service worker + push opt-in, Phase G + the install-prompt component).
Pick this up when the PWA install funnel proves to be the conversion
ceiling — i.e. when iOS reach is the limiting factor, not marketing.

**Estimated effort**: 4–6 focused engineering days for iOS-only MVP +
2–4 weeks calendar including Apple's review queue. Plus an ongoing
maintenance tax: every release becomes "build, sign, submit, wait."

**Hard costs**:
- Apple Developer Program: $99/year (required)
- Google Play (if Android too): $25 one-time
- macOS for builds: free if you have a Mac; GitHub Actions has macOS
  runners but they're billed at ~10× Linux minutes

---

## 0. Decide what you're solving

Before doing any of this, write down what success looks like. Common
reasons to wrap a web app:

- **iOS reach**: web push only works on iOS 16.4+ AFTER the user
  installs the PWA via Share → Add to Home Screen. Native bypasses
  that. If your bottleneck is iOS users not installing, this fixes it.
- **App Store discoverability**: "is pickYum in the App Store?" is a
  real trust signal for some users.
- **Native APIs we'd use**: today nothing — search, vote, etc. are all
  pure web. If you want camera (review photos?), background location,
  share extensions, the WebView alone can't do it.

If the answer is just "we want to be in the App Store," the PWA
install prompt covers iOS 16.4+ for free. Capacitor is right when web
push doesn't reach enough iOS users to matter.

---

## 1. Capacitor setup (½ day)

```bash
npm install @capacitor/core @capacitor/cli @capacitor/ios
npx cap init pickYum com.pickyum.app
npx cap add ios
```

This creates:
- `capacitor.config.ts` at the repo root
- `ios/` — an Xcode project. **Commit it.** Capacitor regenerates
  from config but tracks the project for native-side customization.

Configure `capacitor.config.ts`:

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pickyum.app',
  appName: 'pickYum',
  // Vite outputs to dist/ — Capacitor bundles whatever's here into
  // the native shell as the app's "web root."
  webDir: 'dist',
  // BUNDLE the built SPA inside the app (don't remote-load
  // https://pickyum.com). App Store reviewers reject apps that are
  // 100% remote-loaded web content — they want a real native app.
  // Bundling also gives offline support for the shell.
  server: {
    // androidScheme: 'https' fixes a Capacitor 5+ default that
    // breaks credentials-include fetches on Android. iOS unaffected.
    androidScheme: 'https',
  },
};
export default config;
```

After every web build:

```bash
npm run build          # vite build → dist/
npx cap copy ios       # copies dist/ into ios/App/App/public/
npx cap sync ios       # also updates native dependencies if changed
```

Add this to a wrapper script so you don't forget:

```json
// package.json
{
  "scripts": {
    "build:ios": "npm run build && npx cap copy ios && npx cap sync ios"
  }
}
```

---

## 2. iOS-specific polish (1–2 days)

### App icon + launch screen

- **Icon**: 1024×1024 PNG (no transparency, no rounded corners — iOS
  rounds them). Drop in `ios/App/App/Assets.xcassets/AppIcon.appiconset/`.
  Easier: use Xcode's "App Icon" asset catalog drag-and-drop.
- **Launch screen**: edit
  `ios/App/App/Base.lproj/LaunchScreen.storyboard` in Xcode. Keep it
  branded but boring — a centered logo on the brand background. App
  Store rejects launch screens that look like "loading" UI.

### Permissions in `Info.plist`

Located at `ios/App/App/Info.plist`. Add a `*UsageDescription` entry
for every capability you request:

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>pickYum uses your location to find nearby restaurants for tonight's pick.</string>
<key>NSCameraUsageDescription</key>
<string>pickYum uses your camera to attach photos to restaurant reviews.</string>
```

Skip permissions you don't actually use — Apple rejects unused
permission entries.

### Safe areas + keyboard

Add CSS handling for iPhone X+ notch + home indicator. In
`src/index.css` (or wherever global styles live):

```css
body {
  /* env() resolves to 0 on devices without inset; safe to use
     everywhere. */
  padding-top:    env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
}
```

For inputs that get covered by the soft keyboard, install
`@capacitor/keyboard`:

```bash
npm install @capacitor/keyboard
npx cap sync ios
```

Then in your global init:

```ts
import { Keyboard } from '@capacitor/keyboard';
Keyboard.setAccessoryBarVisible({ isVisible: true });
// Optional: adjust the viewport so inputs scroll into view
Keyboard.setResizeMode({ mode: 'native' });
```

### External links — open in Safari, not in-app

Phase A's OpenTable / DoorDash / Uber Eats deep-links should open in
Safari, not inside the WebView (or the user gets trapped in our app
with no back affordance):

```bash
npm install @capacitor/browser
```

```ts
import { Browser } from '@capacitor/browser';
// Replace existing `<a href target="_blank">` patterns:
await Browser.open({ url: 'https://www.opentable.com/...' });
```

We have `src/components/ExternalActions.jsx` doing the OpenTable etc.
links — swap the `<a>` to onClick handlers that detect native
(Capacitor.isNativePlatform()) and use the Browser plugin there.

---

## 3. Native push via APNs (1–2 days)

The web push from Phase G **doesn't translate to native**. Service
workers don't run inside Capacitor's WebView. You need a parallel
APNs (Apple Push Notification service) integration.

### Apple Developer setup

1. Apple Developer portal → **Keys** → create an **APNs Auth Key**.
   Download the `.p8` file ONCE (Apple won't show it again). Record
   the Key ID and your Team ID.
2. **Identifiers** → your App ID → enable **Push Notifications**
   capability.
3. **Profiles** → regenerate the provisioning profile for your app
   (push capability changes invalidate it).

### Frontend

```bash
npm install @capacitor/push-notifications
npx cap sync ios
```

```ts
import { PushNotifications } from '@capacitor/push-notifications';
import { Capacitor } from '@capacitor/core';

export async function registerNativePush() {
  if (!Capacitor.isNativePlatform()) return;

  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== 'granted') return;

  // Triggers the OS handshake. The 'registration' event fires with
  // the APNs device token, which we POST to our backend.
  await PushNotifications.register();

  PushNotifications.addListener('registration', async (token) => {
    await fetch(`${API}/api/notifications/native-subscriptions`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceToken: token.value, platform: 'ios' }),
    });
  });

  PushNotifications.addListener('pushNotificationReceived', (n) => {
    // Foreground notification — show in-app or rely on OS banner
  });

  PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
    // User tapped a notification; navigate to the URL the payload
    // carried (mirror the service worker's notificationclick logic).
  });
}
```

Call `registerNativePush()` from `App.tsx` after auth. On web, it's
a no-op via `Capacitor.isNativePlatform()`.

### Backend

Two options:

**Option A: Add APNs alongside web push.** Existing `lib/webPush.ts`
stays; add `lib/apns.ts` using `@parse/node-apn` or similar.
Update `lib/userNotifications.ts` `notifyUser()` to fan out to
BOTH (call `sendWebPushToUser` and `sendApnsToUser` in parallel).
Each user has 0..n web subscriptions + 0..n native device tokens.

**Option B: Unify on Firebase Cloud Messaging (FCM).** Replace the
direct web-push + APNs split with FCM. FCM relays to APNs for iOS
and the browser push service for web. Single backend integration,
one frontend SDK. Bigger up-front rewrite; simpler long-term.

Recommend Option A for an MVP — less moving parts, additive instead
of replacing working code.

### Schema

Add a sibling to `PushSubscription`:

```prisma
model NativePushSubscription {
  id           Int      @id @default(autoincrement())
  userId       Int      @map("user_id")
  // APNs token (64-hex chars) or FCM token (longer). VARCHAR(256)
  // covers both with margin.
  deviceToken  String   @unique @db.VarChar(256)
  platform     String   @db.VarChar(16)  // 'ios' | 'android'
  createdAt    DateTime @default(now()) @map("created_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("native_push_subscription")
}
```

Mirror the 410-cleanup pattern from `webPush.ts` — APNs has its own
"bad device token" signal (per-token rejection in the response).

### Env vars

```
APNS_KEY_ID=ABC123XYZ
APNS_TEAM_ID=DEF456WXY
APNS_BUNDLE_ID=com.pickyum.app
APNS_KEY_PATH=/etc/secrets/AuthKey_ABC123XYZ.p8
APNS_ENV=production  # or 'sandbox' for dev builds
```

The `.p8` key needs to live on the App Runner instance — store as a
file via the secret manager or inline as `APNS_KEY_CONTENTS` env var
that the lib writes to a temp file at boot.

---

## 4. Auth + SSE verification (½ day)

Two integration points where WebView can surprise you:

### Auth (JWT in httpOnly cookies)

WKWebView (iOS) supports cookies but with quirks. Verify:
- Login sets the cookie (check via Safari Web Inspector connected to
  the iOS Simulator)
- `credentials: 'include'` fetches send the cookie
- Cookie survives app backgrounding + reopen

If cookies misbehave, fall back to bearer tokens:
- Backend: accept `Authorization: Bearer <jwt>` alongside the cookie
- Frontend: store JWT in `@capacitor/preferences` (persistent across
  app launches), inject as Authorization header on every authed fetch
- Costs ~1 day of work

### SSE (the /api/sessions/:id/stream + /api/notifications/stream
connections)

WKWebView's `EventSource` works, but the connection sometimes dies
when the app backgrounds. Verify:
- Open a session, lock the screen, wait 30s, reopen — does the
  EventSource reconnect cleanly?
- The existing SSE clients have reconnect logic; verify it fires.

If broken: switch to polling on backgrounded apps using Capacitor's
`App.addListener('appStateChange', ...)`.

---

## 5. App Store Connect submission (½ day work, 1–2 weeks elapsed)

### One-time setup

1. **App Store Connect** → My Apps → "+" → New App
2. Bundle ID matches `com.pickyum.app` (must match the App ID created
   in step 3)
3. SKU: anything unique (e.g. `pickyum-ios-001`)

### Listing

Required assets — Apple rejects submissions missing any of these:
- **Screenshots**: 6.7" iPhone (1290×2796) + 5.5" iPhone (1242×2208).
  Optional: 12.9" iPad, but only needed if you market iPad support.
  ~5 screenshots each. Take from the iOS Simulator.
- **App icon**: 1024×1024 (same as the in-app icon).
- **Description**: 4,000 chars max. Lead with the value prop.
- **Keywords**: 100 chars total, comma-separated. Pick 5–10 high-intent
  search terms ("restaurant picker", "where to eat", etc.)
- **Privacy Policy URL**: must be a real, accessible URL. We have
  `/privacy` — use `https://pickyum.com/privacy`.
- **Support URL**: ideally a help page or contact form.
- **Age rating**: walk through the questionnaire. pickYum is 4+ unless
  you add user-generated content moderation concerns.

### Privacy disclosure

Apple's "Data Privacy" form asks what data you collect:
- Email, Username (Contact Info)
- Location (when nearby search is used)
- Browsing History (which restaurants you accept)
- Usage Data (analytics — if Sentry counts)

Be honest. Lying here is a fast path to rejection or removal.

### Build + upload

```bash
npm run build:ios
npx cap open ios     # opens Xcode
```

In Xcode:
1. Select the "Any iOS Device" target
2. Product → Archive
3. Distribute App → App Store Connect → Upload

Submit for review in App Store Connect once the build appears (10–30 min
to process). **Review typically takes 24–48 hours.**

### Common first-submission rejections

1. **"Sign in with Apple" missing** — if you have other social sign-in
   (Google), Apple requires Sign in with Apple too. Add it via
   `@capacitor-community/apple-sign-in` if so.
2. **"Guideline 5.1.1 — Privacy"** — they want explicit explanations
   for permissions. Pad the `Info.plist` UsageDescription strings.
3. **"Guideline 4.0 — Design"** — vague; usually means the app feels
   like "just a website wrapper." Add at least one native-feeling
   touch: pull-to-refresh, native share sheet, haptic feedback on
   accept.
4. **"Account deletion missing"** — Apple now requires in-app account
   deletion. Add a "Delete account" flow on the Your Info page.

Plan for 2 cycles. Each rejection takes 24–48 hours to re-submit and
review, so factor 1–2 weeks of calendar.

---

## 6. CI/CD for iOS (1 day)

Building iOS in CI requires a macOS runner. Options:

### GitHub Actions (macos-latest)

```yaml
# .github/workflows/deploy-ios.yml
name: iOS Build
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run build:ios
      - name: Setup signing
        env:
          BUILD_CERTIFICATE_BASE64: ${{ secrets.IOS_CERT }}
          P12_PASSWORD: ${{ secrets.IOS_CERT_PASSWORD }}
          PROVISIONING_PROFILE_BASE64: ${{ secrets.IOS_PROFILE }}
        run: ./scripts/setup-ios-signing.sh
      - name: Archive + Upload
        run: |
          xcodebuild -workspace ios/App/App.xcworkspace \
                     -scheme App \
                     -configuration Release \
                     -archivePath ios/App/build/App.xcarchive \
                     archive
          xcodebuild -exportArchive \
                     -archivePath ios/App/build/App.xcarchive \
                     -exportPath ios/App/build/export \
                     -exportOptionsPlist ios/exportOptions.plist
          xcrun altool --upload-app -f ios/App/build/export/App.ipa \
                       --apiKey "$APP_STORE_CONNECT_KEY_ID" \
                       --apiIssuer "$APP_STORE_CONNECT_ISSUER_ID"
```

Cost: macos-14 runners are billed at 10× Linux minute rate. ~$0.08/min
on GitHub-hosted runners. A 15-min build = $1.20. Run on release
tags, not every commit.

### Fastlane (easier signing management)

```bash
gem install fastlane
cd ios
fastlane init
```

Walks through cert + profile setup. Saves you from base64-encoding
certs in env vars. Worth the learning curve once you're shipping
weekly.

---

## 7. Maintenance reality

Every web release becomes:
1. `npm run build:ios`
2. Bump iOS marketing version + build number in Xcode
3. Archive + upload (5–10 min)
4. Submit through App Store Connect
5. Wait for review (1–48 hours)

For most code changes you can use **TestFlight beta** (immediate, no
review). For App Store updates, expedited reviews are possible but
rare — plan around the queue.

Keep a `CHANGELOG.md` of native-specific changes — useful for the
App Store "what's new" field and for tracking which native build is
in users' hands vs which web version is on the server.

---

## 8. When to also add Android

If you do iOS first, Android is mostly a copy-paste with smaller scope:

- Google Play has a one-time $25 fee (vs Apple's $99/year)
- Reviews are faster (hours, not days) and rarely reject
- APNs work in Section 3 ports almost directly to FCM
- Capacitor commands: `npx cap add android`, `npx cap copy android`

Estimated effort: +2 days once iOS is shipped. Probably worth it
since you've already paid the bigger up-front cost.

---

## 9. Decision checkpoint before you start

Re-read § 0 ("Decide what you're solving"). If the answer is still
yes, work through the sections in order. Each section's effort is
roughly independent — if § 3 (APNs) turns into a slog you can ship
a notification-less v1 to TestFlight while you iterate on push.

If the answer feels less clear than it did originally, defer and
re-evaluate after the next quarter of usage data. The PWA install
funnel + Phase G web push covers everyone except iOS-without-PWA
users. If THAT cohort isn't your bottleneck, Capacitor is the wrong
investment.
