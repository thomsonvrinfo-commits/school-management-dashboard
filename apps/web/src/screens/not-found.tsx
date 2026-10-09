import { Link } from "react-router";

export function NotFound() {
  return (
    <main className="mx-auto max-w-sm px-6 py-16">
      <h1 className="text-2xl font-extrabold">That page does not exist</h1>
      <p className="mt-2 text-dim">The link may be old or mistyped.</p>
      <Link to="/" className="mt-4 inline-block min-h-11 py-2.5 font-semibold text-violet underline">Go to SchoolPulse</Link>
    </main>
  );
}
