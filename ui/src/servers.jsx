import { useEffect, useState } from 'react';
import { ArrowUp, ArrowDown, Trash2, Plus, Save, Wrench } from 'lucide-react';
import { post, put, waitJob } from '@hostwerk/api';
import { Btn, InfoTip, Switch, TileEmpty, toast, confirmDialog } from '@hostwerk/ui';
import { contextMenu } from '@hostwerk/kit';
import { t } from '@hostwerk/i18n';

/*
 * Servers of a network: order (the first one is the lobby, the rest the fallback order), the name each has in the network,
 * direct addresses (forced hosts, e.g. survival.example.org), maintenance – and adding/removing servers.
 */
const keyOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'server';

export function Servers({ n, free, reload }) {
  const fromNet = () => n.members.map((m) => ({ id: m.id, name: m.name, type: m.type, version: m.version, key: m.key, hosts: (m.forced || []).join(', '), maintenance: m.maintenance }));
  const [rows, setRows] = useState(fromNet);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRows(fromNet()); }, [n.id, n.members.map((m) => `${m.id}:${m.key}:${m.maintenance}`).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const fits = (s) => (n.kind === 'bungeecord' ? s.bungee : s.velocity);
  const addable = free.filter((s) => !rows.some((r) => r.id === s.id) && fits(s));
  const set = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= rows.length) return; const l = rows.slice(); [l[i], l[j]] = [l[j], l[i]]; setRows(l); };
  const dirty = JSON.stringify(rows.map((r) => [r.id, r.key, r.hosts])) !== JSON.stringify(fromNet().map((r) => [r.id, r.key, r.hosts]));
  const dupe = rows.find((r, i) => rows.findIndex((x) => x.key === r.key) !== i);

  const save = async () => {
    if (!rows.length && !(await confirmDialog({ title: t('Remove every server?'), text: t('The servers become reachable directly again. The proxy stays.'), confirm: t('Remove all') }))) return;
    setBusy(true);
    try {
      const membersChanged = JSON.stringify(rows.map((r) => [r.id, r.key])) !== JSON.stringify(n.members.map((m) => [m.id, m.key]));
      if (membersChanged) { const r = await put(`/mc-network/net/${n.id}/members`, { members: rows.map((r2) => ({ id: r2.id, key: r2.key })) }); await waitJob(r.job); }
      const forced = {};
      for (const r of rows) for (const h of String(r.hosts || '').split(/[\s,;]+/).filter(Boolean)) forced[h.toLowerCase()] = r.key;
      await put(`/mc-network/net/${n.id}`, { forced });
      toast.success(membersChanged ? t('Network updated – the servers restarted where needed') : t('Saved'));
      reload();
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  const maintenance = async (r, on) => {
    let stop = false;
    if (on) {
      const a = await confirmDialog({ title: t('Maintenance for “{name}”', { name: r.name }), text: t('Players on it go to the lobby and nobody lands there automatically any more.'), confirm: t('Start maintenance'), checkbox: { label: t('Also stop the server, so nobody can switch to it'), checked: true } });
      if (!a || !a.ok) return;
      stop = a.checked;
    }
    try { await post(`/mc-network/net/${n.id}/maintenance`, { server: r.id, on, stop: !!stop }); toast.success(on ? t('“{name}” is in maintenance', { name: r.name }) : t('“{name}” is open again', { name: r.name })); reload(); } catch (e) { toast.error(e.message); }
  };
  const menu = (e, r, i) => contextMenu(e, [
    { label: t('Open server'), onClick: () => { location.hash = `#/mc/${encodeURIComponent(r.id)}`; } },
    { label: t('Move up'), icon: ArrowUp, disabled: i === 0, onClick: () => move(i, -1) },
    { label: t('Move down'), icon: ArrowDown, disabled: i === rows.length - 1, onClick: () => move(i, 1) },
    { label: r.maintenance ? t('End maintenance') : t('Maintenance'), icon: Wrench, onClick: () => maintenance(r, !r.maintenance) },
    { label: t('Remove from the network'), icon: Trash2, danger: true, onClick: () => setRows(rows.filter((x) => x.id !== r.id)) },
  ]);

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h3>Servers in this network</h3>
          <InfoTip title={t('Order')}>The first server is the lobby: everybody lands there. If it is full or down, the proxy tries the next one. Direct addresses (forced hosts) send players who use e.g. survival.example.org straight to that server – the domain has to point to this PC.</InfoTip>
        </div>
        {rows.length === 0 ? <TileEmpty icon={Wrench} text={t('No servers in this network yet.')} /> : (
          <ol className="mcn-rows">
            {rows.map((r, i) => (
              <li key={r.id} className="mcn-row" onContextMenu={(e) => menu(e, r, i)}>
                <span className="mcn-pos" aria-hidden="true">{i + 1}</span>
                <div className="mcn-row-name">
                  <b className="ellipsis">{r.name}</b>
                  <span className="tiny muted">{[i === 0 ? t('lobby') : null, r.type, r.version].filter(Boolean).join(' · ')}</span>
                </div>
                <label className="mcn-field"><span className="tiny muted">Name in the network</span><input className="input sm" value={r.key} onChange={(e) => set(i, { key: keyOf(e.target.value) })} /></label>
                <label className="mcn-field mcn-field-wide"><span className="tiny muted">Direct addresses</span><input className="input sm" value={r.hosts} placeholder={t('e.g. survival.example.org')} onChange={(e) => set(i, { hosts: e.target.value })} /></label>
                <label className="mcn-switch"><Switch checked={!!r.maintenance} onChange={(v) => maintenance(r, v)} label={t('Maintenance for {name}', { name: r.name })} /><span className="tiny">Maintenance</span></label>
                <div className="row-tight">
                  <button type="button" className="btn ghost xs icon" disabled={i === 0} title={t('Move up')} aria-label={t('Move {name} up', { name: r.name })} onClick={() => move(i, -1)}><ArrowUp /></button>
                  <button type="button" className="btn ghost xs icon" disabled={i === rows.length - 1} title={t('Move down')} aria-label={t('Move {name} down', { name: r.name })} onClick={() => move(i, 1)}><ArrowDown /></button>
                  <button type="button" className="btn ghost xs icon" title={t('Remove from the network')} aria-label={t('Remove {name} from the network', { name: r.name })} onClick={() => setRows(rows.filter((x) => x.id !== r.id))}><Trash2 /></button>
                </div>
              </li>
            ))}
          </ol>
        )}
        <div className="card-body row-tight mcn-wrap">
          {addable.length > 0 && (
            <select className="input sm mcn-add" aria-label={t('Add a server')} value="" onChange={(e) => { const s = free.find((x) => x.id === e.target.value); if (s) setRows([...rows, { id: s.id, name: s.name, type: s.type, version: s.version, key: keyOf(s.name), hosts: '', maintenance: false }]); }}>
              <option value="">{t('Add a server …')}</option>
              {addable.map((s) => <option key={s.id} value={s.id}>{`${s.name} (${s.type} ${s.version || ''})`}</option>)}
            </select>
          )}
          {free.some((s) => !fits(s)) && <span className="tiny muted">{n.kind === 'bungeecord' ? t('BungeeCord takes Paper, Purpur, Folia and Spigot.') : t('Velocity takes Paper, Purpur, Folia, Fabric, NeoForge and Forge.')}</span>}
          <div className="grow" />
          {dupe && <span className="small mcn-err" role="alert">{t('“{key}” is used twice.', { key: dupe.key })}</span>}
          <Btn className="sm primary" icon={Save} busy={busy} disabled={!dirty || !!dupe} onClick={save}>Save</Btn>
        </div>
      </div>
      {free.length === 0 && <div className="tiny muted">{t('Every Minecraft server is in a network. New servers: Minecraft → New server.')} <a href="#/mc"><Plus size={11} aria-hidden="true" /> {t('Minecraft')}</a></div>}
    </div>
  );
}
