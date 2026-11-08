import type { Metadata } from 'next';
import { ComplianceConsole } from '@/presentation/components/compliance/ComplianceConsole';

export const metadata: Metadata = { title: 'Compliance console' };

export default function Page() {
  return <ComplianceConsole />;
}
