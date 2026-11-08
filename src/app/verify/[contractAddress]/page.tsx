import type { Metadata } from 'next';
import { NotaryPortal } from '@/presentation/components/notary/NotaryPortal';

export const metadata: Metadata = { title: 'Notary verification', robots: { index: false, follow: false } };

/** FR-NOTARY-01: /verify/[contractAddress]. Only the public address is in the URL (NFR-07). */
export default async function Page({ params }: { params: Promise<{ contractAddress: string }> }) {
  const { contractAddress } = await params;
  return <NotaryPortal address={contractAddress.toLowerCase().replace(/^0x/, '')} />;
}
