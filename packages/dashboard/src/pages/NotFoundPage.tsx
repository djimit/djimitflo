import { Link } from 'react-router-dom';

/** UX-3: unknown paths get a page instead of an empty layout. */
export function NotFoundPage() {
  return (
    <div className="p-6 max-w-3xl mx-auto space-y-3">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="text-sm text-foreground-secondary">There is no page at this address. It may have moved in the navigation regroup.</p>
      <Link to="/" className="underline">Back to the cockpit</Link>
    </div>
  );
}
