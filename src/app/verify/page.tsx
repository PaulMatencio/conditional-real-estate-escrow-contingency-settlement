import type { Metadata } from 'next';
import { NotaryPortal } from '@/presentation/components/notary/NotaryPortal';

export const metadata: Metadata = { title: 'Notary verification' };

export default function Page() {
  return <NotaryPortal />;
}
