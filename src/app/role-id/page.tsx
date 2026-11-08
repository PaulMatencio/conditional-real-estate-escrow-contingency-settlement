import type { Metadata } from 'next';
import { RoleIdTool } from '@/presentation/components/RoleIdTool';

export const metadata: Metadata = { title: 'My role id' };

export default function RoleIdPage() {
  return <RoleIdTool />;
}
