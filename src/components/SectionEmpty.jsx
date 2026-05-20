// Standard empty-state component: large emoji, short title, optional
// subtitle. Used across the app so an empty list always looks like the
// same kind of "intentional pause" rather than a half-rendered page.
//
// `action` is an optional ReactNode for a call-to-action — usually a
// <Link> or <button> styled as a primary affordance. Keeps the empty
// state from being a dead-end ("you have no trips, but here's how to
// start one").
export default function SectionEmpty({ icon, title, subtitle, action }) {
  return (
    <div className="text-center py-10 text-gray-400">
      <p className="text-3xl mb-2" aria-hidden="true">{icon}</p>
      <p className="font-medium text-gray-600 text-sm">{title}</p>
      {subtitle && <p className="text-xs mt-1">{subtitle}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
