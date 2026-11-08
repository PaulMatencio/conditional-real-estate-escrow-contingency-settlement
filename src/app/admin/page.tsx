import type { Metadata } from 'next';
import { AdminApp } from '@/presentation/components/AdminApp';

export const metadata: Metadata = { title: 'Admin' };

export default function AdminPage() {
  return <AdminApp />;
}
