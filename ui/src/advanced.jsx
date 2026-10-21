import { useEffect, useState } from 'react';
import { Image, Trash2, Unlink } from 'lucide-react';
import { put, del, waitJob, apiUrl } from '@hostwerk/api';
import { Btn, Field, InfoTip, Switch, SettingRow, toast, confirmDialog } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';

/*
 * Advanced settings of the proxy: name, MOTD and icon in the server list, player count shown, ping passthrough, what
 * happens with a second login – and dissolving the network.
 */
const PING = [
  { id: 'DISABLED', label: 'Off – the proxy answers itself' },
  { id: 'DESCRIPTION', label: 'Text of the lobby' },
  { id: 'MODS', label: 'Mod list of the lobby' },
  { id: 'ALL', label: 'Everything of the lobby' },
];

export function Advanced({ n, reload, onRemoved }) {
  const [f, setF] = useState({ name: n.name, ...n.settings });
  const [busy, setBusy] = useState(false);
  const [icon, setIcon] = useState(0);
  useEffect(() => { setF({ name: n.name, ...n.settings }); }, [n.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF({ ...f, [k]: e && e.target ? e.target.value : e });
  const save = async () => { setBusy(true); try { await put(`/mc-network/net/${n.id}`, f); toast.success(t('Saved – a running proxy reloads it right away')); reload(); } catch (e) { toast.error(e.message); } setBusy(false); };
  const upload = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = async () => { try { const x = await put(`/mc-network/net/${n.id}/icon`, { data: r.result }); toast.success(x.restartNeeded ? t('Icon saved – shows after a restart of the proxy') : t('Icon saved')); setIcon(Date.now()); } catch (err) { toast.error(err.message); } };
    r.readAsDataURL(file);
  };
  const dissolve = async (release) => {
    const ok = await confirmDialog(release
      ? { title: t('Dissolve “{name}”?', { name: n.name }), text: t('The servers become reachable directly again (their previous settings come back). The proxy itself stays as a server.'), confirm: t('Dissolve'), danger: true }
      : { title: t('Remove “{name}” from this page?', { name: n.name }), text: t('Nothing changes on the servers – the network keeps running, it is just no longer managed here.'), confirm: t('Remove') });
    if (!ok) return;
    try { const r = await del(`/mc-network/net/${n.id}${release ? '?release=1' : ''}`); if (r && r.job) await waitJob(r.job); toast.success(t('Done')); onRemoved(); } catch (e) { toast.error(e.message); }
  };
  return (
    <div className="grid grid-2 mcn-grid">
      <div className="card">
        <div className="card-head"><h3>Server list entry</h3></div>
        <div className="card-body stack mcn-gap">
          <Field label={t('Name of the network')}><input className="input sm" maxLength={60} value={f.name} onChange={set('name')} /></Field>
          <Field label={t('First line')} hint={n.kind === 'velocity' ? t('Colours with MiniMessage, e.g. <green>Hello</green>.') : t('Colours with & codes, e.g. &aHello.')}><input className="input sm" maxLength={120} value={f.motd1} onChange={set('motd1')} /></Field>
          <Field label={t('Second line')}><input className="input sm" maxLength={120} value={f.motd2} onChange={set('motd2')} /></Field>
          <Field label={t('Players shown as maximum')}><input className="input sm" type="number" min={0} max={100000} value={f.showMaxPlayers} onChange={set('showMaxPlayers')} /></Field>
          <div className="row-tight mcn-wrap">
            <img className="mcn-icon" alt={t('Server icon')} src={`${apiUrl(`/api/mc-network/net/${n.id}/icon`)}?v=${icon}`} onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} onLoad={(e) => { e.currentTarget.style.visibility = 'visible'; }} />
            <label className="btn sm ghost"><Image size={14} aria-hidden="true" /> {t('Choose icon (64 × 64 PNG)')}<input type="file" accept="image/png" className="mcn-file" onChange={upload} /></label>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h3>Proxy</h3></div>
        <div className="card-body stack mcn-gap">
          <Field label={t('Ping passthrough')} hint={t('What the server list shows: the proxy’s own entry or the one of the lobby.')}>
            <select className="input sm" value={f.pingPassthrough} onChange={set('pingPassthrough')}>{PING.map((p) => <option key={p.id} value={p.id}>{t(p.label)}</option>)}</select>
          </Field>
          {n.kind === 'velocity' && <SettingRow title={t('Second login wins')} text={t('Logging in again from another place ends the first session (otherwise the second login is refused).')}><Switch checked={!!f.kickExisting} onChange={set('kickExisting')} /></SettingRow>}
          <div className="small muted">{t('Account check (online mode) stays on at the proxy; the servers behind it listen on 127.0.0.1 only.')} <InfoTip title={t('Why')}>The servers behind the proxy do not check accounts themselves – they trust the proxy. That is only safe when nobody can reach them directly. Hostwerk never opens their ports in the router or the firewall.</InfoTip></div>
          <div className="row-tight"><Btn className="sm primary" busy={busy} onClick={save}>Save</Btn></div>
        </div>
      </div>
      <div className="card mcn-span">
        <div className="card-head"><h3>Remove the network</h3></div>
        <div className="card-body row-tight mcn-wrap">
          <Btn className="sm ghost" icon={Unlink} onClick={() => dissolve(true)}>Dissolve – servers reachable directly again</Btn>
          <Btn className="sm ghost" icon={Trash2} onClick={() => dissolve(false)}>Only remove from this page</Btn>
        </div>
      </div>
    </div>
  );
}
