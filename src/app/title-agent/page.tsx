import type { Metadata } from 'next';
import { PartyWorkspace } from '@/presentation/components/party/PartyWorkspace';

export const metadata: Metadata = { title: 'Title agent' };

export default function Page() {
  return <PartyWorkspace role="titleAgent" />;
}
