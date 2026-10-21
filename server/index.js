'use strict';
/*
 * Minecraft server network – everything around several Minecraft servers and platforms in one place:
 *   network.js  proxy networks (Velocity / BungeeCord), forced hosts, MOTD, maintenance, shared lists, order, checks
 *   bedrock.js  Bedrock access through Geyser + Floodgate (on the proxy, or on a single server), updates with a way back
 *   bds.js      Mojang's Bedrock Dedicated Server as the alternative (own Bedrock world)
 *   via.js      version bridges ViaVersion / ViaBackwards / ViaRewind, placed where they belong
 *   bungee.js   BungeeCord as a server type (SDK 3.2 mc.registerType, if Hostwerk offers it)
 *   migrate.js  taking over from the "Bedrock bridge" and from networks of Hostwerk's Minecraft area
 * Replaces the extension "Bedrock bridge" (same data, same places) and the Minecraft part of "Game server network".
 *
 * Hostwerk asks minecraft.geyser before every server start (applyStaged) and in its self-maintenance (checkAll) – this
 * extension takes that place. Service "bedrock" (isBedrock, status) stays for other extensions, as before.
 */
const { Bedrock } = require('./bedrock');
const { McNetworks } = require('./network');
const { BedrockServers } = require('./bds');
const { Via } = require('./via');
const { bungeeType } = require('./bungee');
const M = require('./migrate');

let state = null;

function activate(host) {
  const ctx = host.ctx;
  const mc = ctx.minecraft;
  const dl = host.core('download');
  const { runJob } = host.core('jobs');
  const net = { fetchJson: dl.fetchJson, downloadFile: dl.downloadFile, extractZip: dl.extractZip, runJob };
  const bedrock = new Bedrock(host, mc, net);
  const via = new Via(host, mc);
  bedrock.via = via;
  const networks = new McNetworks(host, mc, bedrock, net);
  const bds = new BedrockServers(host, net);
  // ViaVersion installs itself before a Geyser update when the network says so (default on)
  via.autoFor = (geyserHostId) => { const n = networks.byProxy(geyserHostId); return n ? !(n.via && n.via.auto === false) : true; };
  // Ports of the Bedrock Dedicated Servers are taken for Geyser's port choice too
  const usedUdp0 = bedrock.usedUdp.bind(bedrock);
  bedrock.usedUdp = (id, extra = []) => usedUdp0(id, [...extra, ...bds.usedPorts()]);

  mc.geyser = bedrock;
  const timers = [];
  const offs = [];
  if (typeof mc.registerType === 'function') { try { offs.push(mc.registerType('bungeecord', bungeeType(net), host.id)); } catch (e) { host.log('BungeeCord type:', e.message); } }
  if (ctx.security && typeof ctx.security.addPortProvider === 'function') { ctx.security.addPortProvider('mc-network', () => bds.publicPorts()); offs.push(() => ctx.security.removePortProvider && ctx.security.removePortProvider('mc-network')); }
  try { host.notifications.register('update-failed', { de: 'Netzwerk-Update zurückgenommen', en: 'Network update rolled back' }, { on: true }); } catch { /* older Hostwerk */ }
  host.provide('bedrock', {
    status: (id) => bedrock.status(id),
    /** Is this player a Bedrock player (Floodgate name prefix of their network)? */
    isBedrock: (id, name) => { try { const h = mc.get(bedrock.hostOf(id)); if (!h.geyser || !h.geyser.floodgate) return false; return String(name || '').startsWith(bedrock.prefix(h.id)); } catch { return false; } },
  });
  host.on('autostart', (want) => (process.env.HW_TEST ? [] : bds.autostartTasks(want)));

  let migration = { misplaced: [] };
  try { migration = M.migrate(ctx, mc, bedrock, networks); } catch (e) { host.log('migration:', e.message); }

  if (!process.env.HW_TEST) {
    const every = (fn, ms, first) => { const a = setTimeout(() => fn().catch(() => {}), first); const b = setInterval(() => fn().catch(() => {}), ms); for (const x of [a, b]) if (x.unref) x.unref(); timers.push(a, b); };
    every(() => bedrock.checkAll(), 6 * 3600000, 4 * 60000);
    every(() => bedrock.applyWhenEmpty(), 10 * 60000, 10 * 60000);
    every(() => bedrock.probeTick(), 30000, 30000);
    every(() => networks.proxyUpdateTick(), 10 * 60000, 7 * 60000);
    every(() => bds.updateTick(), 6 * 3600000, 5 * 60000);
  }

  const r = host.router;
  const changed = () => host.broadcast({ type: 'mc-network' });
  const job = (j) => ({ job: j.id });
  const B = (req) => req.body || {};

  /* ---- Overview ---- */
  r.get('/mc-network', (req, res) => res.json({
    networks: networks.list().map((n) => networks.view(n)),
    free: networks.free(), proxies: networks.proxies(),
    bedrock: mc.list().filter((s) => !(s.network && s.network.proxy) && !mc.isProxy(s)).map((s) => bedrock.status(s.id)),
    bds: bds.views(), misplaced: M.misplaced(mc), bungee: typeof mc.registerType === 'function', migrated: (ctx.settings.get().mcNetwork || {}).migrated || null,
    migration: { misplaced: migration.misplaced.length },
  }));

  /* ---- Networks ---- */
  r.post('/mc-network', (req, res) => { if (B(req).kind === 'bungeecord' && typeof mc.registerType !== 'function') throw host.error(400, 'BungeeCord needs Hostwerk 3.2 or newer – Velocity works right away.'); res.json(job(networks.create(B(req)))); });
  r.post('/mc-network/adopt/:proxy', (req, res) => { const v = networks.adopt(req.params.proxy, B(req)); changed(); res.json(v); });
  r.get('/mc-network/net/:id', (req, res) => res.json(networks.view(networks.get(req.params.id))));
  r.put('/mc-network/net/:id', async (req, res) => { const b = B(req); if (b.name !== undefined) networks.rename(req.params.id, b.name); const v = await networks.setSettings(req.params.id, b); changed(); res.json(v); });
  r.delete('/mc-network/net/:id', (req, res) => { const out = networks.remove(req.params.id, { release: req.query.release === '1' }); changed(); res.json(out && out.id ? job(out) : out); });
  r.put('/mc-network/net/:id/members', (req, res) => res.json(job(networks.setMembers(req.params.id, B(req)))));
  r.get('/mc-network/net/:id/checks', (req, res) => res.json(networks.checks(req.params.id)));
  r.get('/mc-network/net/:id/addresses', async (req, res) => res.json(await networks.addresses(req.params.id)));
  r.post('/mc-network/net/:id/maintenance', async (req, res) => { const b = B(req); const v = await networks.maintenance(req.params.id, String(b.server || ''), !!b.on, { stop: !!b.stop }); changed(); res.json(v); });
  r.post('/mc-network/net/:id/send', async (req, res) => res.json(await networks.send(req.params.id, B(req))));
  r.put('/mc-network/net/:id/icon', async (req, res) => { const d = String(B(req).data || '').replace(/^data:image\/png;base64,/, ''); res.json(await networks.setIcon(req.params.id, Buffer.from(d, 'base64'))); });
  r.get('/mc-network/net/:id/icon', (req, res) => { const f = networks.icon(req.params.id); if (!f) return res.status(404).end(); res.type('png').sendFile(f); });
  r.put('/mc-network/net/:id/whitelist', async (req, res) => res.json(await networks.setWhitelist(req.params.id, !!B(req).on)));
  r.post('/mc-network/net/:id/lists/:which', async (req, res) => res.json(await networks.listAdd(req.params.id, req.params.which, B(req).name, B(req))));
  r.delete('/mc-network/net/:id/lists/:which/:uuid', async (req, res) => res.json(await networks.listRemove(req.params.id, req.params.which, req.params.uuid)));
  r.get('/mc-network/net/:id/via', (req, res) => res.json(via.status(networks.get(req.params.id).proxy)));
  r.put('/mc-network/net/:id/via', (req, res) => {
    const n = networks.get(req.params.id);
    const want = Object.fromEntries(['viaversion', 'viabackwards', 'viarewind'].filter((k) => typeof B(req)[k] === 'boolean').map((k) => [k, B(req)[k]]));
    res.json(job(runJob(host.t('Version bridges for “{name}”', { name: n.name }), async () => ({ servers: await via.apply(n.proxy, want) }), { key: `mc-network-via-${n.id}` })));
  });
  r.post('/mc-network/net/:id/run/:action', (req, res) => res.json(job(networks.run(req.params.id, req.params.action))));

  /* ---- Bedrock through Geyser (proxy or single server) ---- */
  r.get('/mc-network/bedrock/:server', (req, res) => res.json(bedrock.status(req.params.server)));
  r.get('/mc-network/bedrock/:server/compat', async (req, res) => { const target = await bedrock.geyserTarget(); res.json({ target, servers: bedrock.compat(req.params.server, target) }); });
  r.post('/mc-network/bedrock/:server', (req, res) => res.json(job(bedrock.enable(req.params.server, B(req)))));
  r.delete('/mc-network/bedrock/:server', async (req, res) => { const out = await bedrock.disable(req.params.server); changed(); res.json(out); });
  r.put('/mc-network/bedrock/:server/settings', (req, res) => res.json(bedrock.setSettings(req.params.server, B(req))));
  r.post('/mc-network/bedrock/:server/update', async (req, res) => { await bedrock.checkUpdate(req.params.server); res.json(bedrock.status(req.params.server)); });
  r.put('/mc-network/bedrock/:server/optional-pack', async (req, res) => res.json(await bedrock.setOptionalPack(req.params.server, !!B(req).on)));
  r.post('/mc-network/bedrock/:server/sync', async (req, res) => res.json({ servers: await bedrock.syncBackends(req.params.server), status: bedrock.status(req.params.server) }));
  r.post('/mc-network/bedrock/:server/restart', async (req, res) => { await mc.restart(req.params.server); res.json(bedrock.status(req.params.server)); });
  r.post('/mc-network/move-to-proxy/:proxy', (req, res) => res.json(job(M.moveToProxy(mc, bedrock, req.params.proxy, runJob))));

  /* ---- Bedrock Dedicated Server ---- */
  const usedAll = () => new Set([...bedrock.usedUdp('', []), ...mc.list().filter((s) => s.geyser).map((s) => s.geyser.port)]);
  r.get('/mc-network/bds', (req, res) => res.json(bds.views()));
  r.post('/mc-network/bds', (req, res) => res.json(job(bds.create(B(req), usedAll()))));
  r.put('/mc-network/bds/:id', (req, res) => res.json(bds.setSettings(req.params.id, B(req))));
  r.delete('/mc-network/bds/:id', async (req, res) => res.json(await bds.remove(req.params.id, { files: req.query.files === '1' })));
  r.post('/mc-network/bds/:id/run/:action', async (req, res) => { if (!['start', 'stop', 'restart'].includes(req.params.action)) throw host.error(400, 'Unknown action'); await bds[req.params.action](req.params.id); res.json(bds.view(bds.get(req.params.id))); });
  r.post('/mc-network/bds/:id/update', (req, res) => res.json(job(bds.update(req.params.id, { force: !!B(req).force }))));
  r.post('/mc-network/bds/:id/check', async (req, res) => res.json(await bds.checkUpdate(req.params.id)));
  r.post('/mc-network/bds/:id/command', (req, res) => res.json(bds.command(req.params.id, B(req).command)));
  r.get('/mc-network/bds/:id/log', (req, res) => res.json(bds.log(req.params.id, Number(req.query.n) || 200)));

  /* ---- Versions of everything at a glance ---- */
  r.get('/mc-network-versions', async (req, res) => {
    const out = { geyser: null, floodgate: null, geyserTarget: null, bds: null };
    await Promise.all([
      bedrock.latest('geyser', 'velocity').then((x) => { out.geyser = x.build; }).catch(() => {}),
      bedrock.latest('floodgate', 'velocity').then((x) => { out.floodgate = x.build; }).catch(() => {}),
      bedrock.geyserTarget().then((x) => { out.geyserTarget = x; }).catch(() => {}),
      bds.latest().then((x) => { out.bds = x.version; }).catch(() => {}),
    ]);
    res.json(out);
  });

  state = { bedrock, networks, bds, via, timers, offs, mc };
}

async function deactivate() {
  if (!state) return;
  for (const t of state.timers) { clearTimeout(t); clearInterval(t); }
  for (const off of state.offs) { try { off(); } catch { /* gone */ } }
  if (state.mc && state.mc.geyser === state.bedrock) delete state.mc.geyser;
  await state.bds.stopAll().catch(() => {});
  state = null;
}

module.exports = { activate, deactivate };
