'use strict';
/*
 * Bedrock Dedicated Server (BDS) – Mojang's official server for the Bedrock edition. The alternative to Geyser:
 *   - Geyser: Bedrock players join your JAVA server (same world as Java players, Java plugins, a few Bedrock limits).
 *   - BDS:    its own Bedrock world, only Bedrock players (phone, console, Windows), everything exactly like Bedrock
 *             (redstone, add-ons/behaviour packs) – no Java players, no Java plugins.
 *
 * Runs as its own program (not Java): bedrock_server(.exe) from Mojang's official download (the list behind the
 * minecraft.net download page: net-secondary.web.minecraft-services.net/api/v1.0/download/links). Started through Hostwerk's
 * process management (logs, self-healing), ports go into the firewall/router when "public" is on (security port provider).
 *
 * Keeping itself up to date: Bedrock players can only join a server with their app version, so BDS has to follow every
 * Bedrock release. Every 6 hours the download list is checked; a new version is installed as soon as nobody is online:
 * stop → new version unpacked NEXT to the old one → worlds and settings copied over → swapped → start → probe (log line
 * "Server started." and an answer on the UDP port). If that fails, the old folder comes back and the version is skipped.
 *
 * Data: settings.mcNetwork.bds = [{ id, name, port, portv6, version, public, autostart, eulaAt, failed, checkedAt }]
 *       files: <Hostwerk>/data/bedrock-servers/<id>/
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./configs');
const { bedrockPing, sleep } = require('./bedrock');

const LINKS = 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links';
const IS_WIN = process.platform === 'win32';
/** Files and folders of a BDS that belong to the person – they move over to every new version. */
const KEEP = ['worlds', 'server.properties', 'permissions.json', 'allowlist.json', 'whitelist.json', 'behavior_packs_custom', 'resource_packs_custom', 'config', 'development_behavior_packs', 'development_resource_packs'];
const START_MS = 3 * 60000;

/** Version from the download address: …/bedrock-server-1.26.52.3.zip → 1.26.52.3 */
function versionOf(url) { const m = String(url || '').match(/bedrock-server-([\d.]+)\.zip/i); return m ? m[1] : null; }
function cmpVer(a, b) { const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number); for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; } return 0; }

class BedrockServers {
  /** host · net: { fetchJson, downloadFile, extractZip, runJob } · opts: { ManagedProcess, ping, platform, root } */
  constructor(host, net, opts = {}) {
    this.host = host; this.ctx = host.ctx; this.t = host.t; this.net = net;
    this.ping = opts.ping || bedrockPing;
    this.platform = opts.platform || (IS_WIN ? 'win' : 'linux');
    this.root = opts.root || path.join(this.ctx.paths.data, 'bedrock-servers');
    this.Proc = opts.ManagedProcess || host.core('proc').ManagedProcess;
    this.procs = new Map();
  }
  get cfg() { const s = this.ctx.settings.get(); if (!s.mcNetwork) s.mcNetwork = { networks: [] }; if (!s.mcNetwork.bds) s.mcNetwork.bds = []; return s.mcNetwork; }
  save() { this.ctx.settings.save(); }
  list() { return this.cfg.bds; }
  get(id) { const b = this.list().find((x) => x.id === id); if (!b) throw this.host.error(404, 'Bedrock server not found'); return b; }
  dir(b) { return path.join(this.root, b.id); }
  exe(b) { return path.join(this.dir(b), IS_WIN && this.platform === 'win' ? 'bedrock_server.exe' : 'bedrock_server'); }
  proc(b) {
    if (!this.procs.has(b.id)) {
      const p = new this.Proc(`bds:${b.id}`, `Bedrock: ${b.name}`);
      p.extra.players = [];
      p.restartFn = () => this.restart(b.id);
      this.procs.set(b.id, p);
    }
    return this.procs.get(b.id);
  }

  /** Newest official version for this platform: { version, url } */
  async latest() {
    const j = await this.net.fetchJson(LINKS);
    const want = this.platform === 'win' ? 'serverBedrockWindows' : 'serverBedrockLinux';
    const l = ((j && j.result && j.result.links) || []).find((x) => x.downloadType === want);
    if (!l || !versionOf(l.downloadUrl)) throw new Error(this.t('Mojang’s download list has no Bedrock server for this system right now.'));
    return { version: versionOf(l.downloadUrl), url: l.downloadUrl };
  }

  view(b) {
    const p = this.proc(b);
    return { id: b.id, name: b.name, port: b.port, portv6: b.portv6, version: b.version || null, public: !!b.public, autostart: !!b.autostart, installed: fs.existsSync(this.exe(b)), state: p.state, running: p.isRunning(), ready: !!p.extra.ready, players: p.extra.players || [], failed: b.failed || null, checkedAt: b.checkedAt || null, latest: b.latest || null, settings: this.settings(b) };
  }
  views() { return this.list().map((b) => this.view(b)); }
  /** UDP ports the BDS instances use (for the port choice of Geyser and the firewall/router). */
  usedPorts() { return this.list().flatMap((b) => [b.port, b.portv6]).filter(Boolean); }
  publicPorts() { return this.list().filter((b) => b.public).flatMap((b) => [{ port: b.port, proto: 'UDP', label: `Bedrock: ${b.name}` }, { port: b.portv6, proto: 'UDP', label: `Bedrock (IPv6): ${b.name}` }]); }

  /* ---------------- Settings (server.properties of BDS) ---------------- */

  static get FIELDS() {
    return {
      'server-name': (v) => String(v).replace(/[\r\n;]/g, ' ').slice(0, 60),
      gamemode: (v) => (['survival', 'creative', 'adventure'].includes(v) ? v : 'survival'),
      difficulty: (v) => (['peaceful', 'easy', 'normal', 'hard'].includes(v) ? v : 'normal'),
      'max-players': (v) => String(Math.max(1, Math.min(200, Math.round(Number(v)) || 10))),
      'allow-cheats': (v) => String(v === true || v === 'true'),
      'online-mode': (v) => String(v === true || v === 'true'),
      'allow-list': (v) => String(v === true || v === 'true'),
      'view-distance': (v) => String(Math.max(5, Math.min(64, Math.round(Number(v)) || 32))),
      'level-seed': (v) => String(v).replace(/[^\w-]/g, '').slice(0, 32),
      'default-player-permission-level': (v) => (['visitor', 'member', 'operator'].includes(v) ? v : 'member'),
    };
  }
  settings(b) {
    try {
      const p = C.readProps(fs.readFileSync(path.join(this.dir(b), 'server.properties'), 'utf8'));
      return Object.fromEntries(Object.keys(BedrockServers.FIELDS).map((k) => [k, p[k] ?? null]));
    } catch { return null; }
  }
  setSettings(id, values = {}) {
    const b = this.get(id);
    const f = path.join(this.dir(b), 'server.properties');
    if (!fs.existsSync(f)) throw this.host.error(409, 'The server is not installed yet.');
    const out = {};
    for (const [k, fn] of Object.entries(BedrockServers.FIELDS)) if (values[k] !== undefined) out[k] = fn(values[k]);
    fs.writeFileSync(f, C.writeProps(fs.readFileSync(f, 'utf8'), out));
    if (values.public !== undefined) { b.public = !!values.public; this.portsChanged(); }
    if (values.autostart !== undefined) b.autostart = !!values.autostart;
    if (values.name !== undefined) b.name = String(values.name).trim().slice(0, 60) || b.name;
    this.save();
    return { ...this.view(b), restartNeeded: this.proc(b).isRunning() && Object.keys(out).length > 0 };
  }
  portsChanged() { const r = this.ctx.router; if (r && r.cfg && r.cfg.auto && typeof r.sync === 'function') r.sync().catch(() => {}); }

  /* ---------------- Install, update ---------------- */

  /** New BDS: body { name, eula: true, port?, public?, gamemode?, difficulty? }. usedUdp: ports others use. */
  create(body = {}, usedUdp = new Set()) {
    if (body.eula !== true) throw this.host.error(400, 'Please accept the Minecraft EULA and Mojang’s privacy policy first.');
    const name = String(body.name || '').trim().slice(0, 60) || 'Bedrock';
    const used = new Set([...usedUdp, ...this.usedPorts()]);
    const port = Number(body.port) && !used.has(Number(body.port)) ? Number(body.port) : C.pickPort(19132, used);
    used.add(port);
    const portv6 = C.pickPort(port + 1, used);
    if (!port || !portv6) throw this.host.error(409, 'No free UDP port found between 19132 and 19331.');
    const b = { id: crypto.randomBytes(4).toString('hex'), name, port, portv6, public: !!body.public, autostart: false, eulaAt: Date.now(), createdAt: Date.now() };
    this.list().push(b);
    this.save();
    return this.net.runJob(this.t('Set up Bedrock server “{name}”', { name }), async (job) => {
      try {
        const l = await this.latest();
        await this.installTo(this.dir(b), l, job);
        const f = path.join(this.dir(b), 'server.properties');
        fs.writeFileSync(f, C.writeProps(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '', {
          'server-name': name, 'server-port': String(port), 'server-portv6': String(portv6),
          gamemode: BedrockServers.FIELDS.gamemode(body.gamemode), difficulty: BedrockServers.FIELDS.difficulty(body.difficulty), 'online-mode': 'true',
        }));
        b.version = l.version; b.checkedAt = Date.now();
        this.save();
        if (b.public) this.portsChanged();
        return { id: b.id, version: l.version };
      } catch (e) {
        this.cfg.bds = this.list().filter((x) => x.id !== b.id);
        this.save();
        fs.rmSync(this.dir(b), { recursive: true, force: true });
        throw e;
      }
    }, { key: `mc-network-bds-create-${name.toLowerCase()}` });
  }
  /** Download (Mojang) + unpack into dir. The zip has no published checksum – the unpack itself checks it (CRC of every file). */
  async installTo(dir, l, job) {
    const tmp = path.join(this.root, `.download-${crypto.randomBytes(3).toString('hex')}.zip`);
    fs.mkdirSync(this.root, { recursive: true });
    try {
      if (job) job.progress(10, this.t('Downloading Bedrock server {v} …', { v: l.version }));
      await this.net.downloadFile(l.url, tmp, { browser: true });
      if (job) job.progress(70, this.t('Unpacking …'));
      fs.mkdirSync(dir, { recursive: true });
      await this.net.extractZip(tmp, dir);
      if (!IS_WIN) { try { fs.chmodSync(path.join(dir, 'bedrock_server'), 0o755); } catch { /* not there */ } }
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  async checkUpdate(id) {
    const b = this.get(id);
    const l = await this.latest();
    b.checkedAt = Date.now();
    b.latest = l.version;
    this.save();
    if (!b.version || cmpVer(l.version, b.version) <= 0 || b.failed === l.version) return { upToDate: true, version: b.version, latest: l.version };
    return { upToDate: false, version: b.version, latest: l.version };
  }
  /**
   * Update with a way back: the new version is unpacked next to the old one, the person's files move over, the folders
   * are swapped, the server starts and must answer – otherwise the old folder comes back. Only when nobody is online.
   */
  update(id, { force = false } = {}) {
    const b = this.get(id);
    const p = this.proc(b);
    if (!force && (p.extra.players || []).length) throw this.host.error(409, 'Players are online – the update waits until nobody plays.');
    return this.net.runJob(this.t('Update Bedrock server “{name}”', { name: b.name }), async (job) => {
      const l = await this.latest();
      if (b.version && cmpVer(l.version, b.version) <= 0) return { upToDate: true, version: b.version };
      const dir = this.dir(b); const neu = `${dir}.neu`; const alt = `${dir}.alt`;
      fs.rmSync(neu, { recursive: true, force: true });
      await this.installTo(neu, l, job);
      const wasRunning = p.isRunning();
      if (wasRunning) await this.stop(id);
      job.progress(80, this.t('Moving worlds and settings over …'));
      for (const k of KEEP) { const src = path.join(dir, k); if (fs.existsSync(src)) { fs.rmSync(path.join(neu, k), { recursive: true, force: true }); fs.cpSync(src, path.join(neu, k), { recursive: true }); } }
      fs.rmSync(alt, { recursive: true, force: true });
      fs.renameSync(dir, alt);
      fs.renameSync(neu, dir);
      const prev = b.version;
      b.version = l.version;
      this.save();
      try {
        await this.start(id);
        if (!(await this.probe(b))) throw new Error(this.t('the server did not answer'));
        fs.rmSync(alt, { recursive: true, force: true });
        delete b.failed;
        this.save();
        this.note(b, true, this.t('Version {v} runs.', { v: l.version }));
        if (!wasRunning) await this.stop(id);
        return { version: l.version };
      } catch (e) {
        await this.stop(id).catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(alt, dir);
        b.version = prev; b.failed = l.version;
        this.save();
        const text = this.t('Update to {v} rolled back ({why}) – version {old} runs again.', { v: l.version, why: e.message, old: prev });
        this.note(b, false, text);
        try { this.host.notifications.notify('update-failed', { title: this.t('Bedrock server update rolled back'), text: `${b.name}: ${text}`, kind: 'warn' }); } catch { /* not registered */ }
        if (wasRunning) await this.start(id).catch(() => {});
        throw new Error(text);
      }
    }, { key: `mc-network-bds-update-${id}` });
  }
  note(b, ok, text) { try { if (this.ctx.keeper) this.ctx.keeper.record(`mc-network-bds-${b.id}`, { ok, label: `Bedrock server (${b.name})`, text }); } catch { /* no keeper */ } }
  /** Ready line seen and the UDP port answers. */
  async probe(b, ms = START_MS) {
    const p = this.proc(b);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!p.isRunning()) return false;
      if (p.extra.ready && await this.ping(b.port).catch(() => null)) return true;
      await sleep(1000);
    }
    return false;
  }
  /** Every 6 hours: check; install when nobody is online (running servers are restarted, stopped ones just updated). */
  async updateTick() {
    for (const b of this.list()) {
      try {
        const r = await this.checkUpdate(b.id);
        if (r.upToDate) { this.note(b, true, this.t('Up to date ({v}).', { v: b.version })); continue; }
        if ((this.proc(b).extra.players || []).length) continue;
        await this.update(b.id).promise.catch(() => {});
      } catch (e) { this.note(b, false, this.t('Update check failed: {msg}', { msg: e.message })); }
    }
  }

  /* ---------------- Running ---------------- */

  async start(id) {
    const b = this.get(id);
    const p = this.proc(b);
    if (p.isRunning()) return;
    if (!fs.existsSync(this.exe(b))) throw this.host.error(409, 'The server is not installed yet.');
    p.setExtra({ players: [], ready: false });
    await p.start({
      cmd: this.exe(b), args: [], cwd: this.dir(b), stdin: true,
      env: IS_WIN ? {} : { LD_LIBRARY_PATH: this.dir(b) },
      onLine: (line) => this.onLine(b, line),
      ready: () => new Promise((r) => setTimeout(r, 1500)),
    });
  }
  onLine(b, line) {
    const p = this.proc(b);
    const clean = String(line).replace(/\x1b\[[0-9;]*m/g, '');
    if (/Server started\./.test(clean)) p.setExtra({ ready: true });
    let m = clean.match(/Player connected:\s*([^,]+),\s*xuid/);
    if (m && !p.extra.players.includes(m[1].trim())) p.setExtra({ players: [...p.extra.players, m[1].trim()] });
    m = clean.match(/Player disconnected:\s*([^,]+),\s*xuid/);
    if (m) p.setExtra({ players: p.extra.players.filter((x) => x !== m[1].trim()) });
  }
  async stop(id) {
    const b = this.get(id);
    const p = this.proc(b);
    await p.stop({ graceful: async () => p.write('stop'), timeout: 30000 });
    p.setExtra({ ready: false, players: [] });
  }
  async restart(id) { await this.stop(id); await this.start(id); }
  command(id, cmd) {
    const c = String(cmd || '').replace(/[\r\n]/g, ' ').trim().slice(0, 300);
    if (!c) throw this.host.error(400, 'Empty command');
    this.proc(this.get(id)).write(c);
    return { ok: true };
  }
  log(id, n = 200) { return this.proc(this.get(id)).logs.slice(-Math.min(1000, n)).map((x) => ({ t: x.t, s: x.s, l: x.l })); }
  async remove(id, { files = false } = {}) {
    const b = this.get(id);
    if (this.proc(b).isRunning()) await this.stop(id);
    this.cfg.bds = this.list().filter((x) => x.id !== id);
    this.save();
    if (files) fs.rmSync(this.dir(b), { recursive: true, force: true });
    this.portsChanged();
    return { ok: true };
  }
  /**
   * Hostwerk 3.x knows Bedrock as a server type of its own (Minecraft area: console, settings, worlds, backups, allow list,
   * updates with a way back). Move a server of this extension there: same folder content, same ports, same worlds.
   * mc: Hostwerk's Minecraft manager (with isBedrock). → { id } of the server in Hostwerk's list
   */
  async moveToCore(id, mc) {
    if (!mc || typeof mc.isBedrock !== 'function') throw this.host.error(400, 'This Hostwerk has no Bedrock server type yet – please update Hostwerk.');
    const b = this.get(id);
    const wasRunning = this.proc(b).isRunning();
    if (wasRunning) await this.stop(id);
    const slug = (x) => String(x || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bedrock';
    let nid = slug(b.name);
    while (mc.list().some((s) => s.id === nid) || fs.existsSync(mc.paths.mcDir(nid))) nid = `${slug(b.name)}-${crypto.randomBytes(2).toString('hex')}`;
    const from = this.dir(b);
    const to = mc.paths.mcDir(nid);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.renameSync(from, to); } catch { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
    mc.list().push({
      id: nid, name: b.name, type: 'bedrock', version: b.version || null, build: null, port: b.port, portv6: b.portv6,
      memMin: null, memMax: null, javaMajor: null, jvmFlags: null, extraArgs: '', autostart: !!b.autostart, autoRestart: true,
      createdAt: b.createdAt || Date.now(), eulaAt: b.eulaAt || Date.now(), movedFrom: 'mc-network',
      nightlyBackup: { enabled: true, everyHours: 24, keep: 7, hour: 3, since: Date.now() },
    });
    this.cfg.bds = this.list().filter((x) => x.id !== id);
    this.procs.delete(id);
    this.save();
    if (typeof mc.proc === 'function') mc.proc(nid);
    if (wasRunning) await mc.start(nid).catch(() => {});
    this.portsChanged();
    return { id: nid };
  }
  autostartTasks(want) { return this.list().filter((b) => want(b.autostart, `bds:${b.id}`)).map((b) => () => this.start(b.id).catch(() => {})); }
  async stopAll() { for (const b of this.list()) { try { if (this.proc(b).isRunning()) await this.stop(b.id); } catch { /* next */ } } }
}

module.exports = { BedrockServers, versionOf, cmpVer, KEEP, LINKS };
