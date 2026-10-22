import { useEffect, useState } from 'react';
import { Play, Square, RotateCcw, Smartphone, Monitor, Server, Wrench, Users, ShieldCheck } from 'lucide-react';
import { get, useApi } from '@hostwerk/api';
import { Btn, InfoTip, StatusPill, Loading } from '@hostwerk/ui';
import { t, pl } from '@hostwerk/i18n';
import { CheckList, CopyBtn, runJob } from './common';

/*
 * Overview of one network: the picture (Bedrock/Java → proxy → servers), what friends type in, whether everything is set up
 * safely, and starting/stopping in the right order.
 */
const pill = (x) => (x.missing ? 'error' : x.running ? (x.ready === false ? 'starting' : 'running') : 'stopped');

function Node({ icon: Icon, title, sub, state, extra, href }) {
  const body = (
    <>
      <span className="mcn-node-ico" aria-hidden="true"><Icon size={16} /></span>
      <span className="mcn-node-txt"><b className="ellipsis">{title}</b>{sub && <span className="tiny muted ellipsis">{sub}</span>}</span>
      {state && <StatusPill state={state} />}
      {extra}
    </>
  );
  return href ? <a className="mcn-node" href={href}>{body}</a> : <div className="mcn-node">{body}</div>;
}

/** Topology: entrances (Java, Bedrock) → proxy → servers (lobby first). Built from boxes, readable without the lines. */
export function Topology({ n }) {
  return (
    <div className="mcn-topo" role="group" aria-label={t('Network structure')}>
      <div className="mcn-topo-row">
        <Node icon={Monitor} title={t('Java players')} sub={t('port {port} (TCP)', { port: n.proxy.port })} />
        {n.bedrock && n.bedrock.enabled && <Node icon={Smartphone} title={t('Bedrock players')} sub={t('port {port} (UDP) · Geyser', { port: n.bedrock.port })} />}
      </div>
      <div className="mcn-topo-link" aria-hidden="true" />
      <div className="mcn-topo-row">
        <Node icon={ShieldCheck} title={n.proxy.name || t('Proxy')} sub={`${n.kindLabel}${n.proxy.build ? ` #${n.proxy.build}` : ''}`} state={pill(n.proxy)} href={n.proxy.missing ? undefined : `#/mc/${encodeURIComponent(n.proxy.id)}`} />
      </div>
      <div className="mcn-topo-link" aria-hidden="true" />
      <ol className="mcn-topo-row mcn-topo-servers">
        {n.members.map((m) => (
          <li key={m.id}>
            <Node icon={m.maintenance ? Wrench : Server} title={m.name} sub={[m.lobby ? t('lobby') : m.key, m.version, m.maintenance ? t('maintenance') : null].filter(Boolean).join(' · ')} state={pill(m)} href={m.missing ? undefined : `#/mc/${encodeURIComponent(m.id)}`}
              extra={m.players && m.players.length > 0 ? <span className="badge" title={m.players.join(', ')}><Users size={11} aria-hidden="true" /> {m.players.length}</span> : null} />
          </li>
        ))}
      </ol>
    </div>
  );
}

/** What friends type in – Java and Bedrock, at home and from outside. */
function Addresses({ id, bedrock }) {
  const [a, setA] = useState(null);
  useEffect(() => { let alive = true; get(`/mc-network/net/${id}/addresses`).then((x) => alive && setA(x || {}), () => alive && setA({})); return () => { alive = false; }; }, [id, bedrock]);
  if (!a) return <Loading />;
  const row = (label, value, copyLabel) => value && (
    <div className="mcn-addr"><span className="small muted">{label}</span><code className="grow ellipsis">{value}</code><CopyBtn text={value} label={copyLabel} /></div>
  );
  return (
    <div className="stack mcn-gap">
      {a.java && <>
        <div className="small"><b>Java edition</b> <InfoTip title={t('Java edition')}>Multiplayer → Add server → this address. Players switch servers with /server or through the lobby.</InfoTip></div>
        {row(t('At home'), a.java.lan, t('Copy home address (Java)'))}
        {row(t('From outside'), a.java.outside, t('Copy outside address (Java)'))}
        {a.java.forced && a.java.forced.length > 0 && <div className="tiny muted">{t('Direct addresses: {list}', { list: a.java.forced.join(', ') })}</div>}
      </>}
      {a.bedrock && <>
        <div className="small"><b>Bedrock edition</b> <InfoTip title={t('Bedrock edition')}>Play → Servers → Add server: address and port separately. Consoles need a small detour – see the Bedrock tab.</InfoTip></div>
        {row(t('At home'), a.bedrock.lan ? `${a.bedrock.lan} · ${t('port')} ${a.bedrock.port}` : null, t('Copy home address (Bedrock)'))}
        {row(t('From outside'), a.bedrock.outside ? `${a.bedrock.outside} · ${t('port')} ${a.bedrock.port}` : null, t('Copy outside address (Bedrock)'))}
        {a.bedrock.nethernet && <div className="tiny muted">{a.bedrock.webrtcPort ? t('For NetherNet (new Bedrock apps) TCP {port} and UDP {udp} have to be open from outside too – friends still type in only the address and port {port}.', { port: a.bedrock.port, udp: a.bedrock.webrtcPort }) : t('For NetherNet (new Bedrock apps) TCP {port} has to be open from outside too – friends still type in only the address and the port.', { port: a.bedrock.port })}</div>}
      </>}
      {!a.routerAuto && (a.java || a.bedrock) && <div className="tiny muted">{t('From outside, the router has to forward these ports to this PC – the extension “Router & port forwarding” does that by itself.')}</div>}
    </div>
  );
}

export function Overview({ n, reload }) {
  const checks = useApi(`/mc-network/net/${n.id}/checks`, [n.id, n.members.length, n.state], { live: false, poll: true });
  const [busy, setBusy] = useState(null);
  const act = async (action) => { setBusy(action); await runJob(`/mc-network/net/${n.id}/run/${action}`, undefined, { start: t('Network started'), stop: t('Network stopped'), restart: t('Network restarted') }[action]); setBusy(null); reload(); };
  return (
    <div className="grid grid-2 mcn-grid">
      <div className="card mcn-span">
        <div className="card-head"><h3>{n.name}</h3>
          <StatusPill state={n.state === 'partial' ? 'starting' : n.state === 'missing' ? 'error' : n.state} label={n.state === 'partial' ? t('partly running') : undefined} />
          <span className="small muted">{pl(n.players, '{n} player online', '{n} players online')}</span>
          <div className="right row-tight">
            <Btn className="sm primary" icon={Play} busy={busy === 'start'} disabled={!!busy || n.state === 'running'} onClick={() => act('start')}>Start</Btn>
            <Btn className="sm" icon={Square} busy={busy === 'stop'} disabled={!!busy || n.state === 'stopped'} onClick={() => act('stop')}>Stop</Btn>
            <Btn className="sm ghost" icon={RotateCcw} busy={busy === 'restart'} disabled={!!busy} onClick={() => act('restart')} title={t('Restart in order: servers first, the proxy last')}>Restart</Btn>
          </div>
        </div>
        <div className="card-body"><Topology n={n} /></div>
      </div>
      <div className="card">
        <div className="card-head"><h3>Addresses for friends</h3></div>
        <div className="card-body"><Addresses id={n.id} bedrock={n.bedrock && n.bedrock.port} /></div>
      </div>
      <div className="card">
        <div className="card-head"><h3>Checks</h3><InfoTip title={t('Checks')}>Only the proxy may be reachable: it checks accounts and forwards the players. The servers behind it listen on 127.0.0.1 and trust the proxy – Hostwerk checks that this is really so.</InfoTip></div>
        <div className="card-body">{checks.data ? <CheckList items={checks.data} /> : <Loading />}</div>
      </div>
    </div>
  );
}
