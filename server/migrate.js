'use strict';
/*
 * Moving over from the "Bedrock bridge" extension (and from networks set up in Hostwerk's Minecraft area).
 *
 * Nothing has to be copied: the bridge kept its state in the "geyser" entry of each Minecraft server, Floodgate's key in
 * plugins/floodgate/key.pem and its port in that entry – this extension reads exactly the same places. What happens here:
 *   1. Every server with Geyser gets its settings read from its real config files (MOTD, name, prefix, auth type) so the
 *      page shows what is actually in effect; mode = proxy or single server.
 *   2. Velocity proxies with servers behind them become networks on this page (taken over, nothing changes on disk).
 *   3. Geyser on a server BEHIND a proxy (what the bridge allowed per server) is wrong: Bedrock players reach the network
 *      through the proxy. Such cases are listed with a one-click move (moveToProxy): Geyser goes onto the proxy with the
 *      SAME UDP port (friends keep their address) and the SAME Floodgate key; Geyser leaves the servers behind it,
 *      Floodgate stays there. Not automatic, because servers have to restart for it.
 * Runs once per install (settings.mcNetwork.migrated) and is safe to run again.
 */
const fs = require('fs');
const path = require('path');
const C = require('./configs');

function importSettings(bedrock, s) {
  const g = s.geyser;
  const f = bedrock.configFile(s.id);
  const read = f ? C.geyserRead(fs.readFileSync(f, 'utf8')) : {};
  let prefix = '.';
  try { const v = C.yamlGet(fs.readFileSync(path.join(bedrock.floodgateDir(s.id), 'config.yml'), 'utf8'), ['username-prefix']); if (typeof v === 'string' && v) prefix = v; } catch { /* default */ }
  g.settings = { ...bedrock.defaults(), ...(g.settings || {}), prefix, ...Object.fromEntries(['motd1', 'motd2', 'serverName', 'passthrough', 'maxPlayers', 'showCoordinates', 'xboxAchievements', 'authType'].filter((k) => read[k] !== undefined).map((k) => [k, read[k]])) };
  if (!g.mode) g.mode = bedrock.isProxy(s) ? 'proxy' : 'server';
}

/** → { imported: [serverIds], adopted: [networkIds], misplaced: [{ id, name, proxy, proxyName, port }] } */
function migrate(ctx, mc, bedrock, networks) {
  const st = ctx.settings.get();
  const out = { imported: [], adopted: [], misplaced: [] };
  for (const s of mc.list()) {
    if (!s.geyser) continue;
    if (!s.geyser.settings) { try { importSettings(bedrock, s); out.imported.push(s.id); } catch { /* unreadable config – defaults */ } }
  }
  for (const p of networks.proxies()) {
    if (!p.members.length || networks.byProxy(p.id)) continue;
    try { out.adopted.push(networks.adopt(p.id).id); } catch { /* not a network */ }
  }
  out.misplaced = misplaced(mc);
  st.mcNetwork = st.mcNetwork || { networks: [] };
  st.mcNetwork.migrated = { at: Date.now(), from: 'bedrock-bridge', imported: out.imported.length, adopted: out.adopted.length };
  ctx.settings.save();
  return out;
}

/** Geyser on servers behind a proxy (old bridge, per server) – belongs on the proxy. */
function misplaced(mc) {
  return mc.list().filter((s) => s.geyser && s.network && s.network.proxy).map((s) => {
    let proxyName = s.network.proxy; try { proxyName = mc.get(s.network.proxy).name; } catch { /* gone */ }
    return { id: s.id, name: s.name, proxy: s.network.proxy, proxyName, port: s.geyser.port };
  });
}

/**
 * Move Geyser from the servers behind a proxy onto the proxy: same port (the first one found), same key, Floodgate stays on
 * the servers. Geyser leaves the servers only after it runs on the proxy – a failure leaves everything as it was.
 */
function moveToProxy(mc, bedrock, proxyId, runJob) {
  const wrong = mc.list().filter((s) => s.geyser && s.network && s.network.proxy === proxyId);
  if (!wrong.length) throw Object.assign(new Error('Nothing to move.'), { status: 400 });
  const proxy = mc.get(proxyId);
  const keep = wrong[0];
  return runJob(bedrock.t('Move Bedrock access to “{name}”', { name: proxy.name }), async (job) => {
    // Key of the old installation becomes the network key (servers that already have it need no change)
    try {
      const key = fs.readFileSync(bedrock.keyFile(keep.id));
      if (!fs.existsSync(bedrock.keyFile(proxyId))) { fs.mkdirSync(path.dirname(bedrock.keyFile(proxyId)), { recursive: true }); fs.writeFileSync(bedrock.keyFile(proxyId), key); }
    } catch { /* no key – a new one is made */ }
    const settings = { ...(keep.geyser.settings || {}) };
    // Same port as before – the old Geyser has to let go of it first
    const port = keep.geyser.port;
    for (const s of wrong) { s.geyserMoving = s.geyser; delete s.geyser; }
    proxy.geyser = { ...(proxy.geyser || {}), port };
    mc.settings.save();
    try {
      await bedrock.enable(proxyId, { floodgate: true, settings }).promise;
    } catch (e) {
      for (const s of wrong) { s.geyser = s.geyserMoving; delete s.geyserMoving; }
      mc.settings.save();
      throw e;
    }
    // Geyser away from the servers behind the proxy (Floodgate and its key stay – the proxy needs them there)
    for (const s of wrong) {
      const dir = mc.addonDir(s.id);
      try { for (const f of fs.readdirSync(dir).filter((x) => /^geyser[-_].*\.jar$/i.test(x))) fs.rmSync(path.join(dir, f), { force: true }); } catch { /* none */ }
      for (const d of ['Geyser-Spigot', 'geyser']) { try { fs.rmSync(path.join(dir, d), { recursive: true, force: true }); } catch { /* none */ } }
      delete s.geyserMoving;
      job.log(bedrock.t('{name}: Geyser removed – Bedrock players come in through the proxy now.', { name: s.name }));
      if (mc.proc(s.id).isRunning()) s.geyserOff = { restartNeeded: true, at: Date.now() };
    }
    mc.settings.save();
    return { port, moved: wrong.map((s) => s.name) };
  }, { key: `mc-network-move-${proxyId}` });
}

module.exports = { migrate, misplaced, moveToProxy, importSettings };
