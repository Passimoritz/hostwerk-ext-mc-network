import { useEffect, useState } from 'react';
import { Network, LayoutDashboard, Server, Users, Smartphone, Layers, Settings2, Plus, RotateCcw, AlertTriangle, ShieldCheck } from 'lucide-react';
import { useApi } from '@hostwerk/api';
import { Btn, Empty, Field, InfoTip, Loading, Modal, Seg, Switch, SettingRow, Tabs, toast } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import { Overview } from './overview';
import { Servers } from './servers';
import { Players } from './players';
import { BedrockTab } from './bedrock';
import { Versions } from './versions';
import { Advanced } from './advanced';
import { runJob, CopyBtn } from './common';
import './style.css';

/*
 * Minecraft server network: proxy networks (Velocity, BungeeCord), Bedrock access (Geyser on the proxy or a single server,
 * own Bedrock Dedicated Server), version bridges, shared player lists – one page, six tabs. A network is chosen at the top
 * when there is more than one. Texts are English, German comes from locales/de.json.
 */

function NewNetwork({ data, onClose, onDone }) {
  const [f, setF] = useState({ name: '', kind: 'velocity', proxyId: '', members: [], lobby: false });
  const [busy, setBusy] = useState(false);
  const fits = (s) => (f.kind === 'bungeecord' ? s.bungee : s.velocity);
  const proxies = (data.proxies || []).filter((p) => (f.kind === 'bungeecord' ? p.type === 'bungeecord' : p.type === 'velocity'));
  const toggle = (id) => setF({ ...f, members: f.members.includes(id) ? f.members.filter((x) => x !== id) : [...f.members, id] });
  const create = async () => { setBusy(true); const r = await runJob('/mc-network', { ...f, proxyId: f.proxyId || undefined }, t('Network “{name}” is ready', { name: f.name })); setBusy(false); if (r) onDone(r.id); };
  const kinds = [{ id: 'velocity', label: t('Velocity (recommended)') }, { id: 'bungeecord', label: 'BungeeCord', disabled: !data.bungee, title: data.bungee ? undefined : t('Needs Hostwerk 3.2 or newer') }];
  return (
    <Modal title={t('New network')} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" busy={busy} disabled={!f.name.trim() || (!f.members.length && !f.lobby)} onClick={create}>Create network</Btn></>}>
      <div className="stack">
        <Field label={t('Name')}><input className="input" value={f.name} maxLength={60} placeholder={t('e.g. Friends network')} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t('Proxy')} hint={f.kind === 'velocity' ? t('Modern and secure: forwards players with a secret key. Takes Paper, Purpur, Folia, Fabric and NeoForge.') : t('For BungeeCord-only plugins. Forwards players without a secret – Hostwerk keeps the servers on 127.0.0.1 for that. Waterfall is discontinued and not offered.')}>
          <Seg value={f.kind} onChange={(kind) => setF({ ...f, kind, proxyId: '', members: [] })} options={kinds} />
        </Field>
        {proxies.length > 0 && (
          <Field label={t('Use an existing proxy')}>
            <select className="input" value={f.proxyId} onChange={(e) => setF({ ...f, proxyId: e.target.value })}>
              <option value="">{t('Create a new one')}</option>
              {proxies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        <SettingRow title={t('Create a lobby')} text={t('A small Paper server (flat, adventure, peaceful) where everybody lands first.')}><Switch checked={f.lobby} onChange={(v) => setF({ ...f, lobby: v })} /></SettingRow>
        <div className="label">{t('Servers in the network')}</div>
        {(data.free || []).length === 0 ? <div className="small muted">{t('No free Minecraft servers – create some under Minecraft, or start with a lobby.')}</div> : (
          <div className="mcn-pick">
            {data.free.map((s) => (
              <label key={s.id} className={`mcn-pick-item ${f.members.includes(s.id) ? 'mcn-picked' : ''} ${fits(s) ? '' : 'mcn-unfit'}`}>
                <input type="checkbox" disabled={!fits(s)} checked={f.members.includes(s.id)} onChange={() => toggle(s.id)} />
                <span className="grow ellipsis"><b>{s.name}</b> <span className="tiny muted">{s.type} {s.version || ''}{fits(s) ? '' : ` · ${t('not possible behind {kind}', { kind: f.kind === 'bungeecord' ? 'BungeeCord' : 'Velocity' })}`}</span></span>
              </label>
            ))}
          </div>
        )}
        <div className="tiny muted">{t('The servers are restarted once: they get the forwarding, listen on 127.0.0.1 only and stop checking accounts themselves – the proxy does that.')}</div>
      </div>
    </Modal>
  );
}

const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'servers', label: 'Servers', icon: Server },
  { id: 'players', label: 'Players & permissions', icon: Users },
  { id: 'bedrock', label: 'Bedrock', icon: Smartphone },
  { id: 'versions', label: 'Versions', icon: Layers },
  { id: 'advanced', label: 'Advanced', icon: Settings2 },
];
const NEEDS_NET = ['overview', 'servers', 'players', 'advanced'];

function NetworkPage() {
  const d = useApi('/mc-network', [], { live: true, poll: true });
  const [cur, setCur] = useState(() => { try { return localStorage.getItem('mcn-net') || null; } catch { return null; } });
  const [tab, setTab] = useState('overview');
  const [creating, setCreating] = useState(false);
  useEffect(() => { try { if (cur) localStorage.setItem('mcn-net', cur); } catch { /* private mode */ } }, [cur]);
  if (!d.data) return <div className="page">{d.error ? <Empty icon={AlertTriangle} title={t('The network could not be loaded')} text={d.error} action={<Btn icon={RotateCcw} onClick={() => d.reload()}>Try again</Btn>} /> : <Loading />}</div>;
  const data = d.data;
  const nets = data.networks;
  const n = nets.find((x) => x.id === cur) || nets[0] || null;
  const reload = () => d.reload({ silent: true });
  const nothing = !nets.length && !data.bedrock.some((s) => s.enabled) && !data.bds.length;
  const current = !n && NEEDS_NET.includes(tab) ? 'bedrock' : tab;
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1><Network /> Minecraft server network</h1>
          <p>Several servers behind one address, Java and Bedrock together – kept up to date by itself.</p>
        </div>
        <div className="actions">
          <InfoTip title={t('How it fits together')}>A proxy (Velocity) is the one address players connect to; it sends them to your servers and lets them switch with /server. Geyser on the proxy translates for Bedrock players (phone, console, Windows), Floodgate lets them in without a Java account. ViaVersion lets other Minecraft versions in. A Bedrock Dedicated Server is something else: Mojang’s own server with a separate Bedrock-only world.</InfoTip>
          <Btn className="primary" icon={Plus} onClick={() => setCreating(true)}>New network</Btn>
        </div>
      </div>
      {nothing ? (
        <Empty icon={Network} title={t('No network yet')} text={t('Put your servers behind one address (lobby, survival, minigames) – or let Bedrock players join a single server.')}
          action={<div className="row-tight mcn-wrap"><Btn className="primary" icon={Plus} onClick={() => setCreating(true)}>New network</Btn><Btn icon={Smartphone} onClick={() => setTab('bedrock')}>Bedrock only</Btn></div>} />
      ) : null}
      {!nothing || tab === 'bedrock' ? (
        <>
          {nets.length > 1 && (
            <div className="mcn-pickbar"><Seg value={n.id} onChange={setCur} options={nets.map((x) => ({ id: x.id, label: x.name }))} /></div>
          )}
          <Tabs value={current} onChange={setTab} tabs={TABS.map((x) => ({ ...x, label: t(x.label), disabled: !n && NEEDS_NET.includes(x.id), title: !n && NEEDS_NET.includes(x.id) ? t('Create a network first') : undefined, badge: x.id === 'bedrock' && (data.misplaced || []).length ? data.misplaced.length : undefined }))} />
          <div className="mcn-tab">
            {current === 'overview' && n && <Overview n={n} reload={reload} />}
            {current === 'servers' && n && <Servers n={n} free={data.free} reload={reload} />}
            {current === 'players' && n && <Players key={n.id} n={n} reload={reload} />}
            {current === 'bedrock' && <BedrockTab n={n} data={data} reload={reload} />}
            {current === 'versions' && <Versions n={n} data={data} reload={reload} />}
            {current === 'advanced' && n && <Advanced key={n.id} n={n} reload={reload} onRemoved={() => { setCur(null); reload(); }} />}
          </div>
        </>
      ) : null}
      {creating && <NewNetwork data={data} onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); setCur(id); setTab('overview'); reload(); }} />}
    </div>
  );
}

/** Row in every Minecraft server's "Connect" box: which network, Bedrock address – or a pointer to this page. */
function ConnectRow({ s }) {
  const d = useApi('/mc-network', [], { live: false, poll: true });
  if (!d.data) return null;
  const net = d.data.networks.find((x) => x.proxy.id === s.id || x.members.some((m) => m.id === s.id));
  if (net) {
    const b = net.bedrock && net.bedrock.enabled ? net.bedrock : null;
    return (
      <div className="small row-tight mcn-wrap">
        <ShieldCheck size={14} aria-hidden="true" />
        <span className="grow">{net.proxy.id === s.id ? t('Proxy of the network “{name}”', { name: net.name }) : t('Part of the network “{name}” – players connect through the proxy (port {port})', { name: net.name, port: net.proxy.port })}{b ? ` · ${t('Bedrock: port {port} UDP', { port: b.port })}` : ''}</span>
        <a className="btn xs ghost" href="#/ext/mc-network">{t('Open network')}</a>
      </div>
    );
  }
  const g = (d.data.bedrock || []).find((x) => x.id === s.id);
  if (g && g.enabled) return <div className="small row-tight"><Smartphone size={14} aria-hidden="true" /><span className="grow">{t('Bedrock players: port {port} (UDP)', { port: g.port })}</span>{g.port && <CopyBtn text={String(g.port)} label={t('Copy Bedrock port')} />}<a className="btn xs ghost" href="#/ext/mc-network">{t('Settings')}</a></div>;
  if (g && g.supported) return <div className="small row-tight"><Smartphone size={14} aria-hidden="true" /><span className="grow muted">{t('Phone and console players (Bedrock) can join with Geyser.')}</span><Btn className="xs" onClick={async () => { const r = await runJob(`/mc-network/bedrock/${s.id}`, { floodgate: true }); if (r) toast.success(t('Bedrock players can join on port {port}', { port: r.port })); d.reload(); }}>Allow Bedrock</Btn></div>;
  return null;
}

export default {
  pages: { main: NetworkPage },
  slots: { 'mc.connect': [{ id: 'mc-network', title: 'Network & Bedrock', Component: ConnectRow, order: 60 }] },
};
