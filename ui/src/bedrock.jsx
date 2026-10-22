import { useEffect, useState } from 'react';
import { Smartphone, Power, RefreshCw, RotateCw, Network, Box, Play, Square, Download, Trash2, BookOpen, ArrowRightLeft, ScrollText, Plus, ExternalLink, MonitorSmartphone } from 'lucide-react';
import { get, post, put, del, useApi } from '@hostwerk/api';
import { Btn, Callout, InfoTip, Seg, Switch, SettingRow, StatusPill, TileEmpty, Modal, Field, toast, confirmDialog } from '@hostwerk/ui';
import { t, pl } from '@hostwerk/i18n';
import { runJob, when } from './common';

/*
 * Bedrock players (phone, console, Windows) – three ways, explained side by side:
 *   Geyser on the proxy (whole network) · Geyser on a single server · own Bedrock Dedicated Server (separate world).
 */

function Ways() {
  return (
    <div className="grid grid-auto mcn-grid">
      <div className="card"><div className="card-body stack mcn-gap"><b><Network size={14} aria-hidden="true" /> Geyser on the proxy</b><span className="small muted">Bedrock and Java players play together in the whole network. Geyser translates, Floodgate lets Bedrock players in without a Java account. Recommended for networks.</span></div></div>
      <div className="card"><div className="card-body stack mcn-gap"><b><Box size={14} aria-hidden="true" /> Geyser on one server</b><span className="small muted">The same for a single server without a proxy (Paper, Purpur, Folia, Spigot, Fabric, NeoForge).</span></div></div>
      <div className="card"><div className="card-body stack mcn-gap"><b><MonitorSmartphone size={14} aria-hidden="true" /> Geyser Standalone</b><span className="small muted">For Vanilla, Forge and own JARs, which cannot load Geyser: Geyser runs as its own program in front of the server. Without Floodgate, Bedrock players need a Java account.</span></div></div>
      <div className="card"><div className="card-body stack mcn-gap"><b><Smartphone size={14} aria-hidden="true" /> Bedrock Dedicated Server</b><span className="small muted">Mojang’s own server: a separate Bedrock world, only Bedrock players, everything exactly like Bedrock (add-ons, redstone). No Java players.</span></div></div>
    </div>
  );
}

/** Settings of a Geyser installation: server list entry, names, login. */
function GeyserSettings({ st, onSaved }) {
  const [f, setF] = useState(st.settings);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setF(st.settings); }, [st.id, st.build]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF({ ...f, [k]: e && e.target ? e.target.value : e });
  const save = async () => { setBusy(true); try { await put(`/mc-network/bedrock/${st.id}/settings`, f); toast.success(st.running ? t('Saved – applies after a restart') : t('Saved')); onSaved(); } catch (e) { toast.error(e.message); } setBusy(false); };
  const pack = async (on) => { try { await put(`/mc-network/bedrock/${st.id}/optional-pack`, { on }); toast.success(on ? t('GeyserOptionalPack added') : t('GeyserOptionalPack removed')); onSaved(); } catch (e) { toast.error(e.message); } };
  return (
    <div className="stack mcn-gap">
      <SettingRow title={t('Show the Java MOTD')} text={t('Bedrock players see the same server text as Java players.')}><Switch checked={!!f.passthrough} onChange={set('passthrough')} /></SettingRow>
      {!f.passthrough && <div className="form-grid">
        <Field label={t('First line')}><input className="input sm" maxLength={80} value={f.motd1} onChange={set('motd1')} /></Field>
        <Field label={t('Second line')}><input className="input sm" maxLength={80} value={f.motd2} onChange={set('motd2')} /></Field>
      </div>}
      <div className="form-grid">
        <Field label={t('Server name (pause menu)')}><input className="input sm" maxLength={40} value={f.serverName} onChange={set('serverName')} /></Field>
        <Field label={t('Players shown as maximum')}><input className="input sm" type="number" min={1} max={10000} value={f.maxPlayers} onChange={set('maxPlayers')} /></Field>
        {st.floodgate && <Field label={t('Prefix for Bedrock names')} hint={t('Keeps Bedrock and Java names apart, e.g. “.Steve”.')}><input className="input sm" maxLength={3} value={f.prefix} onChange={set('prefix')} /></Field>}
        {st.floodgate && <Field label={t('Login')}><select className="input sm" value={f.authType} onChange={set('authType')}><option value="floodgate">{t('Without a Java account (Floodgate)')}</option><option value="online">{t('Java account needed')}</option></select></Field>}
      </div>
      <SettingRow title={t('Show coordinates')} text={t('Bedrock players see their position on screen.')}><Switch checked={!!f.showCoordinates} onChange={set('showCoordinates')} /></SettingRow>
      <SettingRow title={t('Xbox achievements')} text={t('Bedrock players can earn achievements (commands are blocked for them then).')}><Switch checked={!!f.xboxAchievements} onChange={set('xboxAchievements')} /></SettingRow>
      <SettingRow title="GeyserOptionalPack" text={t('A resource pack that makes Java things look right on Bedrock (armour stands, hit boxes, shields).')}><Switch checked={!!st.optionalPack} onChange={pack} /></SettingRow>
      <div className="row-tight"><Btn className="sm primary" busy={busy} onClick={save}>Save</Btn></div>
    </div>
  );
}

/** Geyser on a proxy or a single server: switch on/off, state, settings, servers behind the proxy. */
export function GeyserCard({ st, title, reload }) {
  const [busy, setBusy] = useState(null);
  const [open, setOpen] = useState(false);
  const enable = async (online) => { setBusy('on'); const r = await runJob(`/mc-network/bedrock/${st.id}`, { floodgate: !online }); setBusy(null); if (r) toast.success(r.restartNeeded ? t('Bedrock is ready on port {port} – applies after a restart', { port: r.port }) : t('Bedrock players can join on port {port}', { port: r.port })); reload(); };
  const disable = async () => {
    if (!(await confirmDialog({ title: t('Switch off Bedrock access?'), text: t('Geyser and Floodgate are removed together with their settings. Floodgate on the servers behind the proxy goes too.'), confirm: t('Switch off'), danger: true }))) return;
    setBusy('off'); try { await del(`/mc-network/bedrock/${st.id}`); reload(); } catch (e) { toast.error(e.message); } setBusy(null);
  };
  const check = async () => { setBusy('check'); try { await post(`/mc-network/bedrock/${st.id}/update`); toast.success(t('Checked for updates')); reload(); } catch (e) { toast.error(e.message); } setBusy(null); };
  const sync = async () => { setBusy('sync'); try { const r = await post(`/mc-network/bedrock/${st.id}/sync`); const bad = r.servers.filter((x) => !x.ok); if (bad.length) toast.error(bad.map((x) => `${x.name}: ${x.why}`).join(' · ')); else toast.success(t('Floodgate and the key are on every server')); reload(); } catch (e) { toast.error(e.message); } setBusy(null); };
  const restart = async () => { setBusy('restart'); try { await post(`/mc-network/bedrock/${st.id}/restart`); toast.success(t('Restarted')); reload(); } catch (e) { toast.error(e.message); } setBusy(null); };
  if (!st.supported) return <div className="card"><div className="card-head"><h3>{title}</h3></div><div className="card-body small muted">{st.why}</div></div>;
  return (
    <div className="card">
      <div className="card-head"><Smartphone size={16} aria-hidden="true" /><h3 className="ellipsis">{title}</h3>
        {st.enabled ? <span className="badge ok">{t('on · port {port} UDP', { port: st.port })}</span> : <span className="badge">{t('off')}</span>}
      </div>
      <div className="card-body stack mcn-gap">
        {!st.enabled ? (
          <>
            <span className="small muted">{st.proxy ? t('Geyser and Floodgate once on the proxy – Bedrock players reach every server of the network.') : t('Geyser and Floodgate directly on this server.')}</span>
            <div className="row-tight mcn-wrap">
              <Btn className="sm primary" icon={Power} busy={busy === 'on'} disabled={!!busy} onClick={() => enable(false)}>Allow Bedrock players</Btn>
              <Btn className="sm ghost" disabled={!!busy} onClick={() => enable(true)} title={t('Bedrock players also need a Java account (no Floodgate)')}>Only with a Java account</Btn>
            </div>
          </>
        ) : (
          <>
            <div className="small muted">{[st.build && t('Geyser {b}', { b: st.build }), st.floodgateBuild && t('Floodgate {b}', { b: st.floodgateBuild }), st.checkedAt && t('checked {when}', { when: when(st.checkedAt) })].filter(Boolean).join(' · ')}</div>
            {st.pending && <Callout kind="info" dismissible={false}>{t('A new build waits – it is put in as soon as nobody is online.')}</Callout>}
            {st.held && <Callout kind="warn" dismissible={false}>{t('The Geyser update waits: {list} run an older Minecraft version than Geyser {v} speaks. Switch on ViaVersion (Versions tab) – or let Hostwerk do it by itself.', { list: st.held.servers.join(', '), v: st.held.target })}</Callout>}
            {st.failed && st.failed.geyser && <div className="tiny muted">{t('Build {b} did not start and was rolled back – Hostwerk waits for a newer one.', { b: st.failed.geyser })}</div>}
            {st.restartNeeded && <div className="mcn-note row-tight"><span className="grow small">{t('Changes apply after a restart (Hostwerk does it by itself as soon as nobody plays).')}</span><Btn className="xs" icon={RotateCw} busy={busy === 'restart'} onClick={restart}>Restart now</Btn></div>}
            {st.bedrockPlayers && st.bedrockPlayers.length > 0 && <div className="small">{t('Bedrock players online: {names}', { names: st.bedrockPlayers.join(', ') })}</div>}
            {st.backends && st.backends.length > 0 && (
              <div className="stack mcn-gap">
                <div className="small"><b>Floodgate key on the servers</b> <InfoTip title={t('Floodgate key')}>Every server behind the proxy needs Floodgate with the same key as the proxy – otherwise it kicks Bedrock players. Hostwerk puts it there and keeps it the same.</InfoTip></div>
                <ul className="mcn-list">
                  {st.backends.map((b) => <li key={b.id}><span className={`badge ${b.key ? 'ok' : b.supported ? 'warn' : ''}`}>{b.key ? t('key ok') : b.supported ? t('key missing') : t('not possible')}</span><span className="grow ellipsis small">{b.name}</span></li>)}
                </ul>
              </div>
            )}
            {open && <GeyserSettings st={st} onSaved={reload} />}
            <div className="row-tight mcn-wrap">
              <Btn className="xs ghost" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? t('Close settings') : t('Settings')}</Btn>
              <Btn className="xs ghost" icon={RefreshCw} busy={busy === 'check'} onClick={check}>Check for updates</Btn>
              {st.proxy && <Btn className="xs ghost" icon={Network} busy={busy === 'sync'} onClick={sync}>Sync servers</Btn>}
              <div className="grow" />
              <Btn className="xs ghost" icon={Power} busy={busy === 'off'} onClick={disable}>Switch off</Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- Geyser Standalone ---------------- */

function StandaloneLog({ id }) {
  const l = useApi(`/mc-network/standalone/${id}/log?n=60`, [id], { live: true, poll: true });
  return <pre className="mcn-log" tabIndex={0} aria-label={t('Console')}>{(l.data || []).map((x) => x.l).join('\n') || t('No output yet.')}</pre>;
}

/** Geyser as its own program in front of a Java server without plugin support. */
export function StandaloneCard({ st, reload }) {
  const [busy, setBusy] = useState(null);
  const [log, setLog] = useState(false);
  const run = async (action) => { setBusy(action); try { await post(`/mc-network/standalone/${st.id}/run/${action}`); reload(); } catch (e) { toast.error(e.message); } setBusy(null); };
  const check = async () => { setBusy('check'); try { await post(`/mc-network/bedrock/${st.id}/update`); reload(); } catch (e) { toast.error(e.message); } setBusy(null); };
  const update = async () => { setBusy('update'); const r = await runJob(`/mc-network/standalone/${st.id}/update`, {}); setBusy(null); if (r) toast.success(r.upToDate ? t('Already up to date') : t('Geyser {b} runs', { b: r.build })); reload(); };
  const disable = async () => {
    if (!(await confirmDialog({ title: t('Switch off Geyser Standalone?'), text: t('Geyser stops and its folder is removed. The Java server stays as it is.'), confirm: t('Switch off'), danger: true }))) return;
    setBusy('off'); try { await del(`/mc-network/bedrock/${st.id}`); reload(); } catch (e) { toast.error(e.message); } setBusy(null);
  };
  const state = st.running ? (st.ready ? 'running' : 'starting') : st.state === 'error' ? 'error' : 'stopped';
  return (
    <div className="card">
      <div className="card-head"><MonitorSmartphone size={16} aria-hidden="true" /><h3 className="ellipsis">{st.name}</h3><StatusPill state={state} />
        <span className="badge ok">{t('port {port} UDP', { port: st.port })}</span>
        <InfoTip title="Geyser Standalone">Geyser runs as its own program and connects to the server like a Java player. It starts and stops together with the server. Without Floodgate (needs a plugin or mod) Bedrock players sign in once with a Java account.</InfoTip>
      </div>
      <div className="card-body stack mcn-gap">
        <div className="small muted">{[st.build && t('Geyser {b}', { b: st.build }), st.authType === 'offline' ? t('offline server – no account check') : t('Java account needed'), st.checkedAt && t('checked {when}', { when: when(st.checkedAt) })].filter(Boolean).join(' · ')}</div>
        {st.failed && <div className="tiny muted">{t('Build {b} did not start and was rolled back – Hostwerk waits for a newer one.', { b: st.failed })}</div>}
        {st.latest && st.build && st.latest !== st.build && st.latest !== st.failed && <Callout kind="info" dismissible={false}>{t('Geyser {b} is out – it is put in as soon as nobody plays.', { b: st.latest })}</Callout>}
        {!st.serverRunning && <div className="small muted">{t('Starts together with the server.')}</div>}
        {log && <StandaloneLog id={st.id} />}
        <div className="row-tight mcn-wrap">
          {st.running ? <Btn className="xs ghost" icon={RotateCw} busy={busy === 'restart'} onClick={() => run('restart')}>Restart Geyser</Btn> : <Btn className="xs ghost" icon={Play} busy={busy === 'start'} onClick={() => run('start')}>Start Geyser</Btn>}
          <Btn className="xs ghost" icon={ScrollText} onClick={() => setLog(!log)} aria-expanded={log}>Console</Btn>
          <Btn className="xs ghost" icon={RefreshCw} busy={busy === 'check'} onClick={check}>Check for updates</Btn>
          <Btn className="xs ghost" icon={Download} busy={busy === 'update'} onClick={update}>Update now</Btn>
          <div className="grow" />
          <Btn className="xs ghost" icon={Power} busy={busy === 'off'} onClick={disable}>Switch off</Btn>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Bedrock Dedicated Server ---------------- */

function NewBds({ onClose, onDone }) {
  const [f, setF] = useState({ name: 'Bedrock', gamemode: 'survival', difficulty: 'normal', public: false, eula: false });
  const [busy, setBusy] = useState(false);
  const create = async () => { setBusy(true); const r = await runJob('/mc-network/bds', f, t('Bedrock server ready')); setBusy(false); if (r) onDone(); };
  return (
    <Modal title={t('New Bedrock Dedicated Server')} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" busy={busy} disabled={!f.eula || !f.name.trim()} onClick={create}>Create</Btn></>}>
      <div className="stack">
        <span className="small muted">Downloads Mojang’s official server (about 100 MB) and keeps it up to date by itself – Bedrock players can only join a server with their app version.</span>
        <div className="form-grid">
          <Field label={t('Name')}><input className="input" value={f.name} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label={t('Game mode')}><select className="input" value={f.gamemode} onChange={(e) => setF({ ...f, gamemode: e.target.value })}><option value="survival">{t('Survival')}</option><option value="creative">{t('Creative')}</option><option value="adventure">{t('Adventure')}</option></select></Field>
          <Field label={t('Difficulty')}><select className="input" value={f.difficulty} onChange={(e) => setF({ ...f, difficulty: e.target.value })}><option value="peaceful">{t('Peaceful')}</option><option value="easy">{t('Easy')}</option><option value="normal">{t('Normal')}</option><option value="hard">{t('Hard')}</option></select></Field>
        </div>
        <SettingRow title={t('Reachable from outside')} text={t('Opens its UDP ports in the firewall and (with “Router & port forwarding”) in the router.')}><Switch checked={f.public} onChange={(v) => setF({ ...f, public: v })} /></SettingRow>
        <label className="check small"><input type="checkbox" checked={f.eula} onChange={(e) => setF({ ...f, eula: e.target.checked })} /> {t('I accept the Minecraft EULA and Mojang’s privacy policy.')} <a href="https://www.minecraft.net/eula" target="_blank" rel="noreferrer">{t('Read the EULA')}</a></label>
      </div>
    </Modal>
  );
}

function BdsLog({ id }) {
  const l = useApi(`/mc-network/bds/${id}/log?n=60`, [id], { live: true, poll: true });
  const [cmd, setCmd] = useState('');
  const send = async () => { if (!cmd.trim()) return; try { await post(`/mc-network/bds/${id}/command`, { command: cmd }); setCmd(''); setTimeout(() => l.reload({ silent: true }), 800); } catch (e) { toast.error(e.message); } };
  return (
    <div className="stack mcn-gap">
      <pre className="mcn-log" tabIndex={0} aria-label={t('Console')}>{(l.data || []).map((x) => x.l).join('\n') || t('No output yet.')}</pre>
      <form className="row-tight" onSubmit={(e) => { e.preventDefault(); send(); }}><input className="input sm grow mono" value={cmd} placeholder={t('Command, e.g. list')} aria-label={t('Command')} onChange={(e) => setCmd(e.target.value)} /><Btn className="sm" type="submit">Send</Btn></form>
    </div>
  );
}

function BdsCard({ b, reload, coreBds }) {
  const [busy, setBusy] = useState(null);
  const [view, setView] = useState(null); // 'settings' | 'log'
  const [f, setF] = useState(b.settings || {});
  useEffect(() => { setF(b.settings || {}); }, [b.id, b.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (action) => { setBusy(action); try { await post(`/mc-network/bds/${b.id}/run/${action}`); reload(); } catch (e) { toast.error(e.message); } setBusy(null); };
  const update = async () => { setBusy('update'); const r = await runJob(`/mc-network/bds/${b.id}/update`, {}); setBusy(null); if (r) toast.success(r.upToDate ? t('Already up to date') : t('Updated to {v}', { v: r.version })); reload(); };
  const save = async (patch) => { try { const r = await put(`/mc-network/bds/${b.id}`, patch); toast.success(r.restartNeeded ? t('Saved – applies after a restart') : t('Saved')); reload(); } catch (e) { toast.error(e.message); } };
  const remove = async () => {
    const a = await confirmDialog({ title: t('Remove “{name}”?', { name: b.name }), text: t('The server is removed from Hostwerk.'), confirm: t('Remove'), danger: true, checkbox: { label: t('Also delete its files and worlds'), checked: false } });
    if (!a || !a.ok) return;
    try { await del(`/mc-network/bds/${b.id}${a.checked ? '?files=1' : ''}`); reload(); } catch (e) { toast.error(e.message); }
  };
  const st = b.running ? (b.ready ? 'running' : 'starting') : b.state === 'error' ? 'error' : 'stopped';
  return (
    <div className="card">
      <div className="card-head"><Smartphone size={16} aria-hidden="true" /><h3 className="ellipsis">{b.name}</h3><StatusPill state={st} />
        <span className="small muted">{[b.version, t('port {port} UDP', { port: b.port }), b.public ? t('public') : null].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="card-body stack mcn-gap">
        {b.players.length > 0 && <div className="small">{pl(b.players.length, '{n} player online', '{n} players online')}: {b.players.join(', ')}</div>}
        {b.failed && <div className="tiny muted">{t('Version {v} did not start and was rolled back – Hostwerk waits for a newer one.', { v: b.failed })}</div>}
        {b.latest && b.version && b.latest !== b.version && b.latest !== b.failed && <Callout kind="info" dismissible={false}>{t('Version {v} is out – it is installed as soon as nobody plays.', { v: b.latest })}</Callout>}
        {view === 'settings' && (
          <div className="stack mcn-gap">
            <div className="form-grid">
              <Field label={t('Server name')}><input className="input sm" value={f['server-name'] || ''} onChange={(e) => setF({ ...f, 'server-name': e.target.value })} /></Field>
              <Field label={t('Game mode')}><select className="input sm" value={f.gamemode || 'survival'} onChange={(e) => setF({ ...f, gamemode: e.target.value })}><option value="survival">{t('Survival')}</option><option value="creative">{t('Creative')}</option><option value="adventure">{t('Adventure')}</option></select></Field>
              <Field label={t('Difficulty')}><select className="input sm" value={f.difficulty || 'normal'} onChange={(e) => setF({ ...f, difficulty: e.target.value })}><option value="peaceful">{t('Peaceful')}</option><option value="easy">{t('Easy')}</option><option value="normal">{t('Normal')}</option><option value="hard">{t('Hard')}</option></select></Field>
              <Field label={t('Max players')}><input className="input sm" type="number" min={1} max={200} value={f['max-players'] || 10} onChange={(e) => setF({ ...f, 'max-players': e.target.value })} /></Field>
              <Field label={t('New players are')}><select className="input sm" value={f['default-player-permission-level'] || 'member'} onChange={(e) => setF({ ...f, 'default-player-permission-level': e.target.value })}><option value="visitor">{t('Visitors')}</option><option value="member">{t('Members')}</option><option value="operator">{t('Operators')}</option></select></Field>
            </div>
            <SettingRow title={t('Xbox login required')} text={t('Players must be signed in with a Microsoft account (recommended).')}><Switch checked={f['online-mode'] !== 'false'} onChange={(v) => setF({ ...f, 'online-mode': v })} /></SettingRow>
            <SettingRow title={t('Allow list')} text={t('Only players on allowlist.json may join.')}><Switch checked={f['allow-list'] === 'true' || f['allow-list'] === true} onChange={(v) => setF({ ...f, 'allow-list': v })} /></SettingRow>
            <SettingRow title={t('Cheats')} text={t('Commands for operators.')}><Switch checked={f['allow-cheats'] === 'true' || f['allow-cheats'] === true} onChange={(v) => setF({ ...f, 'allow-cheats': v })} /></SettingRow>
            <SettingRow title={t('Reachable from outside')} text={t('Firewall and router (UDP {a} and {b}).', { a: b.port, b: b.portv6 })}><Switch checked={b.public} onChange={(v) => save({ public: v })} /></SettingRow>
            <SettingRow title={t('Start with Hostwerk')}><Switch checked={b.autostart} onChange={(v) => save({ autostart: v })} /></SettingRow>
            <div className="row-tight"><Btn className="sm primary" onClick={() => save(f)}>Save</Btn></div>
          </div>
        )}
        {view === 'log' && <BdsLog id={b.id} />}
        <div className="row-tight mcn-wrap">
          {b.running ? <Btn className="xs" icon={Square} busy={busy === 'stop'} onClick={() => run('stop')}>Stop</Btn> : <Btn className="xs primary" icon={Play} busy={busy === 'start'} disabled={!b.installed} onClick={() => run('start')}>Start</Btn>}
          {b.running && <Btn className="xs ghost" icon={RotateCw} busy={busy === 'restart'} onClick={() => run('restart')}>Restart</Btn>}
          <Btn className="xs ghost" onClick={() => setView(view === 'settings' ? null : 'settings')} aria-expanded={view === 'settings'}>Settings</Btn>
          <Btn className="xs ghost" icon={ScrollText} onClick={() => setView(view === 'log' ? null : 'log')} aria-expanded={view === 'log'}>Console</Btn>
          <Btn className="xs ghost" icon={Download} busy={busy === 'update'} onClick={update}>Update now</Btn>
          <div className="grow" />
          {coreBds && <Btn className="xs" icon={ArrowRightLeft} busy={busy === 'move'} onClick={async () => { setBusy('move'); try { const r = await post(`/mc-network/bds/${b.id}/to-core`); toast.success(t('Moved – now under Minecraft')); location.hash = `/mc/${r.id}`; } catch (e) { toast.error(e.message); } setBusy(null); }}>Move to Minecraft</Btn>}
          <button type="button" className="btn ghost xs icon" title={t('Remove')} aria-label={t('Remove {name}', { name: b.name })} onClick={remove}><Trash2 /></button>
        </div>
      </div>
    </div>
  );
}

const PLATFORMS = [{ id: 'phone', label: 'Phone & Windows' }, { id: 'console', label: 'Xbox, PlayStation, Switch' }];
function Guide() {
  const [p, setP] = useState('phone');
  return (
    <div className="card">
      <div className="card-head"><BookOpen size={16} aria-hidden="true" /><h3>How friends join with Bedrock</h3></div>
      <div className="card-body stack mcn-gap">
        <Seg value={p} onChange={setP} options={PLATFORMS.map((x) => ({ ...x, label: t(x.label) }))} />
        {p === 'phone' ? (
          <ol className="mcn-steps small">
            <li>Open Minecraft → Play → Servers.</li>
            <li>Scroll down to “Add server”.</li>
            <li>Enter any name, the address and the port (see “Addresses for friends”), save and join.</li>
          </ol>
        ) : (
          <ol className="mcn-steps small">
            <li>Consoles only list featured servers. Easiest detour: set the console’s DNS server to a public BedrockConnect server (see its website).</li>
            <li>Start Minecraft → Servers → join any featured server – a server list appears instead.</li>
            <li>Choose “Connect to a server” and enter the address and the port.</li>
          </ol>
        )}
      </div>
    </div>
  );
}

export function BedrockTab({ n, data, reload }) {
  const [creating, setCreating] = useState(false);
  const [moving, setMoving] = useState(null);
  const misplaced = (data.misplaced || []).filter((m) => !n || m.proxy === n.proxy.id);
  const solo = data.bedrock || [];
  const move = async (proxy) => { setMoving(proxy); const r = await runJob(`/mc-network/move-to-proxy/${proxy}`, {}); setMoving(null); if (r) toast.success(t('Bedrock now runs on the proxy – same port {port}', { port: r.port })); reload(); };
  const [geyser, setGeyser] = useState(null);
  useEffect(() => { let alive = true; if (n && !n.proxy.missing) get(`/mc-network/bedrock/${n.proxy.id}`).then((x) => alive && setGeyser(x), () => alive && setGeyser(null)); else setGeyser(null); return () => { alive = false; }; }, [n && n.proxy.id, n && n.bedrock && n.bedrock.build, n && n.bedrock && n.bedrock.enabled, data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack">
      <Ways />
      {[...new Set(misplaced.map((m) => m.proxy))].map((proxy) => {
        const list = misplaced.filter((m) => m.proxy === proxy);
        return (
          <Callout key={proxy} kind="warn" dismissible={false} title={t('Geyser runs behind the proxy “{name}”', { name: list[0].proxyName })}>
            {t('{list} run Geyser themselves (set up with the old “Bedrock bridge”). In a network it belongs on the proxy – once for every server. Hostwerk moves it over with the same port {port} and the same Floodgate key.', { list: list.map((x) => x.name).join(', '), port: list[0].port })}
            {' '}<Btn className="sm" icon={ArrowRightLeft} busy={moving === proxy} onClick={() => move(proxy)}>Move to the proxy</Btn>
          </Callout>
        );
      })}
      <div className="grid grid-2 mcn-grid">
        {n && geyser && <GeyserCard st={geyser} title={t('Network “{name}” (on the proxy)', { name: n.name })} reload={() => { reload(); get(`/mc-network/bedrock/${n.proxy.id}`).then(setGeyser).catch(() => {}); }} />}
        {solo.filter((s) => s.enabled).map((s) => (s.mode === 'standalone' ? <StandaloneCard key={s.id} st={s} reload={reload} /> : <GeyserCard key={s.id} st={s} title={s.name} reload={reload} />))}
        <Guide />
      </div>
      {solo.some((s) => !s.enabled && (s.supported || s.standalonePossible)) && (
        <div className="card">
          <div className="card-head"><h3>Single servers without a proxy</h3></div>
          <ul className="mcn-list card-body">
            {solo.filter((s) => !s.enabled).map((s) => (
              <li key={s.id}><Box size={13} aria-hidden="true" /><span className="grow ellipsis small">{s.name} <span className="tiny muted">{s.type}</span></span>
                {s.supported ? <Btn className="xs" onClick={async () => { const r = await runJob(`/mc-network/bedrock/${s.id}`, { floodgate: true }); if (r) toast.success(t('Bedrock players can join on port {port}', { port: r.port })); reload(); }}>Allow Bedrock</Btn>
                  : s.standalonePossible ? <Btn className="xs" title={t('Geyser as its own program in front of the server – Bedrock players need a Java account')} onClick={async () => { const r = await runJob(`/mc-network/standalone/${s.id}`, {}); if (r) toast.success(t('Bedrock players can join on port {port}', { port: r.port })); reload(); }}>Geyser Standalone</Btn>
                  : <span className="tiny muted" title={s.why}>{t('not possible')}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="card">
        <div className="card-head"><Smartphone size={16} aria-hidden="true" /><h3>Bedrock Dedicated Servers</h3>
          <InfoTip title={t('Bedrock Dedicated Server')}>Mojang’s official server for the Bedrock edition. Its own world, only Bedrock players. Hostwerk installs it, keeps it up to date (with a way back) and shows its console. New ones appear in the Minecraft area like every other server.</InfoTip>
          <div className="right"><Btn className="sm" icon={Plus} onClick={() => setCreating(true)}>New Bedrock server</Btn></div>
        </div>
        {(data.bds || []).length === 0 && (data.coreBds || []).length === 0 && <TileEmpty icon={Smartphone} text={t('No Bedrock Dedicated Server yet.')} />}
        {(data.coreBds || []).length > 0 && (
          <ul className="mcn-list card-body">
            {data.coreBds.map((b) => (
              <li key={b.id}><StatusPill state={b.state === 'running' && !b.ready ? 'starting' : b.state} /><span className="grow ellipsis small">{b.name} <span className="tiny muted">{[b.version, t('port {port} UDP', { port: b.port }), b.players.length ? pl(b.players.length, '{n} player online', '{n} players online') : null].filter(Boolean).join(' · ')}</span></span>
                <a className="btn xs ghost" href={`#/mc/${b.id}`}><ExternalLink aria-hidden="true" />{t('Open')}</a>
              </li>
            ))}
          </ul>
        )}
      </div>
      {data.bdsCore && (data.bds || []).length > 0 && <Callout kind="info" dismissible={false} title={t('Bedrock servers now live in the Minecraft area')}>{t('Hostwerk knows Bedrock as a server type of its own now – with console, settings, worlds, backups and allow list. Move the servers below there with one click: same worlds, same ports.')}</Callout>}
      {(data.bds || []).length > 0 && <div className="grid grid-2 mcn-grid">{data.bds.map((b) => <BdsCard key={b.id} b={b} reload={reload} coreBds={!!data.bdsCore} />)}</div>}
      {creating && <NewBds onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
    </div>
  );
}
