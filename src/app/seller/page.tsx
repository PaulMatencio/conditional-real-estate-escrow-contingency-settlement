import type { Metadata } from 'next';
import { PartyWorkspace } from '@/presentation/components/party/PartyWorkspace';

export const metadata: Metadata = { title: 'Seller' };

export default function Page() {
  return <PartyWorkspace role="seller" />;
}
