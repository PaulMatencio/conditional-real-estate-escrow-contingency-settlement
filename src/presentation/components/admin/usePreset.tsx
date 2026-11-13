'use client';
import { Wand2 } from 'lucide-react';
import { presetValues, testCase, type TestCase } from '@/domain/testCases';
import { useApp } from '../../providers/AppProvider';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';

/** The test case the admin's current escrow was deployed for (its vault name), with its preset values. */
export function usePreset(): { c: TestCase; values: ReturnType<typeof presetValues> } | null {
  const { contractAddress } = useApp();
  const { record, contractAddress: escrowAddress } = useEscrow();
  if (!contractAddress || escrowAddress !== contractAddress) return null;
  const c = testCase(record.meta?.caseId);
  return c ? { c, values: presetValues(c, Math.floor(Date.now() / 1000)) } : null;
}

/** "Fill from T07": fills the form below with the test case's values. Nothing is sent until the admin applies. */
export function PresetButton({ onApply }: { onApply: (v: ReturnType<typeof presetValues>) => void }) {
  const { t } = useT();
  const p = usePreset();
  if (!p) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-midnight-700 p-2 text-sm">
      <button type="button" className="btn-ghost" onClick={() => onApply(presetValues(p.c, Math.floor(Date.now() / 1000)))}>
        <Wand2 size={14} aria-hidden /> {t('dir.fillFrom').replace('{case}', p.c.id)}
      </button>
      <span className="text-xs text-slate-400">{p.c.label}</span>
    </div>
  );
}
