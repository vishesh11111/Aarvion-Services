import { redirect } from 'next/navigation';

/**
 * The root path has no content of its own. `middleware.ts` has already decided
 * whether this visitor has a session, so an unauthenticated request never
 * reaches here — it is redirected to /login before rendering.
 */
export default function RootPage() {
  redirect('/dashboard');
}
