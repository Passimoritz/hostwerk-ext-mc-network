'use strict';
/*
 * Version bridges: ViaVersion (newer clients on an older server), ViaBackwards (older clients on a newer server, needs
 * ViaVersion) and ViaRewind (very old clients 1.7–1.8, needs both).
 *
 * Where they belong: on the Paper/Purpur/Folia servers – in a network on EVERY server behind the proxy, so a player can
 * switch between servers. The proxy itself (Velocity/BungeeCord) already accepts all client versions; on the proxy Via would
 * only translate for the proxy, and Geyser on the proxy talks to the servers behind it with the newest Java version – so the
 * servers need ViaVersion when they run an older Minecraft version. A single server without a proxy gets them directly.
 *
 * Installed through Hostwerk's own Modrinth installer (mc.modrinthInstall – right version for the server's Minecraft
 * version, SHA-1 checked). From then on Hostwerk's automatic plugin updates keep them current (Modrinth, by file hash).
 */
const fs = require('fs');
const path = require('path');

const VIA = {
  viaversion: { slug: 'viaversion', name: 'ViaVersion', re: /^viaversion[-_ ].*\.jar$/i, needs: [] },
  viabackwards: { slug: 'viabackwards', name: 'ViaBackwards', re: /^viabackwards[-_ ].*\.jar$/i, needs: ['viaversion'] },
  viarewind: { slug: 'viarewind', name: 'ViaRewind', re: /^viarewind[-_ ].*\.jar$/i, needs: ['viaversion', 'viabackwards'] },
};
const TYPES = ['paper', 'purpur', 'folia', 'spigot'];

class Via {
  constructor(host, mc) { this.host = host; this.mc = mc; this.t = host.t; this.autoFor = null; }

  /** The servers the bridges belong on for this server: behind a proxy → all servers of its network; a proxy → its servers. */
  targets(id) {
    const s = this.mc.get(id);
    const proxy = this.mc.isProxy(s) ? id : s.network && s.network.proxy;
    if (!proxy) return [s];
    return this.mc.list().filter((x) => x.network && x.network.proxy === proxy);
  }
  supported(s) { return TYPES.includes(s.type); }
  files(id) { try { return fs.readdirSync(this.mc.addonDir(id)); } catch { return []; } }
  has(id, key) { const v = VIA[key]; return !!v && this.files(id).some((f) => v.re.test(f)); }

  status(id) {
    return this.targets(id).map((s) => ({ id: s.id, name: s.name, type: s.type, version: s.version, supported: this.supported(s), ...Object.fromEntries(Object.keys(VIA).map((k) => [k, this.has(s.id, k)])) }));
  }

  /** Install bridges (with what they need) on one server. Already there → nothing. */
  async install(id, keys) {
    const s = this.mc.get(id);
    if (!this.supported(s)) throw this.host.error(400, this.t('Version bridges need Paper, Purpur, Folia or Spigot – “{name}” is {type}.', { name: s.name, type: s.type }));
    const want = new Set();
    for (const k of keys) { if (!VIA[k]) continue; for (const n of VIA[k].needs) want.add(n); want.add(k); }
    const done = [];
    for (const k of Object.keys(VIA).filter((x) => want.has(x))) {
      if (this.has(id, k)) continue;
      await this.mc.modrinthInstall(id, VIA[k].slug).promise;
      done.push(VIA[k].name);
    }
    return done;
  }
  /** Remove a bridge – and the ones that need it. */
  remove(id, key) {
    const drop = Object.keys(VIA).filter((k) => k === key || VIA[k].needs.includes(key));
    const dir = this.mc.addonDir(id);
    const gone = [];
    for (const f of this.files(id)) if (drop.some((k) => VIA[k].re.test(f))) { fs.rmSync(path.join(dir, f), { force: true }); gone.push(f); }
    return gone;
  }
  /** Same bridges on every target of a network (what the page's switches mean). */
  async apply(id, want) {
    const out = [];
    for (const s of this.targets(id)) {
      if (!this.supported(s)) { out.push({ id: s.id, name: s.name, ok: false, why: this.t('not possible for {type}', { type: s.type }) }); continue; }
      try {
        const on = Object.keys(VIA).filter((k) => want[k]);
        const added = on.length ? await this.install(s.id, on) : [];
        const removed = [];
        for (const k of Object.keys(VIA)) if (want[k] === false && this.has(s.id, k)) removed.push(...this.remove(s.id, k));
        out.push({ id: s.id, name: s.name, ok: true, added, removed, restart: (added.length || removed.length) && this.mc.proc(s.id).isRunning() });
      } catch (e) { out.push({ id: s.id, name: s.name, ok: false, why: e.message }); }
    }
    return out;
  }
}

module.exports = { Via, VIA, TYPES };
