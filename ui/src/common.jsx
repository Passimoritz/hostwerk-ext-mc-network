import { useState } from 'react';
import { Copy, Check, AlertTriangle, XCircle, Info, CheckCircle2 } from 'lucide-react';
import { post, waitJob } from '@hostwerk/api';
import { toast } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';

/* Shared bits of the page: jobs with a toast, copy buttons, check lines, small formatting. */

/** POST that starts a job, waits for it and reports. → job result or null */
export async function runJob(path, body, ok) {
  try {
    const r = await post(path, body);
    const j = await waitJob(r.job);
    if (ok) toast.success(ok);
    return j.result || {};
  } catch (e) { if (!e.cancelled) toast.error(e.message); return null; }
}

export function CopyBtn({ text, label }) {
  const [done, setDone] = useState(false);
  const copy = () => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }, () => toast.error('Could not copy'));
  return <button type="button" className="btn ghost xs icon" title={label} aria-label={label} onClick={copy}>{done ? <Check /> : <Copy />}</button>;
}

const LEVEL = { ok: CheckCircle2, info: Info, warn: AlertTriangle, err: XCircle };
export function CheckList({ items }) {
  if (!items || !items.length) return null;
  return (
    <ul className="mcn-checks">
      {items.map((c, i) => { const I = LEVEL[c.level] || Info; return <li key={i} className={`mcn-check mcn-check-${c.level}`}><I size={15} aria-hidden="true" /><span>{c.text}</span></li>; })}
    </ul>
  );
}

export const locale = () => (typeof document !== 'undefined' && document.documentElement.lang) || 'en';
export const when = (ts) => (ts ? new Date(ts).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
export const plainNames = (list) => (list || []).join(', ');
export const kindLabel = (k) => (k === 'bungeecord' ? 'BungeeCord' : 'Velocity');
export const T = t;
