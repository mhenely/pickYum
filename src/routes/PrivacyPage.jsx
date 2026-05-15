import { Link } from 'react-router-dom';

const PrivacyPage = () => (
  <div className="max-w-3xl mx-auto px-4 py-8 prose prose-sm prose-orange">
    <h1 className="text-2xl font-bold text-gray-900 mb-2">Privacy Policy</h1>
    <p className="text-xs text-gray-400 mb-6">Last updated: 2026-05-07</p>

    <p className="text-sm text-gray-700 leading-relaxed">
      This is a generic, good-faith starting point — replace it with a tailored policy reviewed
      by a lawyer before public launch in your jurisdiction. PickYum is a personal project at
      the time of writing.
    </p>

    <h2 className="text-lg font-bold text-gray-900 mt-8 mb-3">What we collect</h2>
    <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5">
      <li><strong>Account data</strong>: email, username, password hash (we never store your password in clear text), avatar URL if you sign in via Google/Facebook.</li>
      <li><strong>Activity data</strong>: restaurants you favorite/save/rate/review, group voting history, flip counter.</li>
      <li><strong>Social graph</strong>: who you follow, friend requests, group memberships, recommendations you send or receive.</li>
      <li><strong>Operational data</strong>: server logs (IP, user agent, request paths) for security and debugging. Logs are retained for up to 30 days.</li>
      <li><strong>Cookies</strong>: a single httpOnly authentication cookie (<code>token</code>). No tracking cookies, no third-party advertising cookies.</li>
    </ul>

    <h2 className="text-lg font-bold text-gray-900 mt-8 mb-3">What we don't collect</h2>
    <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5">
      <li>Your phone number, address, or precise location. The "near me" search uses an address you type — not GPS.</li>
      <li>Payment information. There is no paid tier.</li>
      <li>Any data from your device's contacts, camera, or microphone.</li>
    </ul>

    <h2 className="text-lg font-bold text-gray-900 mt-8 mb-3">Third parties we share with</h2>
    <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5">
      <li><strong>Google Places API</strong> — your search query and any address you enter when looking up nearby restaurants. Per Google's terms.</li>
      <li><strong>Supabase</strong> — our database and OAuth provider. Account credentials are stored on Supabase infrastructure.</li>
      <li><strong>Resend</strong> — sends transactional emails (verification, password reset). Your email address only.</li>
      <li><strong>Sentry</strong> — captures uncaught errors. Personally identifying info is redacted before transit.</li>
    </ul>
    <p className="text-sm text-gray-700 mt-3">We do not sell or rent your data to anyone.</p>

    <h2 className="text-lg font-bold text-gray-900 mt-8 mb-3">Your rights</h2>
    <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5">
      <li><strong>Access / export</strong>: contact us and we'll send you a copy of your data.</li>
      <li><strong>Deletion</strong>: delete your account from your profile page. Your account, favorites, options, history, and group memberships are permanently removed. Your reviews are kept by default but anonymized — they appear as <em>[deleted user]</em> on each restaurant's page so the community keeps the rating data. The delete-account dialog has an optional "also remove my reviews" checkbox if you want those gone too. Group <em>events</em> you participated in remain (with your username) so other participants' history stays consistent.</li>
      <li><strong>Correction</strong>: edit your profile from the settings page.</li>
      <li><strong>EU/UK residents (GDPR)</strong>: you have the right to portability, erasure, and to object. Email us to exercise them.</li>
      <li><strong>California residents (CCPA)</strong>: same rights as above. We don't sell your data.</li>
    </ul>

    <h2 className="text-lg font-bold text-gray-900 mt-8 mb-3">Children</h2>
    <p className="text-sm text-gray-700">PickYum is not directed at children under 13. If you believe a child has registered, contact us and we'll remove the account.</p>

    <h2 className="text-lg font-bold text-gray-900 mt-8 mb-3">Changes</h2>
    <p className="text-sm text-gray-700">If we materially change this policy, we'll notify active accounts by email and update the "Last updated" date above.</p>

    <h2 className="text-lg font-bold text-gray-900 mt-8 mb-3">Contact</h2>
    <p className="text-sm text-gray-700">Questions, deletion requests, or anything else: <em>[your contact email]</em>.</p>

    <div className="mt-10 pt-6 border-t border-gray-200">
      <Link to="/" className="text-sm text-orange-600 hover:underline">← Back to PickYum</Link>
    </div>
  </div>
);

export default PrivacyPage;
