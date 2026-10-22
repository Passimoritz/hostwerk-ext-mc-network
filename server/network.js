'use strict';
/*
 * Minecraft server networks: one proxy (Velocity recommended, BungeeCord as alternative) in front of several servers.
 *
 * Security model (the reason a proxy network is set up like this, and nothing else):
 *   - Only the proxy is reachable. It checks accounts (online-mode = true) and hands name + UUID on to the servers.
 *   - The servers behind it listen on 127.0.0.1 only and do not check accounts themselves (online-mode=false) – they trust
 *     the proxy. Velocity proves it with a secret (modern forwarding, forwarding.secret → paper-global.yml); BungeeCord's
 *     legacy forwarding has no secret, so the 127.0.0.1 binding is the only protection there (Hostwerk never forwards
 *     these ports in the router or the firewall – see Hostwerk 3.2 security.publicPorts).
 *
 * Velocity membership (forwarding on each server, 127.0.0.1, [servers] and try) is done by Hostwerk's core
 * (mc.network.apply – the same as the "Network" tab of a Velocity server). This extension adds everything around it:
 * forced hosts, MOTD and icon, player limit, ping passthrough, maintenance per server, shared whitelist/OPs/bans, moving
 * players, start/stop order, checks, addresses, safe proxy updates. BungeeCord networks are set up here completely.
 *
 * Data: settings.mcNetwork.networks = [{ id, name, proxy, kind, members: [{ id, key }], forced: { host: key },
 *   motd1, motd2, showMaxPlayers, pingPassthrough, maintenance: [serverId], lists: { whitelist, players, ops, bans, managed },
 *   via: { auto }, proxyUpdates: { auto, failed } }]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./configs');
const { lanIp, sleep } = require('./bedrock');

const KINDS = { velocity: { label: 'Velocity', type: 'velocity' }, bungeecord: { label: 'BungeeCord', type: 'bungeecord' } };
const PAPERISH = ['paper', 'purpur', 'folia', 'spigot'];
const VELOCITY_OK = ['paper', 'purpur', 'folia', 'fabric', 'neoforge', 'forge'];
const MOJANG = 'https://api.mojang.com/users/profiles/minecraft/';
const XUID = 'https://api.geysermc.org/v2/xbox/xuid/';
const READY_MS = 5 * 60000;

class McNetworks {
  /** host · mc: Hostwerk's Minecraft manager · bedrock: Bedrock · net: { fetchJson, runJob } · opts: { readyMs, pollMs } */
  constructor(host, mc, bedrock, net, opts = {}) {
    this.host = host; this.ctx = host.ctx; this.t = host.t; this.mc = mc; this.bedrock = bedrock; this.net = net;
    this.readyMs = opts.readyMs || READY_MS; this.pollMs = opts.pollMs || 1000;
  }
  get cfg() { const s = this.ctx.settings.get(); if (!s.mcNetwork) s.mcNetwork = { networks: [] }; if (!s.mcNetwork.networks) s.mcNetwork.networks = []; return s.mcNetwork; }
  save() { this.ctx.settings.save(); }
  list() { return this.cfg.networks; }
  get(id) { const n = this.list().find((x) => x.id === id); if (!n) throw this.host.error(404, 'Network not found'); return n; }
  byProxy(proxyId) { return this.list().find((x) => x.proxy === proxyId) || null; }
  srv(id) { try { return this.mc.get(id); } catch { return null; } }
  running(id) { try { return this.mc.proc(id).isRunning(); } catch { return false; } }
  ready(id) { try { const p = this.mc.proc(id); return p.isRunning() && (!p.extra || p.extra.ready === undefined || !!p.extra.ready); } catch { return false; } }
  players(id) { try { const e = this.mc.proc(id).extra || {}; return (e.players || []).map((x) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean); } catch { return []; } }
  dir(id) { return this.mc.dir(id); }

  /* ---------------- Picture of a network ---------------- */

  view(n) {
    const proxy = this.srv(n.proxy);
    const members = (n.members || []).map((m, i) => {
      const s = this.srv(m.id);
      if (!s) return { id: m.id, key: m.key, missing: true, name: m.id };
      return { id: s.id, key: m.key, name: s.name, type: s.type, version: s.version, port: s.port, running: this.running(s.id), ready: this.ready(s.id), players: this.players(s.id), lobby: i === 0, maintenance: (n.maintenance || []).includes(s.id), forced: Object.entries(n.forced || {}).filter(([, k]) => k === m.key).map(([h]) => h) };
    });
    const bedrock = proxy && proxy.geyser ? this.bedrock.status(proxy.id) : null;
    const pp = proxy ? this.players(proxy.id) : [];
    return {
      id: n.id, name: n.name, kind: n.kind, kindLabel: (KINDS[n.kind] || {}).label || n.kind,
      proxy: proxy ? { id: proxy.id, name: proxy.name, type: proxy.type, version: proxy.version, build: proxy.build, port: proxy.port, running: this.running(proxy.id), ready: this.ready(proxy.id), players: pp } : { id: n.proxy, missing: true },
      members, bedrock, settings: this.settingsOf(n), maintenance: n.maintenance || [], forced: n.forced || {},
      players: Math.max(pp.length, members.reduce((x, m) => x + (m.players ? m.players.length : 0), 0)),
      state: !proxy ? 'missing' : this.running(proxy.id) ? (members.every((m) => m.running || m.maintenance) ? 'running' : 'partial') : members.some((m) => m.running) ? 'partial' : 'stopped',
      lists: this.listsView(n), proxyUpdates: { auto: !(n.proxyUpdates && n.proxyUpdates.auto === false), failed: (n.proxyUpdates && n.proxyUpdates.failed) || null, pending: proxy && this.mc.updates && this.mc.updates.get ? ((this.mc.updates.get(proxy.id) || {}).server || null) : null },
      via: { auto: !(n.via && n.via.auto === false) },
    };
  }
  settingsOf(n) { return { motd1: n.motd1 || '', motd2: n.motd2 || '', showMaxPlayers: n.showMaxPlayers ?? 100, pingPassthrough: n.pingPassthrough || 'DISABLED', kickExisting: n.kickExisting !== false }; }
  /** Servers not yet in any network (candidates for adding). */
  free() {
    const used = new Set(this.list().flatMap((n) => [n.proxy, ...(n.members || []).map((m) => m.id)]));
    return this.mc.list().filter((s) => !used.has(s.id) && !this.mc.isProxy(s)).map((s) => ({ id: s.id, name: s.name, type: s.type, version: s.version, port: s.port, running: this.running(s.id), velocity: VELOCITY_OK.includes(s.type), bungee: PAPERISH.includes(s.type), behind: s.network ? s.network.proxy : null }));
  }
  /** Proxies Hostwerk knows that are not a network here yet (e.g. set up in the Minecraft area) – can be taken over. */
  proxies() { return this.mc.list().filter((s) => this.mc.isProxy(s) && !this.byProxy(s.id)).map((s) => ({ id: s.id, name: s.name, type: s.type, members: this.mc.list().filter((x) => x.network && x.network.proxy === s.id).map((x) => ({ id: x.id, name: x.name, key: x.network.key })) })); }

  /* ---------------- Creating, taking over, removing ---------------- */

  /**
   * New network: proxy (new or existing) + servers. body: { name, kind, proxyId?, members: [serverId], lobby: bool }.
   * The first member is the lobby (where players land). With lobby: true a small lobby server is created first.
   */
  create(b = {}) {
    const { t } = this;
    const kind = KINDS[b.kind] ? b.kind : 'velocity';
    const name = String(b.name || '').trim().slice(0, 60) || 'Network';
    const ids = [...new Set((Array.isArray(b.members) ? b.members : []).map(String))];
    if (b.proxyId) { const p = this.srv(b.proxyId); if (!p || !this.mc.isProxy(p)) throw this.host.error(400, 'This is not a proxy.'); if (this.byProxy(p.id)) throw this.host.error(409, 'This proxy already has a network.'); }
    for (const id of ids) { const s = this.srv(id); if (!s) throw this.host.error(404, 'Server not found'); this.assertFits(kind, s); }
    return this.net.runJob(t('Set up network “{name}”', { name }), async (job) => {
      let proxyId = b.proxyId;
      if (!proxyId) {
        job.progress(5, t('Creating the {kind} proxy …', { kind: KINDS[kind].label }));
        const r = await this.mc.create({ type: KINDS[kind].type, name: `${name} Proxy`, eula: true, memMin: 512, memMax: 1024 });
        proxyId = (await r.promise).id;
      }
      const members = [];
      if (b.lobby) {
        job.progress(20, t('Creating the lobby …'));
        const lobbyId = await this.createLobby(name, job);
        members.push(lobbyId);
      }
      members.push(...ids.filter((x) => !members.includes(x)));
      const n = { id: crypto.randomBytes(4).toString('hex'), name, proxy: proxyId, kind, members: [], forced: {}, maintenance: [], createdAt: Date.now() };
      this.list().push(n);
      this.save();
      job.progress(40, t('Connecting the servers …'));
      await this.applyMembers(n, members.map((id) => ({ id, key: this.uniqueKey(n, this.srv(id).name) })), job);
      return { id: n.id };
    }, { key: `mc-network-create-${name.toLowerCase()}` });
  }
  uniqueKey(n, name, own = null) {
    const taken = new Set((n.members || []).filter((m) => m.id !== own).map((m) => m.key));
    let k = C.keyName(name); let i = 2;
    while (taken.has(k)) k = `${C.keyName(name).slice(0, 28)}-${i++}`;
    taken.add(k);
    return k;
  }
  assertFits(kind, s) {
    if (this.mc.isProxy(s)) throw this.host.error(400, this.t('“{name}” is a proxy itself.', { name: s.name }));
    if (kind === 'velocity' && !VELOCITY_OK.includes(s.type)) throw this.host.error(400, this.t('“{name}” ({type}) cannot run behind Velocity – possible are Paper, Purpur, Folia, Fabric, NeoForge and Forge.', { name: s.name, type: s.type }));
    if (kind === 'bungeecord' && !PAPERISH.includes(s.type)) throw this.host.error(400, this.t('“{name}” ({type}) cannot run behind BungeeCord here – possible are Paper, Purpur, Folia and Spigot. Velocity also takes Fabric and NeoForge.', { name: s.name, type: s.type }));
    const other = this.list().find((n) => (n.members || []).some((m) => m.id === s.id));
    if (other && !(this._editing && this._editing === other.id)) throw this.host.error(409, this.t('“{name}” is already in the network “{net}”.', { name: s.name, net: other.name }));
  }
  /** Small Paper lobby: flat, adventure, peaceful, no PvP. */
  async createLobby(netName, job) {
    const r = await this.mc.create({ type: 'paper', name: `${netName} Lobby`, eula: true, memMax: 2048, gamemode: 'adventure', difficulty: 'peaceful', maxPlayers: 100 });
    const res = await r.promise;
    const f = path.join(this.dir(res.id), 'server.properties');
    fs.writeFileSync(f, C.writeProps(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '', { 'level-type': 'minecraft\\:flat', 'generate-structures': 'false', 'spawn-monsters': 'false', pvp: 'false', 'allow-nether': 'false', 'spawn-protection': '0', 'force-gamemode': 'true', motd: `${netName} – Lobby` }));
    if (job) job.log(this.t('Lobby created: flat world, adventure mode, peaceful, no PvP.'));
    return res.id;
  }
  /** Take over a proxy that already exists (e.g. from Hostwerk's Minecraft area) with the servers behind it. */
  adopt(proxyId, { name } = {}) {
    const p = this.srv(proxyId);
    if (!p || !this.mc.isProxy(p)) throw this.host.error(400, 'This is not a proxy.');
    if (this.byProxy(proxyId)) throw this.host.error(409, 'This proxy already has a network.');
    const members = this.mc.list().filter((x) => x.network && x.network.proxy === proxyId).map((x) => ({ id: x.id, key: x.network.key || C.keyName(x.name) }));
    // Order of the lobby/try list from velocity.toml
    try {
      const toml = fs.readFileSync(path.join(this.dir(proxyId), 'velocity.toml'), 'utf8');
      const tr = ((toml.match(/^\s*try\s*=\s*\[([\s\S]*?)\]/m) || [])[1] || '').match(/"([^"]+)"/g) || [];
      const order = tr.map((x) => x.slice(1, -1));
      members.sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99));
    } catch { /* BungeeCord or never started */ }
    const n = { id: crypto.randomBytes(4).toString('hex'), name: String(name || p.name).slice(0, 60), proxy: proxyId, kind: p.type === 'bungeecord' ? 'bungeecord' : 'velocity', members, forced: {}, maintenance: [], createdAt: Date.now() };
    this.list().push(n);
    this.save();
    return this.view(n);
  }
  /** Remove the network here. With release: servers behind it become reachable directly again (previous values back). */
  remove(id, { release = false } = {}) {
    const n = this.get(id);
    const done = () => { this.cfg.networks = this.list().filter((x) => x.id !== id); this.save(); return { ok: true }; };
    if (!release) return done();
    return this.net.runJob(this.t('Dissolve network “{name}”', { name: n.name }), async (job) => { await this.applyMembers(n, [], job); return done(); }, { key: `mc-network-remove-${id}` });
  }
  rename(id, name) { const n = this.get(id); n.name = String(name || '').trim().slice(0, 60) || n.name; this.save(); return this.view(n); }

  /* ---------------- Members ---------------- */

  /** Change members (order = lobby first, then fallback order). body: { members: [{ id, key }] } */
  setMembers(id, b = {}) {
    const n = this.get(id);
    const want = (Array.isArray(b.members) ? b.members : []).map((m) => ({ id: String(m.id), key: C.keyName(m.key || (this.srv(m.id) || {}).name || m.id) }));
    this._editing = n.id;
    try { for (const m of want) { const s = this.srv(m.id); if (!s) throw this.host.error(404, 'Server not found'); this.assertFits(n.kind, s); } } finally { this._editing = null; }
    if (new Set(want.map((m) => m.key)).size !== want.length) throw this.host.error(400, 'Every server needs its own name in the network.');
    return this.net.runJob(this.t('Update network “{name}”', { name: n.name }), (job) => this.applyMembers(n, want, job).then(() => this.view(n)), { key: `mc-network-members-${id}` });
  }

  async applyMembers(n, want, job) {
    // Forced hosts only for servers that stay
    n.forced = Object.fromEntries(Object.entries(n.forced || {}).filter(([, k]) => want.some((m) => m.key === k)));
    n.maintenance = (n.maintenance || []).filter((x) => want.some((m) => m.id === x));
    if (n.kind === 'velocity') {
      if (!this.mc.network || typeof this.mc.network.apply !== 'function') throw new Error(this.t('This Hostwerk version cannot set up Velocity networks.'));
      await this.mc.network.apply(n.proxy, { members: want, forcedHosts: this.forcedFor(n, want) }).promise;
    } else {
      await this.applyBungee(n, want, job);
    }
    n.members = want;
    this.save();
    this.writeProxy(n);
    // Bedrock in the network: Floodgate and the key on new servers too
    const p = this.srv(n.proxy);
    if (p && p.geyser && p.geyser.floodgate) { try { for (const r of await this.bedrock.syncBackends(p.id)) if (job && !r.ok) job.log(`${r.name}: ${r.why}`); } catch (e) { if (job) job.log(e.message); } }
    if (job) job.log(this.t('{n} servers in the network.', { n: want.length }));
    return this.view(n);
  }
  forcedFor(n, want) {
    const keys = new Set(want.map((m) => m.key));
    const out = {};
    for (const [h, k] of Object.entries(n.forced || {})) if (keys.has(k) && !this.inMaintenance(n, k)) out[h] = [k];
    return out;
  }
  inMaintenance(n, key) { const m = (n.members || []).find((x) => x.key === key); return !!m && (n.maintenance || []).includes(m.id); }

  /** BungeeCord: IP forwarding on (spigot.yml), servers on 127.0.0.1 with online-mode=false, config.yml of the proxy. */
  async applyBungee(n, want, job) {
    const all = this.mc.list();
    const wasRunning = new Set(all.filter((s) => this.running(s.id)).map((s) => s.id));
    if (this.running(n.proxy)) await this.mc.stop(n.proxy);
    for (const m of want) {
      const s = this.srv(m.id);
      if (this.running(s.id)) await this.mc.stop(s.id);
      const dir = this.dir(s.id);
      const spigot = path.join(dir, 'spigot.yml');
      fs.writeFileSync(spigot, C.spigotBungeeText(fs.existsSync(spigot) ? fs.readFileSync(spigot, 'utf8') : '', true));
      const pg = path.join(dir, 'config', 'paper-global.yml');
      if (fs.existsSync(pg)) fs.writeFileSync(pg, C.paperProxyText(fs.readFileSync(pg, 'utf8'), { kind: 'bungeecord' }));
      const pf = path.join(dir, 'server.properties');
      const props = C.readProps(fs.existsSync(pf) ? fs.readFileSync(pf, 'utf8') : '');
      if (!(s.network && s.network.proxy === n.proxy)) s.network = { proxy: n.proxy, prevOnline: props['online-mode'] || 'true', prevIp: props['server-ip'] || '' };
      s.network.key = m.key;
      fs.writeFileSync(pf, C.writeProps(fs.existsSync(pf) ? fs.readFileSync(pf, 'utf8') : '', { 'online-mode': 'false', 'server-ip': '127.0.0.1' }));
      if (job) job.log(`✓ ${s.name} → ${m.key} (127.0.0.1:${s.port})`);
    }
    for (const s of all.filter((x) => x.network && x.network.proxy === n.proxy && !want.some((m) => m.id === x.id))) {
      if (this.running(s.id)) await this.mc.stop(s.id);
      const dir = this.dir(s.id);
      const pf = path.join(dir, 'server.properties');
      if (fs.existsSync(pf)) fs.writeFileSync(pf, C.writeProps(fs.readFileSync(pf, 'utf8'), { 'online-mode': s.network.prevOnline || 'true', 'server-ip': s.network.prevIp || '' }));
      const spigot = path.join(dir, 'spigot.yml');
      if (fs.existsSync(spigot)) fs.writeFileSync(spigot, C.spigotBungeeText(fs.readFileSync(spigot, 'utf8'), false));
      delete s.network;
      if (job) job.log(this.t('“{name}” left the network – reachable directly again.', { name: s.name }));
    }
    this.save();
    n.members = want;
    this.writeProxy(n);
    // Start again what ran before – servers first, the proxy last
    for (const id of [...want.map((m) => m.id), n.proxy]) if (wasRunning.has(id)) { try { await this.mc.start(id); } catch (e) { if (job) job.log(`${id}: ${e.message}`); } }
  }

  /* ---------------- Proxy settings ---------------- */

  /** Write Hostwerk's part of the proxy config (MOTD, limits, try/forced hosts without servers in maintenance). */
  writeProxy(n) {
    const p = this.srv(n.proxy);
    if (!p) return false;
    const dir = this.dir(p.id);
    const tryKeys = (n.members || []).filter((m) => !(n.maintenance || []).includes(m.id)).map((m) => m.key);
    if (n.kind === 'velocity') {
      const f = path.join(dir, 'velocity.toml');
      if (!fs.existsSync(f)) return false; // Velocity writes it at its first start – the core starts it once when setting up
      let t = C.velocityTopText(fs.readFileSync(f, 'utf8'), { motd: n.motd1 || n.motd2 ? C.velocityMotd(n.motd1, n.motd2) : undefined, showMaxPlayers: n.showMaxPlayers, pingPassthrough: n.pingPassthrough, kickExisting: n.kickExisting });
      t = C.velocityRouting(t, { tryKeys, forced: this.forcedFor(n, n.members || []) });
      fs.writeFileSync(f, t);
    } else {
      const f = path.join(dir, 'config.yml');
      const servers = (n.members || []).map((m) => ({ key: m.key, port: (this.srv(m.id) || {}).port, motd: (this.srv(m.id) || {}).name, restricted: (n.maintenance || []).includes(m.id) })).filter((x) => x.port);
      const forced = Object.fromEntries(Object.entries(this.forcedFor(n, n.members || [])).map(([h, k]) => [h, k[0]]));
      fs.writeFileSync(f, C.bungeeConfigText({ port: p.port, motd: [n.motd1, n.motd2].filter(Boolean).join('\n') || n.name, maxPlayers: n.showMaxPlayers || 100, servers, tryKeys, forced, pingPassthrough: n.pingPassthrough && n.pingPassthrough !== 'DISABLED' }));
    }
    return true;
  }
  /** Apply proxy settings now: written always; a running proxy reloads them (velocity reload / greload). */
  async reloadProxy(n) {
    const ok = this.writeProxy(n);
    if (ok && this.running(n.proxy)) { try { await this.mc.command(n.proxy, n.kind === 'velocity' ? 'velocity reload' : 'greload'); } catch { /* applies at the next start */ } }
    return ok;
  }
  async setSettings(id, b = {}) {
    const n = this.get(id);
    for (const k of ['motd1', 'motd2']) if (b[k] !== undefined) n[k] = String(b[k]).replace(/[\r\n]/g, ' ').slice(0, 120);
    if (b.showMaxPlayers !== undefined) n.showMaxPlayers = Math.max(0, Math.min(100000, Math.round(Number(b.showMaxPlayers)) || 0));
    if (b.pingPassthrough !== undefined) n.pingPassthrough = C.PING.includes(b.pingPassthrough) ? b.pingPassthrough : 'DISABLED';
    if (b.kickExisting !== undefined) n.kickExisting = !!b.kickExisting;
    if (b.forced !== undefined) {
      const keys = new Set((n.members || []).map((m) => m.key));
      const forced = {};
      for (const [h, k] of Object.entries(b.forced || {})) {
        const host = String(h).trim().toLowerCase();
        if (!host) continue;
        if (!C.validHost(host)) throw this.host.error(400, this.t('“{host}” is not a valid address (e.g. survival.example.org).', { host: h }));
        if (!keys.has(k)) throw this.host.error(400, this.t('“{host}” points to a server that is not in the network.', { host }));
        forced[host] = k;
      }
      n.forced = forced;
    }
    if (b.proxyUpdatesAuto !== undefined) n.proxyUpdates = { ...(n.proxyUpdates || {}), auto: !!b.proxyUpdatesAuto };
    if (b.viaAuto !== undefined) n.via = { ...(n.via || {}), auto: !!b.viaAuto };
    this.save();
    await this.reloadProxy(n);
    return this.view(n);
  }
  /** Server icon of the proxy (64×64 PNG) – what players see in their server list. */
  async setIcon(id, buf) {
    const n = this.get(id);
    const sz = C.pngSize(buf);
    if (!sz.ok) throw this.host.error(400, sz.w ? this.t('The icon has to be 64 × 64 pixels (this one is {w} × {h}).', { w: sz.w, h: sz.h }) : this.t('Please choose a PNG image.'));
    fs.writeFileSync(path.join(this.dir(n.proxy), 'server-icon.png'), buf);
    return { ok: true, restartNeeded: this.running(n.proxy) };
  }
  icon(id) { const n = this.get(id); const f = path.join(this.dir(n.proxy), 'server-icon.png'); return fs.existsSync(f) ? f : null; }

  /* ---------------- Maintenance ---------------- */

  /**
   * Maintenance for one server: it leaves the lobby/fallback order and the forced hosts, players on it go to the lobby,
   * BungeeCord marks it restricted. With stop: the server stops afterwards (nobody can /server into it then).
   */
  async maintenance(id, serverId, on, { stop = false } = {}) {
    const n = this.get(id);
    const m = (n.members || []).find((x) => x.id === serverId);
    if (!m) throw this.host.error(404, 'Server not found');
    const set = new Set(n.maintenance || []);
    if (on) set.add(serverId); else set.delete(serverId);
    if (on && (n.members || []).every((x) => set.has(x.id))) throw this.host.error(400, 'At least one server has to stay open – otherwise players have nowhere to go.');
    n.maintenance = [...set];
    this.save();
    await this.reloadProxy(n);
    const moved = [];
    if (on) {
      const lobby = (n.members || []).find((x) => !set.has(x.id));
      for (const pl of this.players(serverId)) { try { await this.mc.command(n.proxy, `send ${pl} ${lobby.key}`); moved.push(pl); } catch { /* proxy off */ } }
      if (stop && this.running(serverId)) { await sleep(moved.length ? 1500 : 0); await this.mc.stop(serverId); }
    }
    return { ...this.view(n), moved };
  }

  /** Move a player (or everybody on a server: from = server key) to another server of the network. */
  async send(id, { player, to, from } = {}) {
    const n = this.get(id);
    if (!(n.members || []).some((m) => m.key === to)) throw this.host.error(400, 'Unknown target server.');
    if (!this.running(n.proxy)) throw this.host.error(409, 'The proxy is not running.');
    const names = from ? this.players(((n.members || []).find((m) => m.key === from) || {}).id) : [String(player || '')];
    const out = [];
    for (const pl of names) { if (!/^\.?[A-Za-z0-9_*]{2,17}$/.test(pl)) continue; await this.mc.command(n.proxy, `send ${pl} ${to}`); out.push(pl); }
    return { moved: out };
  }

  /* ---------------- Start / stop in order ---------------- */

  async waitReady(id) {
    const until = Date.now() + this.readyMs;
    while (Date.now() < until) { if (this.ready(id)) return true; if (!this.running(id)) return false; await sleep(this.pollMs); }
    return false;
  }
  /** Start: servers first (lobby first, each until it is ready), proxy last. Stop: proxy first. */
  run(id, action) {
    const n = this.get(id);
    if (!['start', 'stop', 'restart'].includes(action)) throw this.host.error(400, 'Unknown action');
    const T = this.t;
    return this.net.runJob(T('{action} network “{name}”', { action: { start: T('Start'), stop: T('Stop'), restart: T('Restart') }[action], name: n.name }), async (job) => {
      const members = (n.members || []).map((m) => m.id).filter((x) => this.srv(x));
      const failed = [];
      const stop = async () => {
        for (const x of [n.proxy, ...members.slice().reverse()]) if (this.running(x)) { job.log(`■ ${(this.srv(x) || {}).name}`); await this.mc.stop(x).catch((e) => failed.push(`${x}: ${e.message}`)); }
      };
      const start = async () => {
        let i = 0;
        for (const x of members) {
          job.progress(Math.round((i++ / (members.length + 1)) * 100), T('Starting {name} …', { name: this.srv(x).name }));
          if ((n.maintenance || []).includes(x)) { job.log(`– ${this.srv(x).name}: ${T('in maintenance, stays off')}`); continue; }
          if (!this.running(x)) { try { await this.mc.start(x); } catch (e) { failed.push(this.srv(x).name); job.log(`✗ ${this.srv(x).name}: ${e.message}`); continue; } }
          if (await this.waitReady(x)) job.log(`✓ ${this.srv(x).name}`); else { failed.push(this.srv(x).name); job.log(`✗ ${this.srv(x).name}: ${T('did not get ready')}`); }
        }
        // The lobby must be there – without it players land nowhere
        if (members[0] && failed.includes((this.srv(members[0]) || {}).name)) throw new Error(T('The lobby did not start – the proxy stays off.'));
        if (!this.running(n.proxy)) await this.mc.start(n.proxy);
        await this.waitReady(n.proxy);
        job.log(`✓ ${this.srv(n.proxy).name}`);
      };
      if (action !== 'start') await stop();
      if (action !== 'stop') await start();
      this.host.broadcast({ type: 'mc-network' });
      if (failed.length) throw new Error(T('Not everything worked: {list}', { list: failed.join(', ') }));
      return { ok: true };
    }, { key: `mc-network-${id}-${action}` });
  }

  /* ---------------- Shared whitelist, operators, bans ---------------- */

  listsCfg(n) { if (!n.lists) n.lists = { whitelist: false, players: [], ops: [], bans: [], managed: {} }; for (const k of ['players', 'ops', 'bans']) if (!Array.isArray(n.lists[k])) n.lists[k] = []; if (!n.lists.managed) n.lists.managed = {}; return n.lists; }
  listsView(n) { const l = this.listsCfg(n); return { whitelist: !!l.whitelist, players: l.players, ops: l.ops, bans: l.bans }; }
  /** Name → { name, uuid, bedrock } – Java through Mojang, Bedrock (Floodgate prefix) through GeyserMC's xuid lookup. */
  async resolve(n, name) {
    const raw = String(name || '').trim();
    const prefix = this.bedrock.prefix(n.proxy);
    const bedrock = !!prefix && raw.startsWith(prefix);
    if (bedrock) {
      const tag = raw.slice(prefix.length);
      if (!/^[A-Za-z0-9 _]{1,16}$/.test(tag)) throw this.host.error(400, this.t('“{name}” is not a valid Bedrock name.', { name: raw }));
      const j = await this.net.fetchJson(`${XUID}${encodeURIComponent(tag)}`).catch(() => null);
      if (!j || !j.xuid) throw this.host.error(404, this.t('Bedrock player “{name}” not found.', { name: tag }));
      return { name: raw, uuid: C.floodgateUuid(j.xuid), bedrock: true };
    }
    if (!/^[A-Za-z0-9_]{2,16}$/.test(raw)) throw this.host.error(400, this.t('“{name}” is not a valid Minecraft name.', { name: raw }));
    const j = await this.net.fetchJson(`${MOJANG}${encodeURIComponent(raw)}`).catch(() => null);
    if (!j || !C.dashUuid(j.id)) throw this.host.error(404, this.t('Java player “{name}” not found.', { name: raw }));
    return { name: j.name || raw, uuid: C.dashUuid(j.id), bedrock: false };
  }
  async listAdd(id, which, name, extra = {}) {
    const n = this.get(id);
    if (!['players', 'ops', 'bans'].includes(which)) throw this.host.error(400, 'Unknown list');
    const l = this.listsCfg(n);
    const p = await this.resolve(n, name);
    l[which] = [...l[which].filter((x) => x.uuid !== p.uuid), { ...p, ...(which === 'bans' ? { reason: String(extra.reason || '').slice(0, 200) || undefined, created: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' +0000' } : {}), at: Date.now() }];
    this.save();
    const r = await this.applyLists(n, { which, change: { add: p } });
    return { ...this.listsView(n), applied: r };
  }
  async listRemove(id, which, uuid) {
    const n = this.get(id);
    const l = this.listsCfg(n);
    const p = (l[which] || []).find((x) => x.uuid === uuid);
    l[which] = (l[which] || []).filter((x) => x.uuid !== uuid);
    this.save();
    const r = await this.applyLists(n, { which, change: p ? { remove: p } : null });
    return { ...this.listsView(n), applied: r };
  }
  async setWhitelist(id, on) { const n = this.get(id); this.listsCfg(n).whitelist = !!on; this.save(); const r = await this.applyLists(n, { which: 'players', toggle: true }); return { ...this.listsView(n), applied: r }; }

  /**
   * Write the lists into every server of the network (files are the truth for stopped servers; running servers get the
   * matching command so it applies right away). Entries of the server itself stay – only the network's own are managed.
   */
  async applyLists(n, { which, change, toggle } = {}) {
    const l = this.listsCfg(n);
    const FILES = { players: ['whitelist.json', 'whitelist'], ops: ['ops.json', 'ops'], bans: ['banned-players.json', 'bans'] };
    const out = [];
    for (const m of n.members || []) {
      const s = this.srv(m.id);
      if (!s) continue;
      const dir = this.dir(s.id);
      const managed = (l.managed[s.id] = l.managed[s.id] || {});
      for (const k of which ? [which] : Object.keys(FILES)) {
        const [file, shape] = FILES[k];
        const f = path.join(dir, file);
        let cur = [];
        try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* none yet */ }
        const r = C.mergeList(cur, l[k], managed[k], C.shapes[shape]);
        fs.writeFileSync(f, JSON.stringify(r.list, null, 2));
        managed[k] = r.managed;
      }
      if (!which || which === 'players') {
        const pf = path.join(dir, 'server.properties');
        if (fs.existsSync(pf)) fs.writeFileSync(pf, C.writeProps(fs.readFileSync(pf, 'utf8'), { 'white-list': String(!!l.whitelist), 'enforce-whitelist': String(!!l.whitelist) }));
      }
      let live = false;
      if (this.running(s.id)) {
        const cmds = [];
        if (which === 'players' || !which) { if (toggle) cmds.push(l.whitelist ? 'whitelist on' : 'whitelist off'); cmds.push('whitelist reload'); }
        if (change && change.add && which === 'ops') cmds.push(`op ${change.add.name}`);
        if (change && change.remove && which === 'ops') cmds.push(`deop ${change.remove.name}`);
        if (change && change.add && which === 'bans') cmds.push(`ban ${change.add.name}`);
        if (change && change.remove && which === 'bans') cmds.push(`pardon ${change.remove.name}`);
        for (const c of cmds) { try { await this.mc.command(s.id, c); live = true; } catch { /* applies at the next start */ } }
      }
      out.push({ id: s.id, name: s.name, live });
    }
    this.save();
    return out;
  }

  /* ---------------- Checks and addresses ---------------- */

  /** Is the network set up safely and completely? → [{ level: 'ok'|'warn'|'err', text, server }] */
  checks(id) {
    const n = this.get(id);
    const T = this.t;
    const out = [];
    const p = this.srv(n.proxy);
    if (!p) return [{ level: 'err', text: T('The proxy server no longer exists.') }];
    const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
    let secret = null;
    if (n.kind === 'velocity') {
      const toml = read(path.join(this.dir(p.id), 'velocity.toml'));
      secret = (read(path.join(this.dir(p.id), 'forwarding.secret')) || '').trim() || null;
      if (!toml) out.push({ level: 'warn', text: T('The proxy has not been set up yet – add a server to the network.') });
      else {
        if (C.tomlTopGet(toml, 'online-mode') === false) out.push({ level: 'err', text: T('The proxy does not check accounts (online-mode = false) – anybody could join with any name.') });
        if (C.tomlTopGet(toml, 'player-info-forwarding-mode') !== 'modern') out.push({ level: 'err', text: T('Velocity does not use modern forwarding.') });
      }
      if (!secret && toml) out.push({ level: 'err', text: T('Velocity has no forwarding secret.') });
    }
    for (const m of n.members || []) {
      const s = this.srv(m.id);
      if (!s) { out.push({ level: 'err', text: T('A server of the network no longer exists ({id}).', { id: m.id }) }); continue; }
      const dir = this.dir(s.id);
      const props = C.readProps(read(path.join(dir, 'server.properties')) || '');
      if (props['server-ip'] !== '127.0.0.1') out.push({ level: 'err', server: s.name, text: T('“{name}” listens on all addresses – it must only be reachable through the proxy (server-ip=127.0.0.1).', { name: s.name }) });
      if (props['online-mode'] !== 'false' && Object.keys(props).length) out.push({ level: 'warn', server: s.name, text: T('“{name}” checks accounts itself – behind a proxy players cannot join (online-mode must be false).', { name: s.name }) });
      if (n.kind === 'velocity' && PAPERISH.includes(s.type)) {
        const pg = read(path.join(dir, 'config', 'paper-global.yml'));
        if (pg && (C.yamlGet(pg, ['proxies', 'velocity', 'enabled']) !== true || String(C.yamlGet(pg, ['proxies', 'velocity', 'secret'])) !== String(secret))) out.push({ level: 'err', server: s.name, text: T('“{name}” does not have the proxy’s forwarding secret.', { name: s.name }) });
      }
      if (n.kind === 'bungeecord') {
        const sp = read(path.join(dir, 'spigot.yml'));
        if (sp && C.yamlGet(sp, ['settings', 'bungeecord']) !== true) out.push({ level: 'err', server: s.name, text: T('“{name}” does not accept BungeeCord’s forwarding (spigot.yml).', { name: s.name }) });
      }
    }
    if (p.geyser) {
      const b = this.bedrock.status(p.id);
      for (const x of b.backends || []) if (x.supported && !x.key) out.push({ level: 'err', server: x.name, text: T('“{name}” does not have the network’s Floodgate key – Bedrock players are kicked there.', { name: x.name }) });
      for (const x of b.backends || []) if (!x.supported) out.push({ level: 'warn', server: x.name, text: T('Bedrock players cannot switch to “{name}” ({type} has no Floodgate).', { name: x.name, type: x.type }) });
    }
    if (n.kind === 'bungeecord') out.push({ level: 'info', text: T('BungeeCord forwards players without a secret – safe only because the servers listen on 127.0.0.1. Velocity is the safer choice.') });
    if (!out.some((x) => x.level === 'err' || x.level === 'warn')) out.unshift({ level: 'ok', text: T('Everything is set up safely: only the proxy is reachable, it checks accounts and forwards players.') });
    return out;
  }

  /** What friends type in: Java (proxy port, TCP) and Bedrock (Geyser port, UDP – plus TCP and the WebRTC port for NetherNet) – at home and from outside. */
  async addresses(id) {
    const n = this.get(id);
    const p = this.srv(n.proxy);
    if (!p) return null;
    const lan = this.bedrock.lanHost() || lanIp();
    let outside = null;
    try { const d = this.ctx.router && this.ctx.router.dyn; if (d && d.domain) outside = d.domain; } catch { /* no router */ }
    try { if (!outside && this.ctx.remote) { const r = this.ctx.remote.status(); if (r && r.domain) outside = r.domain; } } catch { /* no remote access */ }
    try { if (!outside && this.ctx.liveGuide) outside = await this.ctx.liveGuide.publicIp(); } catch { /* offline */ }
    const forced = Object.keys(n.forced || {});
    return {
      java: { lan: lan ? `${lan}:${p.port}` : null, outside: outside ? (p.port === 25565 ? outside : `${outside}:${p.port}`) : null, port: p.port, forced },
      // NetherNet: same address and port for the players – from outside TCP <port> and UDP <webrtcPort> have to be open too
      bedrock: p.geyser ? { lan, outside, port: p.geyser.port, webrtcPort: p.geyser.webrtcPort || null, nethernet: !(p.geyser.nethernet && p.geyser.nethernet.transport === 'raknet') } : null,
      routerAuto: !!(this.ctx.router && this.ctx.router.cfg && this.ctx.router.cfg.auto),
    };
  }

  /* ---------------- Proxy updates without maintenance ---------------- */

  /**
   * New build of Velocity/BungeeCord (same version line) waiting and nobody online: stop the proxy, put the build in
   * (Hostwerk keeps the old jar as server.jar.alt), start, wait until ready – if not, the old jar comes back and the build
   * is skipped. Hostwerk's server-update check finds the build (mc.updates); this only picks the quiet moment.
   */
  async proxyUpdateTick() {
    for (const n of this.list()) {
      if (n.proxyUpdates && n.proxyUpdates.auto === false) continue;
      const p = this.srv(n.proxy);
      if (!p || !this.mc.updates || !this.mc.updates.get) continue;
      const u = (this.mc.updates.get(p.id) || {}).server;
      if (!u || !u.build || (n.proxyUpdates && n.proxyUpdates.failed === String(u.build))) continue;
      if (!this.ready(p.id) || this.players(p.id).length > 0) continue;
      await this.updateProxy(n, u.build).catch(() => {});
    }
  }
  async updateProxy(n, build) {
    const p = this.srv(n.proxy);
    const prev = { build: p.build, version: p.version };
    const T = this.t;
    await this.mc.stop(p.id);
    try {
      await this.mc.changeVersion(p.id, { type: p.type, version: p.version }).promise;
      await this.mc.start(p.id);
      if (!(await this.waitReady(p.id))) throw new Error(T('the proxy did not get ready'));
      this.note(n, true, T('{kind} build {b} running.', { kind: n.kind === 'velocity' ? 'Velocity' : 'BungeeCord', b: p.build }));
      return { ok: true };
    } catch (e) {
      if (this.running(p.id)) await this.mc.stop(p.id).catch(() => {});
      const dir = this.dir(p.id);
      const alt = path.join(dir, 'server.jar.alt');
      if (fs.existsSync(alt)) { fs.rmSync(path.join(dir, 'server.jar'), { force: true }); fs.renameSync(alt, path.join(dir, 'server.jar')); Object.assign(p, prev); }
      n.proxyUpdates = { ...(n.proxyUpdates || {}), failed: String(build) };
      this.save();
      await this.mc.start(p.id).catch(() => {});
      const text = T('Proxy update {b} rolled back ({why}) – the previous build runs again.', { b: build, why: e.message });
      this.note(n, false, text);
      try { this.host.notifications.notify('update-failed', { title: T('Proxy update rolled back'), text: `${n.name}: ${text}`, kind: 'warn' }); } catch { /* not registered */ }
      return { ok: false, error: e.message };
    }
  }
  note(n, ok, text) { try { if (this.ctx.keeper) this.ctx.keeper.record(`mc-network-proxy-${n.id}`, { ok, label: `Proxy (${n.name})`, text }); } catch { /* no keeper */ } }
}

module.exports = { McNetworks, KINDS, PAPERISH, VELOCITY_OK };
