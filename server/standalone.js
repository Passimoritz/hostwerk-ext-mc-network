'use strict';
/*
 * Geyser Standalone – Bedrock access for Java servers that cannot load Geyser as a plugin or mod (Vanilla, Forge, own JARs,
 * Forge modpacks). Geyser runs as its own small Java program in front of the server: Bedrock players connect to its UDP
 * port, it translates and connects to the Java server like a normal Java player (127.0.0.1:<server port>).
 *
 * Honest limits (shown in the UI): Floodgate needs a plugin/mod on the server – without it Bedrock players need a Java
 * account (Microsoft account that owns Minecraft Java) and sign in once with it (auth-type "online"). For an offline server
 * (online-mode=false) auth-type "offline" is used. Geyser always speaks the newest Java version – older servers need a
 * bridge (ViaVersion is a plugin, so on Vanilla: keep the server up to date).
 *
 * Coupled to the server: starts when the Java server is ready, stops when it stops (Hostwerk's "service" events). Own
 * process "geyser:<id>" (console, self-healing like every Hostwerk process).
 *
 * Keeping itself up to date with a way back: GeyserMC's download API (standalone package, SHA-256). The new jar goes next to
 * the old one (.hostwerk-neu), is swapped in (old one to .hostwerk-alt) and Geyser is restarted ALONE – the Java server keeps
 * running. Probe: "Done (…)!" in the log and an answer on the UDP port (RakNet ping) within 3 minutes. Otherwise the old jar
 * comes back, the build is remembered as failed and skipped until a newer one exists.
 *
 * Data: the "geyser" entry of the server (same place as Geyser as a plugin, so firewall/router and port choice see it):
 *   { mode: 'standalone', port, floodgate: false, builds: { standalone }, failed, checkedAt, settings, at }
 * Files: <server folder>/geyser-standalone/ (Geyser-Standalone.jar, config.yml, logs/)
 */
const fs = require('fs');
const path = require('path');
const C = require('./configs');
const { bedrockPing, sleep } = require('./bedrock');

const DIR = 'geyser-standalone';
const JAR = 'Geyser-Standalone.jar';
const STAGE = '.hostwerk-neu';
const ALT = '.hostwerk-alt';
const PROBE_MS = 3 * 60000;
/** Ready line of Geyser in any language: "Done (2.345s)! Run /geyser help for help!" / "Fertig (2,345s)! Verwende /geyser help …" */
const READY = /\(\d+[.,]\d+s\)!.*\/?geyser help/i;
/** Server types where Geyser runs as a plugin/mod – Standalone is only offered for the others. */
const PLUGIN_TYPES = ['paper', 'purpur', 'spigot', 'folia', 'fabric', 'neoforge', 'velocity', 'bungeecord'];

class GeyserStandalone {
  /**
   * host · mc: Hostwerk's Minecraft manager · bedrock: the Geyser part (latest/download/freePort) · net: { runJob }
   * opts: { Proc (ManagedProcess), ping, javaExe(s) → path, probeMs }
   */
  constructor(host, mc, bedrock, net, opts = {}) {
    this.host = host; this.ctx = host.ctx; this.t = host.t; this.mc = mc; this.bedrock = bedrock; this.net = net;
    this.Proc = opts.Proc || host.core('proc').ManagedProcess;
    this.ping = opts.ping || bedrockPing;
    this.javaExeFn = opts.javaExe || null;
    this.probeMs = opts.probeMs || PROBE_MS;
    this.procs = new Map();
  }
  save() { this.ctx.settings.save(); }
  note(s, ok, text, version) { try { if (this.ctx.keeper) this.ctx.keeper.record(`mc-network-standalone-${s.id}`, { ok, label: `Geyser Standalone (${s.name})`, text, ...(version ? { version } : {}) }); } catch { /* no keeper */ } }

  /** Can this server get Geyser Standalone? → { ok, why } */
  possible(s) {
    if (!s) return { ok: false, why: this.t('Server not found.') };
    if (this.mc.isProxy(s)) return { ok: false, why: this.t('On a proxy Geyser runs as a plugin.') };
    if (typeof this.mc.isBedrock === 'function' && this.mc.isBedrock(s)) return { ok: false, why: this.t('This is a Bedrock server – Bedrock players join it directly.') };
    if (s.network && s.network.proxy) return { ok: false, why: this.t('This server is behind a proxy – Bedrock players come in through the proxy.') };
    if (PLUGIN_TYPES.includes(s.type)) return { ok: false, why: this.t('Geyser runs as a plugin or mod on this server – that is the better way (with Floodgate).') };
    return { ok: true };
  }
  is(s) { return !!(s && s.geyser && s.geyser.mode === 'standalone'); }
  dir(id) { return path.join(this.mc.dir(id), DIR); }
  jar(id) { return path.join(this.dir(id), JAR); }
  proc(id) {
    if (!this.procs.has(id)) {
      let name = id; try { name = this.mc.get(id).name; } catch { /* gone */ }
      const p = new this.Proc(`geyser:${id}`, `Geyser: ${name}`);
      p.extra = p.extra || {};
      p.restartFn = () => this.restart(id);
      this.procs.set(id, p);
    }
    return this.procs.get(id);
  }
  /** Is the Java server online-mode? (Geyser needs auth-type "offline" for an offline server.) */
  onlineMode(id) { try { return C.readProps(fs.readFileSync(path.join(this.mc.dir(id), 'server.properties'), 'utf8'))['online-mode'] !== 'false'; } catch { return true; } }
  defaults() { return { address: '0.0.0.0', motd1: '', motd2: '', serverName: '', passthrough: true, maxPlayers: 100, showCoordinates: true }; }

  status(id) {
    const s = this.mc.get(id);
    const g = s.geyser && s.geyser.mode === 'standalone' ? s.geyser : null;
    const p = this.proc(id);
    const pos = this.possible(s);
    return {
      id, name: s.name, type: s.type, mode: 'standalone', standalone: true, possible: pos.ok, why: pos.why || null, enabled: !!g,
      port: g ? g.port : null, floodgate: false, authType: this.onlineMode(id) ? 'online' : 'offline',
      build: g && g.builds ? g.builds.standalone || null : null, failed: g && g.failed ? g.failed : null, checkedAt: g ? g.checkedAt || null : null,
      latest: g ? g.latest || null : null, state: p.state, running: p.isRunning(), ready: !!(p.extra && p.extra.ready),
      serverRunning: this.mc.proc(id).isRunning(), settings: g ? { ...this.defaults(), ...(g.settings || {}) } : null,
    };
  }

  /** Geyser's config: classic layout (Geyser moves it to its current layout at the first start), remote = this server. */
  writeConfig(id) {
    const s = this.mc.get(id);
    const g = s.geyser;
    const set = { ...this.defaults(), ...(g.settings || {}) };
    const f = path.join(this.dir(id), 'config.yml');
    const conf = { port: g.port, address: set.address, authType: this.onlineMode(id) ? 'online' : 'offline', motd1: set.motd1 || s.name, motd2: set.motd2 || 'Java + Bedrock', serverName: set.serverName || s.name, passthrough: set.passthrough, maxPlayers: set.maxPlayers, showCoordinates: set.showCoordinates, remoteAddress: '127.0.0.1', remotePort: s.port };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, fs.existsSync(f) ? C.geyserPatchText(fs.readFileSync(f, 'utf8'), conf) : C.geyserConfigText(conf));
  }

  /** Java for Geyser (Java 21+): the server's own Java when it is new enough, else Hostwerk's Java 21. */
  async javaExe(s, job) {
    if (this.javaExeFn) return this.javaExeFn(s);
    if (s.javaPath && fs.existsSync(s.javaPath) && Number(s.javaMajor) >= 21) return s.javaPath;
    const java = this.ctx.services && this.ctx.services.java;
    if (!java) throw new Error(this.t('Java is not available.'));
    const major = Number(s.javaMajor) >= 21 ? Number(s.javaMajor) : 21;
    if (!java.isInstalled(major)) await java.ensure(major, job || { progress() {}, log() {}, status() {} });
    return java.exe(major);
  }

  /* ---------------- On / off ---------------- */

  /** Switch Geyser Standalone on: download (SHA-256), free UDP port, config; starts right away when the server runs. */
  enable(id, { settings = {} } = {}) {
    const s = this.mc.get(id);
    const pos = this.possible(s);
    if (!pos.ok) throw this.host.error(400, pos.why);
    return this.net.runJob(this.t('Geyser Standalone for “{name}”', { name: s.name }), async (job) => {
      const dir = this.dir(id);
      try {
        job.progress(5, this.t('Downloading Geyser …'));
        const info = await this.bedrock.download('geyser', 'standalone', dir, JAR);
        const port = s.geyser && s.geyser.port ? s.geyser.port : await this.bedrock.freePort(id);
        s.geyser = { mode: 'standalone', port, floodgate: false, at: Date.now(), builds: { standalone: info.build }, checkedAt: Date.now(), settings: { ...this.defaults(), ...this.clean(settings) } };
        this.writeConfig(id);
        this.save();
        job.progress(70, this.t('Starting Geyser …'));
        let started = false;
        if (this.mc.proc(id).isRunning()) { await this.start(id); started = true; }
        if (this.ctx.router && this.ctx.router.cfg && this.ctx.router.cfg.auto && typeof this.ctx.router.sync === 'function') await this.ctx.router.sync().catch(() => {});
        return { port, build: info.build, started };
      } catch (e) {
        delete s.geyser;
        this.save();
        fs.rmSync(dir, { recursive: true, force: true });
        throw e;
      }
    }, { key: `mc-network-standalone-${id}` });
  }
  clean(b = {}) {
    const out = {};
    if (b.address !== undefined) out.address = ['0.0.0.0', '127.0.0.1', '::'].includes(String(b.address)) ? String(b.address) : '0.0.0.0';
    for (const k of ['motd1', 'motd2']) if (b[k] !== undefined) out[k] = String(b[k]).replace(/[\r\n]/g, ' ').slice(0, 80);
    if (b.serverName !== undefined) out.serverName = String(b.serverName).replace(/[\r\n]/g, ' ').slice(0, 40);
    if (b.maxPlayers !== undefined) out.maxPlayers = Math.max(1, Math.min(10000, Math.round(Number(b.maxPlayers)) || 100));
    for (const k of ['passthrough', 'showCoordinates']) if (b[k] !== undefined) out[k] = !!b[k];
    return out;
  }
  setSettings(id, b = {}) {
    const s = this.mc.get(id);
    if (!this.is(s)) throw this.host.error(409, 'Geyser Standalone is off.');
    s.geyser.settings = { ...this.defaults(), ...(s.geyser.settings || {}), ...this.clean(b) };
    this.writeConfig(id);
    this.save();
    return { ...this.status(id), restartNeeded: this.proc(id).isRunning() };
  }
  async disable(id) {
    const s = this.mc.get(id);
    if (!this.is(s)) return this.status(id);
    await this.stop(id).catch(() => {});
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    delete s.geyser;
    this.save();
    if (this.ctx.router && this.ctx.router.cfg && this.ctx.router.cfg.auto && typeof this.ctx.router.sync === 'function') await this.ctx.router.sync().catch(() => {});
    return this.status(id);
  }

  /* ---------------- Running ---------------- */

  async start(id) {
    const s = this.mc.get(id);
    if (!this.is(s)) return;
    const p = this.proc(id);
    if (p.isRunning()) return;
    if (!fs.existsSync(this.jar(id))) throw new Error(this.t('Geyser is missing – switch it off and on again.'));
    this.writeConfig(id); // port of the server may have changed
    const java = await this.javaExe(s);
    if (p.setExtra) p.setExtra({ ready: false }); else p.extra.ready = false;
    await p.start({
      cmd: java, args: ['-Xms64M', '-Xmx512M', '-jar', JAR, '--nogui'], cwd: this.dir(id), stdin: true,
      onLine: (line) => {
        const clean = String(line).replace(/\x1b\[[0-9;]*m/g, '');
        // Geyser writes the ready line in the system language ("Done (2.4s)!", "Fertig (2,4s)!" …) – the time in brackets
        // and the help hint are the same in every language
        if (READY.test(clean) && !(p.extra && p.extra.ready)) { if (p.setExtra) p.setExtra({ ready: true }); else p.extra.ready = true; }
      },
      ready: () => new Promise((r) => setTimeout(r, 1000)),
    });
  }
  async stop(id) {
    const p = this.proc(id);
    if (!p.isRunning()) return;
    await p.stop({ graceful: async () => p.write('geyser stop'), timeout: 15000 });
    if (p.setExtra) p.setExtra({ ready: false }); else p.extra.ready = false;
  }
  async restart(id) { await this.stop(id); await this.start(id); }

  /** Hostwerk's "service" event: Geyser follows its Java server (ready → start, stopped/crashed → stop). */
  onService(m) {
    const svc = String((m && m.svc) || '');
    if (!svc.startsWith('mc:')) return;
    const id = svc.slice(3);
    let s; try { s = this.mc.get(id); } catch { return; }
    if (!this.is(s) || this.updating === id) return;
    const info = m.info || {};
    const p = this.proc(id);
    if (info.state === 'running' && info.extra && info.extra.ready && !p.isRunning()) this.start(id).catch((e) => this.host.log(`Geyser Standalone ${id}:`, e.message));
    else if (['stopped', 'error', 'stopping'].includes(info.state) && p.isRunning()) this.stop(id).catch(() => {});
  }
  /** On activation: servers that already run get their Geyser. */
  startRunning() { for (const s of this.mc.list()) if (this.is(s)) { const mp = this.mc.proc(s.id); if (mp.isRunning() && mp.extra && mp.extra.ready) this.start(s.id).catch(() => {}); } }
  async stopAll() { for (const id of this.procs.keys()) await this.stop(id).catch(() => {}); }

  /** Geyser answers on its port after "Done"? */
  async probe(id, ms = this.probeMs) {
    const s = this.mc.get(id);
    const p = this.proc(id);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!p.isRunning()) return false;
      if (p.extra && p.extra.ready && await this.ping(s.geyser.port).catch(() => null)) return true;
      await sleep(1000);
    }
    return false;
  }

  /* ---------------- Updates with a way back ---------------- */

  async checkUpdate(id) {
    const s = this.mc.get(id);
    if (!this.is(s)) return null;
    const info = await this.bedrock.latest('geyser', 'standalone');
    s.geyser.checkedAt = Date.now();
    s.geyser.latest = info.build;
    this.save();
    const have = (s.geyser.builds || {}).standalone;
    const fresh = info.build !== have && info.build !== s.geyser.failed;
    if (!fresh) this.note(s, true, this.t('Up to date (build {b}).', { b: have || '?' }));
    return { update: fresh, build: have, latest: info.build, info };
  }
  /**
   * New build in: stage (checksum), swap, restart Geyser alone (the Java server keeps running), probe. Probe fails → old jar
   * back, build skipped. When Geyser is not running it is started for the probe and stopped again. Only when nobody plays.
   */
  update(id, { force = false, info = null } = {}) {
    const s = this.mc.get(id);
    if (!this.is(s)) throw this.host.error(409, 'Geyser Standalone is off.');
    const players = ((this.mc.proc(id).extra || {}).players || []).length;
    if (!force && players) throw this.host.error(409, 'Players are online – the update waits until nobody plays.');
    return this.net.runJob(this.t('Update Geyser Standalone for “{name}”', { name: s.name }), async (job) => {
      const want = info || (await this.bedrock.latest('geyser', 'standalone'));
      const g = s.geyser;
      const prev = (g.builds || {}).standalone || null;
      if (want.build === prev && !force) return { upToDate: true, build: prev };
      const dir = this.dir(id);
      job.progress(10, this.t('Downloading Geyser …'));
      fs.rmSync(path.join(dir, STAGE), { recursive: true, force: true });
      await this.bedrock.download('geyser', 'standalone', path.join(dir, STAGE), JAR, want);
      const wasRunning = this.proc(id).isRunning();
      this.updating = id;
      try {
        if (wasRunning) await this.stop(id);
        fs.rmSync(path.join(dir, ALT), { recursive: true, force: true });
        fs.mkdirSync(path.join(dir, ALT), { recursive: true });
        if (fs.existsSync(this.jar(id))) fs.renameSync(this.jar(id), path.join(dir, ALT, JAR));
        fs.renameSync(path.join(dir, STAGE, JAR), this.jar(id));
        fs.rmSync(path.join(dir, STAGE), { recursive: true, force: true });
        g.builds = { ...(g.builds || {}), standalone: want.build };
        this.save();
        job.progress(60, this.t('Probe start …'));
        await this.start(id);
        if (!(await this.probe(id))) throw new Error(this.proc(id).isRunning() ? this.t('Geyser did not answer on port {port}', { port: g.port }) : this.t('Geyser stopped right after the start'));
        fs.rmSync(path.join(dir, ALT), { recursive: true, force: true });
        delete g.failed;
        this.save();
        this.note(s, true, this.t('Update confirmed – Geyser answers.'), want.build);
        if (!wasRunning) await this.stop(id);
        return { build: want.build, previous: prev };
      } catch (e) {
        await this.stop(id).catch(() => {});
        const alt = path.join(dir, ALT, JAR);
        if (fs.existsSync(alt)) { fs.rmSync(this.jar(id), { force: true }); fs.renameSync(alt, this.jar(id)); }
        fs.rmSync(path.join(dir, ALT), { recursive: true, force: true });
        g.builds = { ...(g.builds || {}), standalone: prev };
        g.failed = want.build;
        this.save();
        const text = this.t('Update {b} rolled back ({why}) – the previous version runs again. Hostwerk skips this build.', { b: want.build, why: e.message });
        this.note(s, false, text);
        try { this.host.notifications.notify('update-failed', { title: this.t('Geyser update rolled back'), text: `${s.name}: ${text}`, kind: 'warn' }); } catch { /* not registered */ }
        if (wasRunning) await this.start(id).catch(() => {});
        throw new Error(text);
      } finally { this.updating = null; }
    }, { key: `mc-network-standalone-update-${id}` });
  }
  /** Every 6 hours: look for a new build, put it in when nobody plays. */
  async checkAll() {
    for (const s of this.mc.list()) {
      if (!this.is(s)) continue;
      try {
        const r = await this.checkUpdate(s.id);
        if (!r || !r.update) continue;
        if (((this.mc.proc(s.id).extra || {}).players || []).length) continue;
        await this.update(s.id, { info: r.info }).promise.catch(() => {});
      } catch (e) { this.note(s, false, this.t('Update check failed: {msg}', { msg: e.message })); }
    }
  }
  log(id, n = 200) { return this.proc(id).logs.slice(-Math.min(1000, n)).map((x) => ({ t: x.t, s: x.s, l: x.l })); }
}

module.exports = { GeyserStandalone, PLUGIN_TYPES, DIR, JAR, READY };
