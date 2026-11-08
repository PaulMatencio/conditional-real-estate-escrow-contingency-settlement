import type { Metadata } from 'next';
import { PartyWorkspace } from '@/presentation/components/party/PartyWorkspace';

export const metadata: Metadata = { title: 'Inspector' };

export default function Page() {
  return <PartyWorkspace role="inspector" />;
}
