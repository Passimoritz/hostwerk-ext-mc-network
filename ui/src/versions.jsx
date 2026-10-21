import { useState } from 'react';
import { RefreshCw, Layers } from 'lucide-react';
import { put, useApi, waitJob } from '@hostwerk/api';
import { Btn, InfoTip, Switch, SettingRow, Loading, toast } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';

/*
 * Versions of everything in the network at a glance – and what keeps it current without anyone looking after it:
 * proxy builds (Hostwerk's server updates, put in when nobody is online, with a way back), Geyser/Floodgate (GeyserMC API,
 * probe + rollback), version bridges (ViaVersion & co. through Hostwerk's plugin updates), Bedrock Dedicated Servers.
 */
const VIA = [
  { id: 'viaversion', name: 'ViaVersion', text: 'Newer clients on an older server.' },
  { id: 'viabackwards', name: 'ViaBackwards', text: 'Older clients on a newer server (needs ViaVersion).' },
  { id: 'viarewind', name: 'ViaRewind', text: 'Very old clients 1.7–1.8 (needs both).' },
];

function Bridges({ n }) {
  const v = useApi(`/mc-network/net/${n.id}/via`, [n.id, n.members.length], { live: false, poll: false });
  const [busy, setBusy] = useState(null);
  if (!v.data) return <Loading />;
  const list = v.data.filter((s) => s.supported);
  const all = (k) => list.length > 0 && list.every((s) => s[k]);
  const set = async (k, on) => {
    setBusy(k);
    try {
      const r = await put(`/mc-network/net/${n.id}/via`, { [k]: on });
      const j = await waitJob(r.job);
      const bad = ((j.result && j.result.servers) || []).filter((x) => !x.ok);
      if (bad.length) toast.error(bad.map((x) => `${x.name}: ${x.why}`).join(' · ')); else toast.success(t('Applies after the next restart of each server'));
      v.reload();
    } catch (e) { toast.error(e.message); }
    setBusy(null);
  };
  return (
    <div className="stack mcn-gap">
      {VIA.map((x) => (
        <SettingRow key={x.id} title={x.name} text={t(x.text)}>
          <Switch checked={all(x.id)} disabled={busy !== null || !list.length} onChange={(on) => set(x.id, on)} label={x.name} />
        </SettingRow>
      ))}
      <div className="tiny muted">{v.data.filter((s) => !s.supported).map((s) => t('{name}: not possible for {type}', { name: s.name, type: s.type })).join(' · ')}</div>
    </div>
  );
}

export function Versions({ n, data, reload }) {
  const latest = useApi('/mc-network-versions', [], { live: false, poll: false });
  const save = async (patch) => { try { await put(`/mc-network/net/${n.id}`, patch); reload(); } catch (e) { toast.error(e.message); } };
  const L = latest.data || {};
  const rows = [];
  if (n) {
    rows.push({ name: n.kindLabel, have: [n.proxy.version, n.proxy.build && `#${n.proxy.build}`].filter(Boolean).join(' '), latest: n.proxyUpdates.pending ? `#${n.proxyUpdates.pending.build}` : t('current'), note: n.proxyUpdates.failed ? t('build #{b} was rolled back', { b: n.proxyUpdates.failed }) : null });
    for (const m of n.members) rows.push({ name: m.name, have: `${m.type} ${m.version || ''}`, latest: '', note: null });
    if (n.bedrock && n.bedrock.enabled) {
      rows.push({ name: 'Geyser', have: n.bedrock.build || '?', latest: L.geyser || '…', note: L.geyserTarget ? t('speaks Java {v}', { v: L.geyserTarget }) : null });
      if (n.bedrock.floodgate) rows.push({ name: 'Floodgate', have: n.bedrock.floodgateBuild || '?', latest: L.floodgate || '…', note: null });
    }
  }
  for (const b of data.bds || []) rows.push({ name: `${t('Bedrock server')} ${b.name}`, have: b.version || '?', latest: L.bds || '…', note: b.failed ? t('{v} was rolled back', { v: b.failed }) : null });
  return (
    <div className="grid grid-2 mcn-grid">
      <div className="card mcn-span">
        <div className="card-head"><Layers size={16} aria-hidden="true" /><h3>Versions</h3>
          <InfoTip title={t('Without maintenance')}>New builds come from the official sources (PaperMC, SpigotMC, GeyserMC, Modrinth, Mojang) with checksums. Hostwerk puts them in when nobody is online, checks that the server answers afterwards and goes back to the previous version if not. Everything is listed in Settings → Self-maintenance.</InfoTip>
          <div className="right"><Btn className="xs ghost" icon={RefreshCw} onClick={() => latest.reload()}>Check now</Btn></div>
        </div>
        <div className="card-body">
          {rows.length === 0 ? <span className="small muted">Nothing to keep up to date yet.</span> : (
            <table className="table mcn-table">
              <thead><tr><th scope="col">{t('Part')}</th><th scope="col">{t('Installed')}</th><th scope="col">{t('Newest')}</th><th scope="col">{t('Note')}</th></tr></thead>
              <tbody>{rows.map((r) => <tr key={r.name}><td>{r.name}</td><td className="mono">{r.have}</td><td className="mono">{r.latest}</td><td className="small muted">{r.note || ''}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      </div>
      {n && (
        <div className="card">
          <div className="card-head"><h3>Version bridges</h3><InfoTip title={t('Version bridges')}>Let players with other Minecraft versions in. In a network they belong on every server behind the proxy (the proxy itself already takes every version). Hostwerk keeps them up to date with its plugin updates.</InfoTip></div>
          <div className="card-body"><Bridges n={n} /></div>
        </div>
      )}
      {n && (
        <div className="card">
          <div className="card-head"><h3>Automatic</h3></div>
          <div className="card-body stack mcn-gap">
            <SettingRow title={t('Proxy updates')} text={t('New builds of the proxy as soon as nobody is online – with a way back.')}><Switch checked={n.proxyUpdates.auto} onChange={(v) => save({ proxyUpdatesAuto: v })} /></SettingRow>
            <SettingRow title={t('Install version bridges by itself')} text={t('Before a Geyser update that needs a newer Java version: ViaVersion on the servers that run an older one.')}><Switch checked={n.via.auto} onChange={(v) => save({ viaAuto: v })} /></SettingRow>
          </div>
        </div>
      )}
    </div>
  );
}
