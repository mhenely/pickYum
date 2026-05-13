import { Link } from 'react-router-dom';

const TermsPage = () => (
  <div className="max-w-3xl mx-auto px-4 py-8 prose prose-sm prose-orange">
    <h1 className="text-2xl font-bold text-gray-900 mb-2">Terms of Service</h1>
    <p className="text-xs text-gray-400 mb-6">Last updated: 2026-05-07</p>

    <p className="text-sm text-gray-700 leading-relaxed">
      These are good-faith starter terms for a personal project. Replace them with a contract
      reviewed by a lawyer before any public launch with real users or revenue.
    </p>

    <h2 className="text-lg font-bold text-gray-900 mt-8 mb-3">Using PickYum</h2>
    <p className="text-sm text-gray-700">
      You can use PickYum to save restaurants, organize group votes, and share recommendations.
      You agree not to:
    </p>
    <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5">
      <li>Submit content that is unlawful, defamatory, or infringes someone else's rights.</li>
      <li>Use the service to send spam or unsolicited messages.</li>
      <li>Probe, scrape, or interfere with the service or its underlying infrastructure.</li>
      <li>Impersonate someone else or create accounts on behalf of others.</li>
      <li>Create automated accounts or scrape data without written permission.</li>
    </ul>

    <h2 className="text-lg font-bold text-gray-900 mt-8 mb-3">Your account</h2>
    <p className="text-sm text-gray-700">
      You're responsible for keeping your password safe and for activity under your account.
      Tell us right away if you suspect unauthorized access. We may suspend or close accounts
      that violate these terms or that are inactive for extended periods (we'll email first).
    </p>

    <h2 className="text-lg font-bold text-gray-900 mt-8 mb-3">Your content</h2>
    <p className="text-sm text-gray-700">
      You keep ownership of reviews, recommendations, and other content you post. By posting,
      you grant PickYum a non-exclusive, worldwide, royalty-free license to host, display, and
      distribute that content within the app and as part of group voting and social features.
      You can revoke this license by deleting the content.
    </p>

    <h2 className="text-lg font-bold text-gray-900 mt-8 mb-3">Restaurant data</h2>
    <p className="text-sm text-gray-700">
      Restaurant information may come from public sources or the Google Places API. PickYum
      doesn't guarantee that hours, prices, ratings, or availability are current. Always
      double-check before traveling somewhere.
    </p>

    <h2 className="text-lg font-bold text-gray-900 mt-8 mb-3">Service changes & availability</h2>
    <p className="text-sm text-gray-700">
      Features may be added, removed, or changed at any time. We don't guarantee uptime, and
      the service is provided "as is" without warranties of any kind. To the maximum extent
      permitted by law, PickYum's total liability for any claim is limited to USD $50 or the
      amount you paid in the past 12 months, whichever is greater.
    </p>

    <h2 className="text-lg font-bold text-gray-900 mt-8 mb-3">Termination</h2>
    <p className="text-sm text-gray-700">
      You can delete your account at any time from the profile page. We may suspend or
      terminate access for material breach of these terms.
    </p>

    <h2 className="text-lg font-bold text-gray-900 mt-8 mb-3">Disputes</h2>
    <p className="text-sm text-gray-700">
      These terms are governed by the laws of <em>[your jurisdiction]</em>, excluding its
      conflict-of-law rules. Disputes will be resolved in the courts of <em>[your jurisdiction]</em>.
    </p>

    <h2 className="text-lg font-bold text-gray-900 mt-8 mb-3">Changes</h2>
    <p className="text-sm text-gray-700">
      We may update these terms. Material changes will be announced by email to active
      accounts. Continued use after a change means you accept the new terms.
    </p>

    <h2 className="text-lg font-bold text-gray-900 mt-8 mb-3">Contact</h2>
    <p className="text-sm text-gray-700">
      Questions or notices: <em>[your contact email]</em>.
    </p>

    <div className="mt-10 pt-6 border-t border-gray-200">
      <Link to="/" className="text-sm text-orange-600 hover:underline">← Back to PickYum</Link>
    </div>
  </div>
);

export default TermsPage;
