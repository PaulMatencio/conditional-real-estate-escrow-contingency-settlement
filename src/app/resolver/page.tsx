import type { Metadata } from 'next';
import { PartyWorkspace } from '@/presentation/components/party/PartyWorkspace';

export const metadata: Metadata = { title: 'Dispute resolver' };

export default function Page() {
  return <PartyWorkspace role="resolver" />;
}
