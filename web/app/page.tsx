import { redirect } from 'next/navigation';
import { rt } from '@/lib/sim/runtime';
import Home from './home-client';

export const dynamic = 'force-dynamic';

/** The map, or straight to floor setup when no floor is built yet: decided on the server, so a fresh start never
 *  shows the 3D page for a moment before moving to the upload. */
export default function Page() {
  if (rt.floor === 'none') redirect('/setup');
  return <Home />;
}
