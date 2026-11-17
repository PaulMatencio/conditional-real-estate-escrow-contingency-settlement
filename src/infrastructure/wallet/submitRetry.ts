/**
 * Submitting through the browser wallet (DApp Connector `submitTransaction`) sometimes fails once and goes through on
 * a second try: the wallet or its node connection was not ready (still syncing after the previous transaction, a
 * dropped RPC connection), and the wallet reports it as an opaque "object: [object Object]". Resubmitting the SAME
 * balanced, proved transaction is safe: the node accepts one copy, and a copy it already holds is reported as
 * "already imported / known", which means it is in the pool. So one automatic retry saves the user a whole new
 * build + proof; a rejection by the user is never retried.
 */

export interface SubmitRetryOptions {
  /** Attempts in all (default 2: the first and one retry). */
  attempts?: number;
  /** Wait before a retry, ms (default 3000: lets the wallet finish syncing). */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called before each retry with the reason of the failed attempt. */
  onRetry?: (attempt: number, reason: string) => void;
}

/** Text of a wallet error, also for DApp Connector `{ code, reason }` objects and errors carrying extra fields. */
export function walletErrorText(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as { type?: string; code?: unknown; reason?: unknown; message?: unknown; cause?: unknown };
    const parts: string[] = [];
    if (o.type === 'DAppConnectorAPIError' || typeof o.code === 'string') parts.push([o.code, o.reason].filter((x) => typeof x === 'string' && x).join(': '));
    if (typeof o.message === 'string' && o.message) parts.push(o.message);
    if (o.cause !== undefined && o.cause !== e) parts.push(walletErrorText(o.cause));
    const text = parts.filter(Boolean).join(' ← ');
    if (text && !/^(object: )?\[object Object\]$/.test(text)) return text;
    try {
      // Only fields beyond the (useless) message say anything more.
      const extra = Object.getOwnPropertyNames(e).filter((k) => k !== 'stack' && k !== 'message');
      const json = extra.length ? JSON.stringify(e, extra) : '';
      if (json && json !== '{}') return json.length > 400 ? `${json.slice(0, 400)}…` : json;
    } catch {
      /* circular */
    }
    return text || 'unknown wallet error';
  }
  return String(e);
}

/** The user (or the wallet's permission prompt) refused: never retried. */
export const isUserRejection = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'Rejected' || code === 'PermissionRejected') return true;
  return /\b(user )?(rejected|denied|declined|cancell?ed)\b/i.test(walletErrorText(e));
};

/** The node already holds this exact transaction: the earlier attempt went through. */
export const isAlreadySubmitted = (e: unknown): boolean => /already (imported|known|in (the )?pool|submitted)|duplicate transaction/i.test(walletErrorText(e));

/** Submits, retrying the same transaction once after a short wait when the failure is not the user's refusal. */
export async function submitWithRetry(submit: () => Promise<void>, opts: SubmitRetryOptions = {}): Promise<{ attempts: number }> {
  const attempts = Math.max(1, opts.attempts ?? 2);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try {
      await submit();
      return { attempts: i };
    } catch (e) {
      // A retry that finds the transaction already in the pool means the first attempt reached the node.
      if (i > 1 && isAlreadySubmitted(e)) return { attempts: i };
      if (i >= attempts || isUserRejection(e)) throw e;
      opts.onRetry?.(i, walletErrorText(e));
      await sleep(opts.delayMs ?? 3000);
    }
  }
}
