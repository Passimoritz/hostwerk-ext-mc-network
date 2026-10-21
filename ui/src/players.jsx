import { useState } from 'react';
import { UserPlus, Trash2, ArrowRightLeft, Users, Smartphone } from 'lucide-react';
import { post, put, del } from '@hostwerk/api';
import { Btn, InfoTip, Switch, TileEmpty, toast } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';

/*
 * Players & permissions of a network: who is online where (and moving them), one whitelist, operators and bans for every
 * server of the network. Bedrock names start with the Floodgate prefix (e.g. “.Steve”).
 */
const LISTS = [
  { id: 'players', title: 'Whitelist', empty: 'Nobody on the whitelist yet.', tip: 'Only these players may join when the whitelist is on. Applies to every server of the network.' },
  { id: 'ops', title: 'Operators', empty: 'No operators yet.', tip: 'Operators may use every command on every server of the network (level 4).' },
  { id: 'bans', title: 'Bans', empty: 'Nobody is banned.', tip: 'Banned players cannot join any server of the network.' },
];

function PlayerList({ n, list, entries, prefix, onChange }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { onChange(await post(`/mc-network/net/${n.id}/lists/${list.id}`, { name: name.trim() })); setName(''); } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  const remove = async (p) => { try { onChange(await del(`/mc-network/net/${n.id}/lists/${list.id}/${encodeURIComponent(p.uuid)}`)); } catch (e) { toast.error(e.message); } };
  return (
    <div className="card">
      <div className="card-head"><h3>{t(list.title)}</h3><InfoTip title={t(list.title)}>{t(list.tip)}</InfoTip></div>
      <div className="card-body stack mcn-gap">
        <form className="row-tight" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input className="input sm grow" value={name} maxLength={20} placeholder={prefix ? t('Java name or {p}Bedrock name', { p: prefix }) : t('Java name')} aria-label={t('Player name for {list}', { list: t(list.title) })} onChange={(e) => setName(e.target.value)} />
          <Btn className="sm" icon={UserPlus} busy={busy} disabled={!name.trim()} type="submit">Add</Btn>
        </form>
        {entries.length === 0 ? <div className="small muted">{t(list.empty)}</div> : (
          <ul className="mcn-list">
            {entries.map((p) => (
              <li key={p.uuid}>
                {p.bedrock ? <Smartphone size={13} aria-label={t('Bedrock player')} /> : <Users size={13} aria-hidden="true" />}
                <span className="grow ellipsis">{p.name}{p.reason ? <span className="tiny muted"> · {p.reason}</span> : null}</span>
                <button type="button" className="btn ghost xs icon" title={t('Remove')} aria-label={t('Remove {name}', { name: p.name })} onClick={() => remove(p)}><Trash2 /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Online({ n, reload }) {
  const open = n.members.filter((m) => !m.maintenance);
  const all = n.members.flatMap((m) => (m.players || []).map((p) => ({ p, m })));
  const send = async (player, to, from) => { try { const r = await post(`/mc-network/net/${n.id}/send`, { player, to, from }); toast.success(t('{n} moved', { n: r.moved.length })); reload(); } catch (e) { toast.error(e.message); } };
  return (
    <div className="card">
      <div className="card-head"><h3>Online now</h3><span className="small muted">{all.length}</span></div>
      {all.length === 0 ? <TileEmpty icon={Users} text={t('Nobody is online right now.')} /> : (
        <ul className="mcn-list card-body">
          {all.map(({ p, m }) => (
            <li key={`${m.id}:${p}`}>
              <span className="grow ellipsis"><b>{p}</b> <span className="tiny muted">{t('on {server}', { server: m.name })}</span></span>
              <ArrowRightLeft size={13} aria-hidden="true" />
              <select className="input xs mcn-select" aria-label={t('Move {name} to', { name: p })} value="" onChange={(e) => e.target.value && send(p, e.target.value)}>
                <option value="">{t('Move to …')}</option>
                {open.filter((x) => x.id !== m.id).map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
              </select>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Players({ n, reload }) {
  const [lists, setLists] = useState(n.lists);
  const prefix = n.bedrock && n.bedrock.floodgate ? n.bedrock.prefix : null;
  const whitelist = async (on) => { try { setLists(await put(`/mc-network/net/${n.id}/whitelist`, { on })); toast.success(on ? t('Whitelist on for the whole network') : t('Whitelist off')); } catch (e) { toast.error(e.message); } };
  return (
    <div className="stack">
      <div className="card">
        <div className="card-body setting-row">
          <div className="txt"><b>Whitelist for the whole network</b><span>Only players on the list may join – on every server.</span></div>
          <Switch checked={!!lists.whitelist} onChange={whitelist} />
        </div>
      </div>
      <div className="grid grid-2 mcn-grid">
        <Online n={n} reload={reload} />
        {LISTS.map((l) => <PlayerList key={l.id} n={n} list={l} entries={lists[l.id] || []} prefix={prefix} onChange={setLists} />)}
      </div>
    </div>
  );
}
