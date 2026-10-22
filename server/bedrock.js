'use strict';
/*
 * Bedrock access through Geyser (translates Bedrock ↔ Java) and Floodgate (Bedrock players without a Java account).
 *
 * Where Geyser belongs:
 *   - In a network: ONCE on the proxy (Velocity/BungeeCord). Floodgate runs on the proxy and on every server behind it, all
 *     with the same key.pem – otherwise the servers kick Bedrock players. The proxy hands the Bedrock data on
 *     (send-floodgate-data: true). One UDP port for the whole network.
 *   - A single server without a proxy: directly on that server (plugin on Paper/Purpur/Folia/Spigot, mod on Fabric/NeoForge).
 * Never on the servers behind a proxy – that was the mistake of the old "Bedrock bridge" when it was used per server.
 *
 * No "start once and wait": Hostwerk writes Geyser's config (classic layout – Geyser migrates it) and creates the Floodgate
 * key itself (16 random bytes, exactly what Floodgate's AesKeyProducer makes). So everything is in place before the first
 * start, and the key can go to every server right away.
 *
 * Keeping itself up to date: Geyser has to follow Bedrock's updates (every few weeks). The GeyserMC download API gives the
 * newest build with SHA-256; it is downloaded into a staging folder and put in place before the next start (Hostwerk asks
 * minecraft.geyser.applyStaged before every start) – or right away by a restart when nobody is online. After the start a
 * probe asks Geyser's UDP port (RakNet ping); no answer within 3 minutes → the previous jars come back, the build is
 * remembered as failed and skipped until a newer one exists.
 * Compatibility: Geyser speaks the newest Java protocol. If a server runs an older Minecraft version, ViaVersion has to be
 * on it – the update waits (and says why) or installs ViaVersion first when "Install version bridges by itself" is on.
 *
 * NetherNet (Bedrock 26.60, 27 October 2026, drops RakNet): Geyser runs "transport: both" – RakNet on the Bedrock port (UDP),
 * NetherNet signaling on the same port over TCP and the game over WebRTC on an own UDP port (webrtcPort, chosen like the
 * Bedrock port). Hostwerk switches existing configs over by itself (activation, self-maintenance, before every start) and
 * keeps what the person set on purpose. Needs Geyser build 1237 or newer – the normal update brings it. Firewall and router
 * get TCP <port> and UDP <webrtcPort> next to UDP <port> (publicPorts). "NetherNet ready" = signaling answers (GET /v1/join).
 *
 * Data: the "geyser" entry of the Minecraft server Geyser runs on (the proxy or the single server) – same place as the old
 * bridge, so nothing has to move: { port, webrtcPort, nethernet, floodgate, mode, builds, pending, failed, probe, optionalPack,
 * backends, settings }.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');
const http = require('http');
const C = require('./configs');

const API = 'https://download.geysermc.org/v2/projects';
const MODRINTH = 'https://api.modrinth.com/v2';
/** Server type → [Geyser package, Floodgate package] (null = there is none) */
const PLATFORM = {
  paper: ['spigot', 'spigot'], purpur: ['spigot', 'spigot'], spigot: ['spigot', 'spigot'], folia: ['spigot', 'spigot'],
  velocity: ['velocity', 'velocity'], bungeecord: ['bungeecord', 'bungee'], fabric: ['fabric', null], neoforge: ['neoforge', null],
};
const PLUGIN_TYPES = ['paper', 'purpur', 'spigot', 'folia'];
const JAR = /^(geyser|floodgate)[-_].*\.jar$/i;
const STAGE = '.hostwerk-neu';
const ALT = '.hostwerk-alt';
const CONFIG_DIRS = ['Geyser-Spigot', 'Geyser-Velocity', 'Geyser-BungeeCord', 'Geyser-Fabric', 'Geyser-NeoForge', 'geyser', 'floodgate'];
const OPTIONAL_PACK = { project: 'geyseroptionalpack', platform: 'geyseroptionalpack', file: 'GeyserOptionalPack.mcpack' };
const PROBE_MS = 3 * 60000;
/** First Geyser build with NetherNet (2.11.3-b1237, GeyserMC blog "Preparing for NetherNet"). */
const NETHERNET_BUILD = 1237;
/** Bedrock 26.60 without RakNet – planned release date (GeyserMC). */
const NETHERNET_DATE = '2026-10-27';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- RakNet ping (Bedrock "unconnected ping") ---------------- */

const MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
/**
 * Ask a Bedrock server (Geyser or Bedrock Dedicated Server) on UDP: → { motd, protocol, version, players, max, name } or null.
 * The same packet the Bedrock app sends for the server list.
 */
function bedrockPing(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((resolve) => {
    const s = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
    const done = (v) => { clearTimeout(t); try { s.close(); } catch { /* closed */ } resolve(v); };
    const t = setTimeout(() => done(null), timeout);
    s.on('error', () => done(null));
    s.on('message', (msg) => done(parsePong(msg)));
    const p = Buffer.alloc(33);
    p[0] = 0x01; p.writeBigInt64BE(BigInt(Date.now()), 1); MAGIC.copy(p, 9); p.writeBigInt64BE(2n, 25);
    s.send(p, port, host, (e) => { if (e) done(null); });
  });
}
/** Unconnected pong: 0x1c, time(8), guid(8), magic(16), length(2), "MCPE;motd;protocol;version;players;max;id;name;mode;…" */
function parsePong(msg) {
  if (!Buffer.isBuffer(msg) || msg.length < 35 || msg[0] !== 0x1c) return null;
  const len = msg.readUInt16BE(33);
  const parts = msg.toString('utf8', 35, 35 + len).split(';');
  if (parts[0] !== 'MCPE' && parts[0] !== 'MCEE') return null;
  return { motd: parts[1] || '', protocol: Number(parts[2]) || null, version: parts[3] || '', players: Number(parts[4]) || 0, max: Number(parts[5]) || 0, name: parts[7] || '' };
}
function pongPacket(text) {
  const body = Buffer.from(text, 'utf8');
  const b = Buffer.alloc(35 + body.length);
  b[0] = 0x1c; MAGIC.copy(b, 17); b.writeUInt16BE(body.length, 33); body.copy(b, 35);
  return b;
}

/**
 * NetherNet signaling answers? GET /v1/join is what the Bedrock app asks first (server list entry) – the answer is the same
 * status as the RakNet pong, as JSON. → { name, level, version, protocol, players, maxPlayers } or null.
 */
function netherNetPing(port, host = '127.0.0.1', timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/v1/join', timeout, headers: { Host: `${host}:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 8192) body += d; });
      res.on('end', () => { try { const j = res.statusCode === 200 ? JSON.parse(body) : null; resolve(j && typeof j === 'object' ? j : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}
/** Build number of "2.12.0-1269" (null when unknown). */
function buildNo(b) { const m = String(b || '').match(/(?:^|[-b])(\d{3,})$/); return m ? Number(m[1]) : null; }
/** Is a TCP port free on this PC? (NetherNet signaling takes the TCP side of the Bedrock port) */
function tcpFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
  });
}

/** Is a UDP port free on this PC? */
function udpFree(port) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => { try { s.close(); } catch { /* ignore */ } resolve(false); });
    s.bind(port, '0.0.0.0', () => s.close(() => resolve(true)));
  });
}
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address)) return n.address;
  return null;
}
/** "26.3" ≥ "1.21.11"? – Minecraft versions compared part by part (new year scheme 26.x is newer than 1.x). */
function cmpMc(a, b) {
  const pa = String(a || '0').split(/[.-]/).map((x) => Number(x) || 0); const pb = String(b || '0').split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
/** Highest stable Minecraft version in a list. */
function newestMc(list) { return (list || []).filter((v) => /^\d+(\.\d+)*$/.test(v)).sort(cmpMc).pop() || null; }

class Bedrock {
  /** host: extension host · mc: Hostwerk's Minecraft manager · net: { fetchJson, downloadFile, runJob, jobProgress } · opts: { udpFree, ping, now } */
  constructor(host, mc, net, opts = {}) {
    this.host = host; this.ctx = host.ctx; this.t = host.t; this.mc = mc; this.net = net;
    this.udpFree = opts.udpFree || udpFree;
    this.tcpFree = opts.tcpFree || tcpFree;
    this.ping = opts.ping || bedrockPing;
    this.nnPing = opts.nnPing || netherNetPing;
    /** id → { pid, ok, at, info } – last answer of NetherNet signaling per Geyser process */
    this.nnSeen = new Map();
    this.via = null; // set by index.js (version bridges) – for the compatibility check before updates
  }
  save() { this.ctx.settings.save(); }
  note(key, x) { try { if (this.ctx.keeper) this.ctx.keeper.record(key, x); } catch { /* no keeper */ } }

  supported(s) {
    if (typeof this.mc.isBedrock === 'function' && this.mc.isBedrock(s)) return { ok: false, why: this.t('This is a Bedrock server – Bedrock players join it directly.'), bedrockServer: true };
    if (s.geyser && s.geyser.mode === 'standalone') return { ok: false, why: this.t('Geyser runs as its own program in front of this server (Geyser Standalone).'), standalone: true };
    const p = PLATFORM[s.type];
    if (p) return { ok: true, geyser: p[0], floodgate: p[1] };
    const why = s.type === 'vanilla' ? this.t('Vanilla cannot load plugins – Geyser Standalone runs in front of it instead, or switch the server to Paper (same world).') : s.type === 'forge' ? this.t('There is no Geyser mod for Forge – Geyser Standalone runs in front of it instead.') : this.t('There is no Geyser plugin for this server type – Geyser Standalone runs in front of it instead.');
    // Standalone: Geyser as its own program (standalone.js) – for every Java server that cannot load it
    return { ok: false, why, standalone: !this.isProxy(s) && !(s.network && s.network.proxy) };
  }
  isProxy(s) { return !!s && this.mc.isProxy(s); }
  /** Servers behind a proxy (members of its network). */
  backends(proxyId) { return this.mc.list().filter((x) => x.id !== proxyId && x.network && x.network.proxy === proxyId); }
  /** Where Geyser of this server's network runs: the proxy for a server behind one, else the server itself. */
  hostOf(id) { const s = this.mc.get(id); return s.network && s.network.proxy ? s.network.proxy : id; }

  /* ---------------- Ports ---------------- */

  /** UDP ports others want: other Geyser instances, Bedrock Dedicated Servers, public UDP ports, router forwardings. */
  usedUdp(id, extra = []) {
    const used = new Set(extra);
    for (const x of this.mc.list()) {
      if (x.id !== id && x.geyser && x.geyser.port) used.add(x.geyser.port);
      if (x.id !== id && x.geyser && x.geyser.webrtcPort) used.add(x.geyser.webrtcPort);
      // Bedrock Dedicated Servers of Hostwerk's core (IPv4 + IPv6 port)
      if (typeof this.mc.isBedrock === 'function' && this.mc.isBedrock(x)) for (const p of [x.port, x.portv6]) if (p) used.add(Number(p));
    }
    const own = (() => { try { return this.mc.get(id).geyser; } catch { return null; } })();
    try { for (const p of (this.ctx.security && this.ctx.security.publicPorts ? this.ctx.security.publicPorts() : [])) if (p.proto === 'UDP' && !(own && (p.port === own.port || p.port === own.webrtcPort))) used.add(p.port); } catch { /* no security service */ }
    try { const r = this.ctx.router; const list = r && r.forwards && typeof r.forwards.list === 'function' ? r.forwards.list() : []; for (const x of list) if (x.protocol === 'UDP' && x.owner !== this.host.id) used.add(x.port); } catch { /* no router */ }
    return used;
  }
  /** Bedrock port: free on UDP (RakNet) and on TCP (NetherNet signaling). */
  async freePort(id, extra = []) {
    const used = this.usedUdp(id, extra);
    for (let p = 19132; p < 19132 + 200; p++) { if (used.has(p)) continue; if (await this.udpFree(p) && await this.tcpFree(p)) return p; }
    throw this.host.error(409, 'No free UDP port found between 19132 and 19331.');
  }
  /** UDP port for NetherNet (WebRTC): right after the Bedrock port when free, never the Bedrock port itself. */
  async freeWebrtcPort(id, bedrockPort) {
    const used = this.usedUdp(id, [bedrockPort]);
    const start = Number(bedrockPort) > 0 && Number(bedrockPort) < 65000 ? Number(bedrockPort) + 1 : 19133;
    for (let p = start; p < start + 200; p++) { if (used.has(p)) continue; if (await this.udpFree(p)) return p; }
    throw this.host.error(409, 'No free UDP port found for NetherNet.');
  }
  /** Same choice without the bind test – for the synchronous path right before a start (the port is checked again next time). */
  webrtcPortNow(id, bedrockPort) {
    const used = this.usedUdp(id, [bedrockPort]);
    let p = Number(bedrockPort) + 1 || 19133;
    while (used.has(p) && p < 65535) p++;
    return p;
  }

  /* ---------------- Files ---------------- */

  geyserDir(id) {
    const s = this.mc.get(id);
    if (s.type === 'fabric' || s.type === 'neoforge') return path.join(this.mc.dir(id), 'config', 'geyser');
    const name = { velocity: 'Geyser-Velocity', bungeecord: 'Geyser-BungeeCord' }[s.type] || 'Geyser-Spigot';
    return path.join(this.mc.addonDir(id), name);
  }
  /** Existing Geyser config (also the folders older Geyser versions used). */
  configFile(id) {
    const s = this.mc.get(id);
    const base = this.mc.addonDir(id);
    const cands = [path.join(this.geyserDir(id), 'config.yml'), ...(s.type === 'fabric' || s.type === 'neoforge' ? ['Geyser-Fabric', 'Geyser-NeoForge'].map((d) => path.join(this.mc.dir(id), 'config', d, 'config.yml')) : [path.join(base, 'geyser', 'config.yml')])];
    return cands.find((f) => fs.existsSync(f)) || null;
  }
  floodgateDir(id) { return path.join(this.mc.addonDir(id), 'floodgate'); }
  keyFile(id) { return path.join(this.floodgateDir(id), 'key.pem'); }
  /** The network key: from the Geyser host (proxy/single server); created once when there is none yet. */
  ensureKey(id) {
    const f = this.keyFile(id);
    if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, crypto.randomBytes(16)); }
    return fs.readFileSync(f);
  }
  hasKey(id, key) { try { return fs.readFileSync(this.keyFile(id)).equals(key); } catch { return false; } }
  /**
   * Floodgate does NOT fill in missing settings: a short config makes it fail at the start (seen with Floodgate 2.2.5 on
   * Velocity – "metricsConfig is null", Geyser then switches itself off). So the config starts from Floodgate's own template
   * inside its jar (config.yml; on a proxy plus send-floodgate-data); a short config written by older versions of this
   * extension is repaired the same way (its values are kept).
   */
  async ensureFloodgateConfig(id, proxy = false) {
    const f = path.join(this.floodgateDir(id), 'config.yml');
    const now = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    if (/^metrics:/m.test(now)) return false;
    const tpl = await this.floodgateTemplate(id, proxy);
    if (!tpl) return false;
    let t = tpl;
    const keep = { prefix: C.yamlGet(now, ['username-prefix']), replaceSpaces: C.yamlGet(now, ['replace-spaces']), proxy: proxy ? true : undefined, globalLinking: C.yamlGet(now, ['player-link', 'enable-global-linking']) };
    t = C.floodgateText(t, Object.fromEntries(Object.entries(keep).filter(([, v]) => v !== undefined)));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, t);
    return true;
  }
  /** Floodgate's default config from its jar (null when there is no jar or it cannot be read). */
  async floodgateTemplate(id, proxy) {
    const dir = this.mc.addonDir(id);
    let jar = null;
    try { jar = fs.readdirSync(dir).find((x) => /^floodgate[-_].*\.jar$/i.test(x)); } catch { /* no folder */ }
    if (!jar || typeof this.net.extractZip !== 'function') return null;
    const tmp = path.join(os.tmpdir(), `hw-floodgate-${crypto.randomBytes(4).toString('hex')}`);
    try {
      await this.net.extractZip(path.join(dir, jar), tmp);
      const main = fs.readFileSync(path.join(tmp, 'config.yml'), 'utf8');
      if (!/^metrics:/m.test(main)) return null;
      // The template has placeholders Floodgate fills itself on a fresh start (${metrics.uuid}); proxy-config.yml is a
      // patch in Floodgate's own format (">> config.yml") – its one setting (send-floodgate-data) comes from floodgateText.
      void proxy;
      return main.replace(/\$\{metrics\.uuid\}/g, crypto.randomUUID()).replace(/^.*\$\{[^}]+\}.*\r?\n/gm, '').replace(/\n*$/, '\n');
    } catch { return null; } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  writeFloodgate(id, o) {
    const f = path.join(this.floodgateDir(id), 'config.yml');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, C.floodgateText(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '', o));
  }
  prefix(id) {
    try { const s = this.mc.get(this.hostOf(id)); if (s.geyser && s.geyser.settings && s.geyser.settings.prefix) return s.geyser.settings.prefix; } catch { /* unknown */ }
    try { const v = C.yamlGet(fs.readFileSync(path.join(this.floodgateDir(id), 'config.yml'), 'utf8'), ['username-prefix']); return typeof v === 'string' ? v : '.'; } catch { return '.'; }
  }

  /* ---------------- Versions ---------------- */

  async latest(project, platform) {
    const j = await this.net.fetchJson(`${API}/${project}/versions/latest/builds/latest`);
    const d = j && j.downloads && j.downloads[platform];
    if (!d) throw new Error(this.t('{project} no longer offers a package for {platform}.', { project, platform }));
    return { build: `${j.version}-${j.build}`, version: j.version, sha256: d.sha256 || null, url: `${API}/${project}/versions/${j.version}/builds/${j.build}/downloads/${platform}` };
  }
  /** Newest Java version Geyser speaks (Modrinth lists the Minecraft versions of each Geyser release). */
  async geyserTarget() {
    try {
      const list = await this.net.fetchJson(`${MODRINTH}/project/geyser/version?loaders=${encodeURIComponent(JSON.stringify(['velocity', 'paper']))}`);
      return newestMc((list[0] || {}).game_versions);
    } catch { return null; }
  }
  fileName(project, platform) { return `${project === 'geyser' ? 'Geyser' : 'floodgate'}-${platform}.jar`; }
  async download(project, platform, dir, name = this.fileName(project, platform), info = null) {
    const i = info || await this.latest(project, platform);
    fs.mkdirSync(dir, { recursive: true });
    await this.net.downloadFile(i.url, path.join(dir, name), { sha256: i.sha256 || undefined });
    return i;
  }

  /**
   * Compatibility of Geyser with the Minecraft versions it connects to: → [{ id, name, version, need: 'via'|'newer-geyser'|null, via }]
   * In a network these are the servers behind the proxy, else the server itself.
   */
  compat(id, target) {
    const s = this.mc.get(id);
    const list = this.isProxy(s) ? this.backends(id) : [s];
    return list.map((b) => {
      const via = this.via ? this.via.has(b.id, 'viaversion') : false;
      let need = null;
      if (target && b.version && /^\d/.test(b.version)) {
        if (cmpMc(b.version, target) < 0 && !via) need = 'via';
        else if (cmpMc(b.version, target) > 0) need = 'newer-geyser';
      }
      return { id: b.id, name: b.name, version: b.version, need, via };
    });
  }

  /* ---------------- State ---------------- */

  status(id) {
    const s = this.mc.get(id);
    if (s.geyser && s.geyser.mode === 'standalone' && this.standalone) return this.standalone.status(id);
    const sup = this.supported(s);
    const g = s.geyser || null;
    const p = this.mc.proc(id);
    const prefix = g && g.floodgate ? this.prefix(id) : null;
    const players = (p.extra && p.extra.players) || [];
    const out = {
      id, name: s.name, type: s.type, proxy: this.isProxy(s), behind: s.network && s.network.proxy ? s.network.proxy : null,
      supported: sup.ok, why: sup.why || null, standalonePossible: !!sup.standalone, enabled: !!g, port: g ? g.port : null, floodgate: !!(g && g.floodgate),
      mode: g ? (g.mode || (this.isProxy(s) ? 'proxy' : 'server')) : null, running: p.isRunning(), settings: g ? { ...this.defaults(), ...(g.settings || {}) } : null,
      build: g && g.builds ? g.builds.geyser || null : null, floodgateBuild: g && g.builds ? g.builds.floodgate || null : null,
      pending: g && g.pending ? g.pending : null, held: g && g.held ? g.held : null, failed: g && g.failed ? g.failed : null,
      checkedAt: g ? g.checkedAt || null : null, restartNeeded: !!(g && g.restartNeeded), optionalPack: !!(g && g.optionalPack),
      configured: !!this.configFile(id), webrtcPort: g ? g.webrtcPort || null : null, nethernet: g ? this.netherNetState(id) : null, prefix, bedrockPlayers: prefix ? players.map((x) => (typeof x === 'string' ? x : x && x.name)).filter((n) => n && n.startsWith(prefix)) : [],
    };
    if (out.proxy && out.floodgate) {
      let key = null; try { key = fs.readFileSync(this.keyFile(id)); } catch { /* none yet */ }
      out.backends = this.backends(id).map((b) => ({ id: b.id, name: b.name, type: b.type, key: !!key && this.hasKey(b.id, key), supported: PLUGIN_TYPES.includes(b.type) }));
    }
    return out;
  }
  defaults() { return { prefix: '.', authType: 'floodgate', motd1: '', motd2: '', serverName: '', passthrough: true, maxPlayers: 100, showCoordinates: true, xboxAchievements: false, replaceSpaces: true, globalLinking: true }; }
  list() { return this.mc.list().filter((s) => s.geyser).map((s) => this.status(s.id)); }
  /** Geyser as a plugin/mod (everything below) – Geyser Standalone has its own way (standalone.js). */
  plugin(s) { return !!(s && s.geyser && s.geyser.mode !== 'standalone'); }

  /* ---------------- Switching on ---------------- */

  /**
   * Bedrock on for a proxy (whole network) or a single server. Not for a server behind a proxy – there it belongs on the proxy.
   * Writes everything before the first start; restarts only what runs and is empty (otherwise "restart needed").
   */
  enable(id, { floodgate = true, settings = {} } = {}) {
    const { t } = this;
    const s = this.mc.get(id);
    if (s.network && s.network.proxy) throw this.host.error(400, 'This server is behind a proxy – Bedrock players come in through the proxy. Switch Bedrock on for the network instead.');
    const sup = this.supported(s);
    if (!sup.ok) throw this.host.error(400, sup.why);
    const fg = !!(floodgate && sup.floodgate);
    if (floodgate && !sup.floodgate && !this.isProxy(s)) throw this.host.error(400, 'Floodgate is only available for Paper, Purpur, Folia and Spigot – choose “Bedrock players need a Java account” or switch the server to Paper.');
    const wanted = { ...this.defaults(), ...(s.geyser && s.geyser.settings), ...this.cleanSettings(settings) };
    return this.net.runJob(t('Bedrock access for “{name}”', { name: s.name }), async (job) => {
      const dir = this.mc.addonDir(id);
      const before = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      try {
        job.progress(5, t('Downloading Geyser …'));
        for (const f of before.filter((x) => JAR.test(x))) fs.rmSync(path.join(dir, f), { force: true });
        const gi = await this.download('geyser', sup.geyser, dir);
        const fi = fg ? await this.download('floodgate', sup.floodgate, dir) : null;
        const port = s.geyser && s.geyser.port ? s.geyser.port : await this.freePort(id);
        const webrtcPort = s.geyser && s.geyser.webrtcPort && s.geyser.webrtcPort !== port ? s.geyser.webrtcPort : await this.freeWebrtcPort(id, port);
        // Geyser's settings before the first start (an existing file keeps everything else)
        job.progress(45, t('Writing the settings …'));
        const cfgFile = this.configFile(id) || path.join(this.geyserDir(id), 'config.yml');
        fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
        const conf = { port, authType: fg ? 'floodgate' : 'online', motd1: wanted.motd1 || s.name, motd2: wanted.motd2 || 'Java + Bedrock', serverName: wanted.serverName || s.name, passthrough: wanted.passthrough, maxPlayers: wanted.maxPlayers, showCoordinates: wanted.showCoordinates, xboxAchievements: wanted.xboxAchievements };
        fs.writeFileSync(cfgFile, fs.existsSync(cfgFile) ? C.geyserPatchText(fs.readFileSync(cfgFile, 'utf8'), conf) : C.geyserConfigText({ ...conf, remotePort: s.port, webrtcPort }));
        s.geyser = { ...(s.geyser || {}), port, webrtcPort, floodgate: fg, mode: this.isProxy(s) ? 'proxy' : 'server', at: Date.now(), builds: { geyser: gi.build, ...(fi ? { floodgate: fi.build } : {}) }, settings: wanted };
        delete s.geyser.pending; delete s.geyserOff;
        this.netherNetApply(id, webrtcPort);
        if (fg) {
          this.ensureKey(id);
          await this.ensureFloodgateConfig(id, this.isProxy(s));
          this.writeFloodgate(id, { prefix: wanted.prefix, replaceSpaces: wanted.replaceSpaces, globalLinking: wanted.globalLinking, ...(this.isProxy(s) ? { proxy: true } : {}) });
          if (this.isProxy(s)) {
            job.progress(60, t('Floodgate and the key on the servers behind the proxy …'));
            for (const r of await this.syncBackends(id)) job.log(r.ok ? t('{name}: Floodgate and key ready', { name: r.name }) : `${r.name}: ${r.why}`);
          }
        }
        this.save();
        job.progress(85, t('Putting it into effect …'));
        const restarted = await this.restartIfEmpty(id);
        if (this.ctx.router && this.ctx.router.cfg && this.ctx.router.cfg.auto && typeof this.ctx.router.sync === 'function') await this.ctx.router.sync().catch(() => {});
        return { port, webrtcPort: s.geyser.webrtcPort || null, floodgate: fg, restarted, restartNeeded: !restarted && this.mc.proc(id).isRunning() };
      } catch (e) {
        // Do not stay half on: what this job added goes again, the server stays as it was
        await this.cleanup(id, { keepConfig: true }).catch(() => {});
        throw e;
      }
    }, { key: `mc-network-bedrock-${id}` });
  }
  cleanSettings(b = {}) {
    const out = {};
    if (b.prefix !== undefined) { if (!C.validPrefix(b.prefix)) throw this.host.error(400, 'The Bedrock name prefix has to be 1–3 characters that Minecraft names cannot contain, e.g. “.” or “*”.'); out.prefix = b.prefix; }
    if (b.authType !== undefined) out.authType = b.authType === 'online' ? 'online' : 'floodgate';
    for (const k of ['motd1', 'motd2']) if (b[k] !== undefined) out[k] = String(b[k]).replace(/[\r\n]/g, ' ').slice(0, 80);
    if (b.serverName !== undefined) out.serverName = String(b.serverName).replace(/[\r\n]/g, ' ').slice(0, 40);
    if (b.maxPlayers !== undefined) out.maxPlayers = Math.max(1, Math.min(10000, Math.round(Number(b.maxPlayers)) || 100));
    for (const k of ['passthrough', 'showCoordinates', 'xboxAchievements', 'replaceSpaces', 'globalLinking']) if (b[k] !== undefined) out[k] = !!b[k];
    return out;
  }

  /** Change Bedrock settings later (MOTD, prefix, auth, player count …) – in the files Geyser/Floodgate actually use. */
  setSettings(id, b = {}) {
    const s = this.mc.get(id);
    if (!s.geyser) throw this.host.error(409, 'Bedrock access is off.');
    const next = { ...this.defaults(), ...(s.geyser.settings || {}), ...this.cleanSettings(b) };
    const f = this.configFile(id);
    if (f) fs.writeFileSync(f, C.geyserPatchText(fs.readFileSync(f, 'utf8'), { motd1: next.motd1 || undefined, motd2: next.motd2 || undefined, serverName: next.serverName || undefined, passthrough: next.passthrough, maxPlayers: next.maxPlayers, showCoordinates: next.showCoordinates, xboxAchievements: next.xboxAchievements, authType: s.geyser.floodgate ? next.authType : 'online' }));
    if (s.geyser.floodgate) {
      const fl = { prefix: next.prefix, replaceSpaces: next.replaceSpaces, globalLinking: next.globalLinking };
      this.writeFloodgate(id, { ...fl, ...(this.isProxy(s) ? { proxy: true } : {}) });
      // Prefix and spaces have to match on every server behind the proxy (they build the player names)
      if (this.isProxy(s)) for (const b2 of this.backends(id)) if (fs.existsSync(this.floodgateDir(b2.id))) this.writeFloodgate(b2.id, fl);
    }
    s.geyser.settings = next;
    if (this.mc.proc(id).isRunning()) s.geyser.restartNeeded = true;
    this.save();
    return this.status(id);
  }

  /**
   * Floodgate + the network key on every server behind a proxy (Paper/Purpur/Folia/Spigot). Servers that cannot run it are
   * reported – Bedrock players cannot switch to them. → [{ id, name, ok, why }]
   */
  async syncBackends(id) {
    const s = this.mc.get(id);
    if (!s.geyser || !s.geyser.floodgate || !this.isProxy(s)) return [];
    const key = this.ensureKey(id);
    const set = s.geyser.settings || {};
    const out = [];
    const installed = new Set(s.geyser.backends || []);
    let info = null;
    for (const b of this.backends(id)) {
      if (!PLUGIN_TYPES.includes(b.type)) { out.push({ id: b.id, name: b.name, ok: false, why: this.t('No Floodgate for this server type – Bedrock players cannot join it.') }); continue; }
      const dir = this.mc.addonDir(b.id);
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.readdirSync(dir).some((f) => /^floodgate[-_].*\.jar$/i.test(f))) {
        info = info || await this.latest('floodgate', 'spigot');
        await this.download('floodgate', 'spigot', dir, undefined, info);
        installed.add(b.id);
      }
      fs.mkdirSync(this.floodgateDir(b.id), { recursive: true });
      const had = this.hasKey(b.id, key);
      fs.writeFileSync(this.keyFile(b.id), key);
      await this.ensureFloodgateConfig(b.id, false);
      this.writeFloodgate(b.id, { prefix: set.prefix || '.', replaceSpaces: set.replaceSpaces !== false });
      out.push({ id: b.id, name: b.name, ok: true, changed: !had, restart: !had && this.mc.proc(b.id).isRunning() });
    }
    s.geyser.backends = [...installed];
    this.save();
    return out;
  }

  /** Restart a running server only when nobody plays on it (or its network) – else it applies with the next restart. */
  async restartIfEmpty(id) {
    const p = this.mc.proc(id);
    if (!p.isRunning()) return false;
    if (this.playersOn(id) > 0) { const s = this.mc.get(id); if (s.geyser) { s.geyser.restartNeeded = true; this.save(); } return false; }
    await this.mc.restart(id);
    return true;
  }
  playersOn(id) {
    const s = this.mc.get(id);
    const ids = this.isProxy(s) ? [id, ...this.backends(id).map((b) => b.id)] : [id];
    return ids.reduce((n, x) => { try { const e = this.mc.proc(x).extra || {}; return n + Math.max((e.players || []).length, e.playerCount || 0); } catch { return n; } }, 0);
  }

  /* ---------------- Keeping itself up to date ---------------- */

  /** Look for new builds; stage them (checksum) – put in place before the next start or by a restart when nobody is online. */
  async checkUpdate(id) {
    const { t } = this;
    const s = this.mc.get(id);
    const g = s.geyser;
    if (!g || !this.plugin(s)) return null;
    const sup = this.supported(s);
    if (!sup.ok) return null;
    const want = { geyser: await this.latest('geyser', sup.geyser) };
    if (g.floodgate && sup.floodgate) want.floodgate = await this.latest('floodgate', sup.floodgate);
    g.checkedAt = Date.now();
    if (g.optionalPack) await this.updateOptionalPack(id).catch(() => {});
    const have = g.builds || {};
    const failed = g.failed || {};
    const changed = Object.keys(want).filter((k) => want[k].build !== have[k] && want[k].build !== (g.pending || {})[k] && want[k].build !== failed[k]);
    if (!changed.length) {
      delete g.held;
      this.save();
      this.note(`mc-network-geyser-${id}`, { ok: true, label: `Geyser (${s.name})`, text: g.pending ? t('A new build waits for the next restart.') : t('Up to date (build {b}).', { b: have.geyser || '?' }) });
      return { upToDate: !g.pending, pending: g.pending || null };
    }
    // A new Geyser may speak a newer Java version than the servers behind it: ViaVersion first (or wait and say why)
    if (changed.includes('geyser')) {
      const target = await this.geyserTarget();
      const issues = this.compat(id, target).filter((x) => x.need === 'via');
      if (issues.length) {
        const auto = this.via && this.via.autoFor && this.via.autoFor(id);
        if (auto) {
          for (const x of issues) { try { await this.via.install(x.id, ['viaversion']); } catch (e) { g.held = { reason: 'via', target, servers: issues.map((i) => i.name), error: e.message, at: Date.now() }; this.save(); return { held: g.held }; } }
        } else {
          g.held = { reason: 'via', target, servers: issues.map((i) => i.name), at: Date.now() };
          this.save();
          this.note(`mc-network-geyser-${id}`, { ok: false, label: `Geyser (${s.name})`, text: t('Update waits: {list} need ViaVersion for Geyser {v}.', { list: g.held.servers.join(', '), v: target }) });
          return { held: g.held };
        }
      }
    }
    delete g.held;
    // Stage on the Geyser host – and Floodgate on every server behind the proxy that got it from us
    for (const k of changed) {
      const plat = k === 'geyser' ? sup.geyser : sup.floodgate;
      await this.download(k, plat, path.join(this.mc.addonDir(id), STAGE), undefined, want[k]);
      if (k === 'floodgate' && this.isProxy(s)) {
        const fb = await this.latest('floodgate', 'spigot');
        for (const bid of g.backends || []) { try { this.mc.get(bid); await this.download('floodgate', 'spigot', path.join(this.mc.addonDir(bid), STAGE), undefined, fb); } catch { /* server gone */ } }
      }
    }
    g.pending = { ...(g.pending || {}), ...Object.fromEntries(changed.map((k) => [k, want[k].build])) };
    this.save();
    this.note(`mc-network-geyser-${id}`, { ok: true, version: want.geyser.build, label: `Geyser (${s.name})`, text: t('New build downloaded: {list}.', { list: changed.map((k) => `${k} ${want[k].build}`).join(', ') }) });
    const staged = { ...g.pending };
    const applied = !this.mc.proc(id).isRunning() && this.applyStaged(id);
    return { pending: staged, applied };
  }

  /**
   * Put staged jars in place – Hostwerk calls this before EVERY start of every server (manager.start). The jars replaced
   * here go to .hostwerk-alt so a failed start can come back. Works for the Geyser host and for Floodgate on backends.
   */
  applyStaged(id, log) {
    let s; try { s = this.mc.get(id); } catch { return false; }
    if (s.geyser && !this.plugin(s)) return false;
    // NetherNet: a config that is still on RakNet only is switched right before the start (also brand-new Geyser files)
    if (s.geyser) { try { this.netherNetApply(id); } catch (e) { if (log) log(this.t('NetherNet not set up: {msg}', { msg: e.message })); } }
    if (s.geyser && s.geyser.nethernet && s.geyser.nethernet.restartNeeded) { delete s.geyser.nethernet.restartNeeded; this.save(); }
    if (s.geyser && s.geyser.restartNeeded) { delete s.geyser.restartNeeded; this.save(); }
    if (s.geyserOff) { delete s.geyserOff; this.save(); }
    const dir = this.mc.addonDir(id);
    const stage = path.join(dir, STAGE);
    let files = [];
    try { files = fs.readdirSync(stage).filter((f) => JAR.test(f)); } catch { /* nothing waiting */ }
    if (!files.length) return false;
    const alt = path.join(dir, ALT);
    fs.rmSync(alt, { recursive: true, force: true });
    fs.mkdirSync(alt, { recursive: true });
    for (const f of files) {
      const kind = /^geyser/i.test(f) ? /^geyser[-_]/i : /^floodgate[-_]/i;
      for (const old of fs.readdirSync(dir).filter((x) => JAR.test(x) && kind.test(x))) fs.renameSync(path.join(dir, old), path.join(alt, old));
      fs.renameSync(path.join(stage, f), path.join(dir, f));
    }
    fs.rmSync(stage, { recursive: true, force: true });
    if (s.geyser && s.geyser.pending) {
      s.geyser.probe = { at: Date.now(), prev: { ...(s.geyser.builds || {}) }, next: { ...s.geyser.pending } };
      s.geyser.builds = { ...(s.geyser.builds || {}), ...s.geyser.pending };
      delete s.geyser.pending;
    }
    this.save();
    if (log) log(this.t('Geyser/Floodgate updated – the previous version is kept until the start is confirmed.'));
    return true;
  }

  /**
   * After an update: does Geyser answer on its port? Called every 30 s. ok → old jars away. No answer 3 minutes after the
   * server got ready, or the server stopped on its own → previous jars back, build remembered as failed, start again.
   */
  async probeTick(now = Date.now()) {
    await this.netherNetProbe(now).catch(() => {});
    for (const s of this.mc.list()) {
      const g = s.geyser;
      if (!g || !g.probe || !this.plugin(s)) continue;
      const p = this.mc.proc(s.id);
      const ready = p.isRunning() && p.extra && p.extra.ready;
      if (ready && !g.probe.readyAt) { g.probe.readyAt = now; this.save(); }
      const pong = ready ? await this.ping(g.port).catch(() => null) : null;
      if (pong) { this.confirm(s.id); continue; }
      const crashed = !p.isRunning() && p.state === 'error';
      const silent = g.probe.readyAt && now - g.probe.readyAt > PROBE_MS;
      if (crashed || silent) await this.rollback(s.id, crashed ? this.t('the server stopped after the update') : this.t('Geyser did not answer on port {port}', { port: g.port }));
    }
  }
  confirm(id) {
    const s = this.mc.get(id);
    for (const x of [id, ...((s.geyser && s.geyser.backends) || [])]) { try { fs.rmSync(path.join(this.mc.addonDir(x), ALT), { recursive: true, force: true }); } catch { /* gone */ } }
    const next = s.geyser.probe.next;
    delete s.geyser.probe;
    this.save();
    this.note(`mc-network-geyser-${id}`, { ok: true, version: next.geyser || null, label: `Geyser (${s.name})`, text: this.t('Update confirmed – Geyser answers.') });
  }
  async rollback(id, reason) {
    const s = this.mc.get(id);
    const g = s.geyser;
    const wasRunning = this.mc.proc(id).isRunning();
    if (wasRunning) await this.mc.stop(id).catch(() => {});
    for (const x of [id, ...(g.backends || [])]) {
      let dir; try { dir = this.mc.addonDir(x); } catch { continue; }
      const alt = path.join(dir, ALT);
      if (!fs.existsSync(alt)) continue;
      for (const f of fs.readdirSync(alt)) {
        const kind = /^geyser/i.test(f) ? /^geyser[-_]/i : /^floodgate[-_]/i;
        for (const cur of fs.readdirSync(dir).filter((y) => JAR.test(y) && kind.test(y))) fs.rmSync(path.join(dir, cur), { force: true });
        fs.renameSync(path.join(alt, f), path.join(dir, f));
      }
      fs.rmSync(alt, { recursive: true, force: true });
    }
    g.failed = { ...(g.failed || {}), ...g.probe.next };
    g.builds = { ...g.probe.prev };
    delete g.probe;
    this.save();
    const text = this.t('Update {b} rolled back ({why}) – the previous version runs again. Hostwerk skips this build.', { b: g.failed.geyser || g.failed.floodgate, why: reason });
    this.note(`mc-network-geyser-${id}`, { ok: false, label: `Geyser (${s.name})`, text });
    try { this.host.notifications.notify('update-failed', { title: this.t('Geyser update rolled back'), text: `${s.name}: ${text}`, kind: 'warn' }); } catch { /* not registered */ }
    if (wasRunning || this.mc.proc(id).state === 'error') await this.mc.start(id).catch(() => {});
    return { rolledBack: true };
  }

  /** Every 10 minutes: a running Geyser host with a waiting update and nobody online → restart it (and backends with new Floodgate). */
  async applyWhenEmpty() {
    for (const s of this.mc.list()) {
      const g = s.geyser;
      if (!g || !this.plugin(s) || !(g.pending || g.restartNeeded)) continue;
      const p = this.mc.proc(s.id);
      if (!p.isRunning() || !p.extra.ready || this.playersOn(s.id) > 0) continue;
      if (this.isProxy(s)) for (const bid of g.backends || []) { try { if (fs.existsSync(path.join(this.mc.addonDir(bid), STAGE)) && this.mc.proc(bid).isRunning()) await this.mc.restart(bid); } catch { /* next round */ } }
      await this.mc.restart(s.id).catch(() => {});
      this.host.broadcast({ type: 'toast', kind: 'info', text: this.t('{name}: Bedrock access updated (nobody was online).', { name: s.name }) });
    }
  }
  async checkAll() {
    for (const s of this.mc.list()) {
      if (!this.plugin(s)) continue;
      try { await this.checkUpdate(s.id); } catch (e) { this.note(`mc-network-geyser-${s.id}`, { ok: false, label: `Geyser (${s.name})`, text: this.t('Update check failed: {msg}', { msg: e.message }) }); }
    }
    await this.netherNetAll().catch(() => {});
  }

  /* ---------------- NetherNet ---------------- */

  /** Config file of the Geyser serving this server (plugin/mod or Standalone) – null before the first switch-on. */
  geyserConfig(id) {
    const s = this.mc.get(id);
    if (s.geyser && s.geyser.mode === 'standalone') { const f = this.standalone ? path.join(this.standalone.dir(id), 'config.yml') : null; return f && fs.existsSync(f) ? f : null; }
    return this.configFile(id);
  }
  /** Process Geyser runs in: the server itself, or Geyser Standalone's own one. */
  geyserProc(s) { return s.geyser && s.geyser.mode === 'standalone' && this.standalone ? this.standalone.proc(s.id) : this.mc.proc(s.id); }
  /**
   * Switch one Geyser to NetherNet (synchronous – also right before a start). port: WebRTC port to use if one is needed
   * (else the remembered one, else the next one not taken). Keeps what the person set on purpose: their own "both" port,
   * "nethernet", and "raknet" once Hostwerk had switched it. → { changed, transport, webrtcPort, portChanged } or null
   */
  netherNetApply(id, port) {
    const s = this.mc.get(id);
    const g = s.geyser;
    if (!g) return null;
    const f = this.geyserConfig(id);
    if (!f) return null;
    const text = fs.readFileSync(f, 'utf8');
    const keepRaknet = !!(g.nethernet && g.nethernet.at);
    const bedrockPort = Number(C.geyserRead(text).port) || g.port;
    const want = port || (g.webrtcPort && g.webrtcPort !== bedrockPort ? g.webrtcPort : null);
    let r = C.geyserNetherNet(text, { webrtcPort: want, keepRaknet });
    if (r.needsPort) r = C.geyserNetherNet(text, { webrtcPort: this.webrtcPortNow(id, bedrockPort), keepRaknet });
    if (r.changed) fs.writeFileSync(f, r.text);
    const key = () => JSON.stringify([g.webrtcPort || null, (g.nethernet || {}).transport || null]);
    const before = key();
    // Only an own UDP port goes to firewall/router – "nethernet" on the Bedrock port needs just its TCP side
    if (r.webrtcPort && r.webrtcPort !== bedrockPort) g.webrtcPort = r.webrtcPort; else delete g.webrtcPort;
    const first = r.transport !== 'raknet' && !(g.nethernet && g.nethernet.at);
    g.nethernet = { ...(g.nethernet || {}), transport: r.transport, ...(first ? { at: Date.now() } : {}) };
    if (r.changed && this.geyserProc(s).isRunning()) g.nethernet.restartNeeded = true;
    const portChanged = before !== key();
    if (r.changed || portChanged || first) this.save();
    return { changed: r.changed, transport: r.transport, webrtcPort: g.webrtcPort || null, portChanged };
  }
  /**
   * Make sure the WebRTC port of one Geyser is really free (bind test while Geyser is off) and switch it to NetherNet.
   * A running Geyser that changed: plugin → restart as soon as nobody plays (applyWhenEmpty), Standalone → restarted alone.
   */
  async netherNetEnsure(id) {
    const s = this.mc.get(id);
    const g = s.geyser;
    if (!g || !this.geyserConfig(id)) return null;
    const running = this.geyserProc(s).isRunning();
    const off = !!(g.nethernet && g.nethernet.at && g.nethernet.transport === 'raknet');
    let port = null;
    if (!off && g.port && !(g.nethernet && g.nethernet.transport === 'nethernet')) {
      const used = this.usedUdp(id, [g.port]);
      const bad = !g.webrtcPort || g.webrtcPort === g.port || used.has(g.webrtcPort) || (!running && !(await this.udpFree(g.webrtcPort)));
      if (bad) port = await this.freeWebrtcPort(id, g.port).catch(() => null);
    }
    const r = this.netherNetApply(id, port);
    if (r && r.changed && running) {
      if (g.mode === 'standalone') {
        if (!this.playersOn(id) && this.standalone) { await this.standalone.restart(id).catch(() => {}); delete g.nethernet.restartNeeded; this.save(); }
      } else { g.restartNeeded = true; this.save(); }
    }
    if (r && r.portChanged && this.ctx.router && this.ctx.router.cfg && this.ctx.router.cfg.auto && typeof this.ctx.router.sync === 'function') await this.ctx.router.sync().catch(() => {});
    return r;
  }
  /**
   * State for the UI → { state, transport, port, webrtcPort, minBuild, date, answer }
   *   ready (signaling answers) · configured (set up, answers after the next start) · restart (changed while running) ·
   *   old (Geyser older than build 1237) · silent (running, signaling does not answer) · off (RakNet by hand) · setup (no config yet)
   */
  netherNetState(id) {
    const s = this.mc.get(id);
    const g = s.geyser;
    if (!g) return null;
    const n = g.nethernet || {};
    const b = buildNo(g.mode === 'standalone' ? (g.builds || {}).standalone : (g.builds || {}).geyser);
    const p = this.geyserProc(s);
    const seen = this.nnSeen.get(id);
    const current = !!seen && seen.pid === (p.pid || null);
    let state = 'configured';
    if (n.transport === 'raknet') state = 'off';
    else if (!n.transport) state = 'setup';
    else if (b !== null && b < NETHERNET_BUILD) state = 'old';
    else if (n.restartNeeded && p.isRunning()) state = 'restart';
    else if (p.isRunning() && current && seen.ok) state = 'ready';
    else if (p.isRunning() && current && seen.fails >= 3) state = 'silent';
    return { state, transport: n.transport || null, port: g.port || null, webrtcPort: g.webrtcPort || null, minBuild: NETHERNET_BUILD, date: NETHERNET_DATE, answer: current && seen.ok ? seen.info : null };
  }
  /** Every 30 s: does NetherNet signaling of a running Geyser answer? (once per process; no answer → asked again) */
  async netherNetProbe(now = Date.now()) {
    for (const s of this.mc.list()) {
      const g = s.geyser;
      if (!g || !g.port || !g.nethernet || !['both', 'nethernet'].includes(g.nethernet.transport)) continue;
      const p = this.geyserProc(s);
      if (!p.isRunning() || !(p.extra && p.extra.ready)) { this.nnSeen.delete(s.id); continue; }
      const pid = p.pid || null;
      const seen = this.nnSeen.get(s.id);
      if (seen && seen.pid === pid && seen.ok) continue;
      const info = await this.nnPing(g.port).catch(() => null);
      const fails = info ? 0 : (seen && seen.pid === pid ? seen.fails || 0 : 0) + 1;
      this.nnSeen.set(s.id, { pid, ok: !!info, at: now, fails, info: info ? { name: String(info.name || ''), version: String(info.version || ''), players: Number(info.players) || 0 } : null });
      // The self-maintenance gets one bundled line – when it answers, or after 3 tries (1½ minutes) without an answer
      if (info || fails === 3) this.netherNetNote();
    }
  }
  /** Every Geyser on NetherNet with a free port, then one bundled line for the self-maintenance. */
  async netherNetAll() {
    for (const s of this.mc.list()) { if (!s.geyser) continue; try { await this.netherNetEnsure(s.id); } catch { /* next round */ } }
    this.netherNetNote();
  }
  netherNetNote() {
    const list = this.mc.list().filter((s) => s.geyser).map((s) => ({ s, st: this.netherNetState(s.id) }));
    if (!list.length) return;
    const by = (state) => list.filter((x) => x.st.state === state).map((x) => x.s.name).join(', ');
    const parts = [];
    if (by('old')) parts.push(this.t('Geyser is too old for NetherNet (build {b} or newer needed): {list}.', { b: NETHERNET_BUILD, list: by('old') }));
    if (by('silent')) parts.push(this.t('NetherNet does not answer (is the TCP port taken?): {list}.', { list: by('silent') }));
    if (by('setup')) parts.push(this.t('NetherNet is not set up yet: {list}.', { list: by('setup') }));
    const bad = parts.length > 0;
    if (!bad) parts.push(this.t('Bedrock players can join over NetherNet: {list}.', { list: list.filter((x) => x.st.state !== 'off').map((x) => x.s.name).join(', ') || '–' }));
    if (by('off')) parts.push(this.t('Switched back to RakNet by hand: {list}.', { list: by('off') }));
    this.note('mc-network-nethernet', { ok: !bad && !by('off'), label: 'NetherNet (Bedrock)', text: parts.join(' ') });
  }
  /** Ports from outside for NetherNet: TCP on the Bedrock port (signaling) and the own UDP port (WebRTC). */
  publicPorts() {
    const out = [];
    for (const s of this.mc.list()) {
      const g = s.geyser;
      if (!g || !g.port || (s.network && s.network.proxy)) continue;
      if (g.nethernet && g.nethernet.transport === 'raknet') continue;
      out.push({ port: g.port, proto: 'TCP', label: `Minecraft Bedrock (NetherNet): ${s.name}` });
      if (g.webrtcPort) out.push({ port: g.webrtcPort, proto: 'UDP', label: `Minecraft Bedrock (NetherNet): ${s.name}` });
    }
    return out;
  }

  /* ---------------- GeyserOptionalPack ---------------- */

  packsDir(id) { return path.join(path.dirname(this.configFile(id) || path.join(this.geyserDir(id), 'config.yml')), 'packs'); }
  async setOptionalPack(id, on) {
    const s = this.mc.get(id);
    if (!s.geyser) throw this.host.error(409, 'Bedrock access is off.');
    if (on) { s.geyser.optionalPack = true; await this.updateOptionalPack(id); } else { delete s.geyser.optionalPack; fs.rmSync(path.join(this.packsDir(id), OPTIONAL_PACK.file), { force: true }); }
    if (this.mc.proc(id).isRunning()) s.geyser.restartNeeded = true;
    this.save();
    return this.status(id);
  }
  async updateOptionalPack(id) {
    const s = this.mc.get(id);
    const dir = this.packsDir(id);
    const info = await this.latest(OPTIONAL_PACK.project, OPTIONAL_PACK.platform);
    if (s.geyser.builds && s.geyser.builds.optionalPack === info.build && fs.existsSync(path.join(dir, OPTIONAL_PACK.file))) return false;
    await this.download(OPTIONAL_PACK.project, OPTIONAL_PACK.platform, dir, OPTIONAL_PACK.file, info);
    s.geyser.builds = { ...(s.geyser.builds || {}), optionalPack: info.build };
    return true;
  }

  /* ---------------- Switching off ---------------- */

  /** Jars, waiting updates and (unless keepConfig) settings folders away – also Floodgate this extension put on backends. */
  async cleanup(id, { keepConfig = false } = {}) {
    const s = this.mc.get(id);
    const dir = this.mc.addonDir(id);
    try { for (const f of fs.readdirSync(dir).filter((x) => JAR.test(x))) fs.rmSync(path.join(dir, f), { force: true }); } catch { /* none */ }
    for (const d of [STAGE, ALT]) { try { fs.rmSync(path.join(dir, d), { recursive: true, force: true }); } catch { /* none */ } }
    if (!keepConfig) for (const r of [dir, path.join(this.mc.dir(id), 'config')]) for (const c of CONFIG_DIRS) { try { fs.rmSync(path.join(r, c), { recursive: true, force: true }); } catch { /* none */ } }
    for (const bid of (s.geyser && s.geyser.backends) || []) {
      let b; try { b = this.mc.get(bid); } catch { continue; }
      if (b.geyser) continue; // a server with its own Geyser keeps Floodgate
      const bd = this.mc.addonDir(bid);
      try { for (const f of fs.readdirSync(bd).filter((x) => /^floodgate[-_].*\.jar$/i.test(x))) fs.rmSync(path.join(bd, f), { force: true }); } catch { /* none */ }
      for (const d of ['floodgate', STAGE, ALT]) { try { fs.rmSync(path.join(bd, d), { recursive: true, force: true }); } catch { /* none */ } }
    }
    delete s.geyser;
    this.save();
  }
  async disable(id) {
    const s = this.mc.get(id);
    const running = this.mc.proc(id).isRunning();
    await this.cleanup(id);
    if (running) s.geyserOff = { restartNeeded: true, at: Date.now() }; else delete s.geyserOff;
    this.save();
    if (this.ctx.router && this.ctx.router.cfg && this.ctx.router.cfg.auto && typeof this.ctx.router.sync === 'function') await this.ctx.router.sync().catch(() => {});
    return { ...this.status(id), restartNeeded: running };
  }

  lanHost() { const r = this.ctx.router && this.ctx.router.cache && this.ctx.router.cache.igd; return (r && r.localIp) || lanIp(); }
}

module.exports = { Bedrock, PLATFORM, PLUGIN_TYPES, JAR, STAGE, ALT, CONFIG_DIRS, OPTIONAL_PACK, NETHERNET_BUILD, NETHERNET_DATE, bedrockPing, netherNetPing, buildNo, parsePong, pongPacket, udpFree, tcpFree, lanIp, cmpMc, newestMc, sleep };
