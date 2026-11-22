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

/** Image file → data URL of a 64 × 64 PNG (square cut from the middle, smooth scaling). */
function toIcon64(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      try {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        if (!side) throw new Error('empty');
        const c = document.createElement('canvas'); c.width = 64; c.height = 64;
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = side > 64; g.imageSmoothingQuality = 'high'; // pixel art stays sharp when enlarged
        g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 64, 64);
        resolve(c.toDataURL('image/png'));
      } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
    img.src = url;
  });
}

export function Advanced({ n, reload, onRemoved }) {
  const [f, setF] = useState({ name: n.name, ...n.settings });
  const [busy, setBusy] = useState(false);
  const [icon, setIcon] = useState(0); // > 0 once an icon was saved here
  useEffect(() => { setF({ name: n.name, ...n.settings }); }, [n.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF({ ...f, [k]: e && e.target ? e.target.value : e });
  const save = async () => { setBusy(true); try { await put(`/mc-network/net/${n.id}`, f); toast.success(t('Saved – a running proxy reloads it right away')); reload(); } catch (e) { toast.error(e.message); } setBusy(false); };
  const [hasIcon, setHasIcon] = useState(!!n.icon);
  useEffect(() => { setHasIcon(!!n.icon); }, [n.id, n.icon]);
  const upload = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // the same file again later still counts as a choice
    if (!file) return;
    // Any size: scaled (and cropped to a square from the middle) to the 64 × 64 PNG Minecraft wants
    let data;
    try { data = await toIcon64(file); } catch { toast.error(t('This image could not be read.')); return; }
    try { const x = await put(`/mc-network/net/${n.id}/icon`, { data }); toast.success(x.restartNeeded ? t('Icon saved – shows after a restart of the proxy') : t('Icon saved')); setIcon(Date.now()); setHasIcon(true); } catch (err) { toast.error(err.message); }
  };
  const removeIcon = async () => {
    if (!(await confirmDialog({ title: t('Remove the icon?'), text: t('The server list shows the default icon again.'), confirm: t('Remove') }))) return;
    try { const x = await del(`/mc-network/net/${n.id}/icon`); toast.success(x.restartNeeded ? t('Icon removed – the default icon shows after a restart of the proxy') : t('Icon removed')); setHasIcon(false); setIcon(0); } catch (err) { toast.error(err.message); }
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
            {hasIcon && <img className="mcn-icon" alt={t('Server icon')} src={`${apiUrl(`/api/mc-network/net/${n.id}/icon`)}?v=${icon}`} onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} onLoad={(e) => { e.currentTarget.style.visibility = 'visible'; }} />}
            <label className="btn sm ghost mcn-file-btn"><Image size={14} aria-hidden="true" /> {t('Choose icon')}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="mcn-file" onChange={upload} /></label>
            {hasIcon && <Btn className="sm ghost" icon={Trash2} onClick={removeIcon}>Remove icon</Btn>}
            <span className="small muted">{t('Any image – Hostwerk scales it to 64 × 64 pixels.')}</span>
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
          <div className="row-tight"><Btn className="sm primary" busy={busy} disabled={!String(f.name || '').trim()} onClick={save}>Save</Btn></div>
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
