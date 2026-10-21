'use strict';
/*
 * Bedrock access with a simulated Minecraft manager and download API: Geyser once on the proxy, the Floodgate key on every
 * server behind it, port choice, settings in both Geyser layouts, update with staging, compatibility hold, probe and
 * rollback, RakNet ping.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { makeHost, makeMc, makeNet } = require('./helpers');
const { Bedrock, bedrockPing, parsePong, pongPacket, cmpMc, STAGE, ALT } = require('../server/bedrock');
const { Via } = require('../server/via');
const C = require('../server/configs');

function setup(o = {}) {
  const servers = [
    { id: 'proxy', name: 'Proxy', type: 'velocity', version: '3.4.0', port: 25577 },
    { id: 'lobby', name: 'Lobby', type: 'paper', version: '26.3', port: 25566, network: { proxy: 'proxy', key: 'lobby' } },
    { id: 'old', name: 'Old', type: 'paper', version: '1.21.11', port: 25567, network: { proxy: 'proxy', key: 'old' } },
    { id: 'mod', name: 'Modded', type: 'fabric', version: '26.3', port: 25568, network: { proxy: 'proxy', key: 'mod' } },
    { id: 'solo', name: 'Solo', type: 'paper', version: '26.3', port: 25565 },
  ];
  const mc = makeMc(servers);
  const host = makeHost({});
  const net = makeNet(o.net);
  const used = new Set(o.busy || []);
  const b = new Bedrock(host, mc, net, { udpFree: async (p) => !used.has(p), ping: o.ping || (async () => ({ players: 0 })) });
  b.via = new Via(host, mc);
  b.via.autoFor = () => !!o.autoVia;
  return { mc, host, net, b, servers };
}

test('a server behind a proxy cannot get its own Geyser – Bedrock belongs on the proxy', () => {
  const { b } = setup();
  assert.throws(() => b.enable('lobby'), /behind a proxy/);
});

test('Geyser on the proxy: config before the first start, one key on every Paper server, Floodgate sends the data', async () => {
  const { b, mc, servers } = setup({ busy: [19132] });
  const r = await b.enable('proxy', { settings: { prefix: '*', motd1: 'Mein Netz' } }).promise;
  assert.strictEqual(r.port, 19133, 'busy 19132 skipped');
  const plugins = mc.addonDir('proxy');
  assert.deepStrictEqual(fs.readdirSync(plugins).filter((f) => f.endsWith('.jar')).sort(), ['Geyser-velocity.jar', 'floodgate-velocity.jar']);
  const cfg = fs.readFileSync(path.join(plugins, 'Geyser-Velocity', 'config.yml'), 'utf8');
  assert.deepStrictEqual([C.yamlGet(cfg, ['bedrock', 'port']), C.yamlGet(cfg, ['remote', 'auth-type']), C.yamlGet(cfg, ['bedrock', 'motd1'])], [19133, 'floodgate', 'Mein Netz']);
  const key = fs.readFileSync(path.join(plugins, 'floodgate', 'key.pem'));
  assert.strictEqual(key.length, 16, 'AES-128 key like Floodgate makes it');
  assert.strictEqual(C.yamlGet(fs.readFileSync(path.join(plugins, 'floodgate', 'config.yml'), 'utf8'), ['send-floodgate-data']), true);
  for (const id of ['lobby', 'old']) {
    assert.ok(fs.readFileSync(path.join(mc.addonDir(id), 'floodgate', 'key.pem')).equals(key), `${id} has the network key`);
    assert.ok(fs.existsSync(path.join(mc.addonDir(id), 'floodgate-spigot.jar')));
    assert.ok(!fs.readdirSync(mc.addonDir(id)).some((f) => /^geyser/i.test(f)), 'no Geyser behind the proxy');
    assert.strictEqual(C.yamlGet(fs.readFileSync(path.join(mc.addonDir(id), 'floodgate', 'config.yml'), 'utf8'), ['username-prefix']), '*');
  }
  const st = b.status('proxy');
  assert.strictEqual(st.mode, 'proxy');
  assert.deepStrictEqual(st.backends.map((x) => [x.id, x.key, x.supported]), [['lobby', true, true], ['old', true, true], ['mod', false, false]]);
  assert.ok(!mc.calls.some((c) => c[0] === 'start'), 'nothing had to be started for the settings');
  assert.strictEqual(servers[0].geyser.settings.prefix, '*');
});

test('single server: Geyser + Floodgate as plugin; Vanilla is refused with a reason', async () => {
  const { b, mc, servers } = setup();
  servers.push({ id: 'van', name: 'Vanilla', type: 'vanilla', version: '26.3', port: 25570 });
  assert.throws(() => b.enable('van'), /Vanilla cannot load plugins/);
  const r = await b.enable('solo').promise;
  assert.strictEqual(r.port, 19132);
  assert.ok(fs.existsSync(path.join(mc.addonDir('solo'), 'Geyser-Spigot', 'config.yml')));
  assert.strictEqual(b.status('solo').mode, 'server');
});

test('running server with players: no restart, "restart needed" instead; empty → restarted', async () => {
  const { b, mc } = setup();
  await mc.start('solo');
  mc.proc('solo').extra.players = ['Steve'];
  let r = await b.enable('solo').promise;
  assert.ok(!r.restarted && r.restartNeeded);
  mc.proc('solo').extra.players = [];
  r = await b.enable('solo').promise;
  assert.ok(r.restarted);
});

test('settings later: written into the layout Geyser migrated to; prefix on every server behind the proxy', async () => {
  const { b, mc } = setup();
  await b.enable('proxy').promise;
  // Geyser migrated the file at its first start (new layout)
  const f = path.join(mc.addonDir('proxy'), 'Geyser-Velocity', 'config.yml');
  fs.writeFileSync(f, 'bedrock:\n  port: 19132\njava:\n  auth-type: floodgate\nmotd:\n  primary-motd: X\ngameplay:\n  server-name: X\nconfig-version: 11\n');
  b.setSettings('proxy', { motd1: 'Neu', serverName: 'Netz', prefix: '#', maxPlayers: 30 });
  const r = C.geyserRead(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual([r.motd1, r.serverName, r.maxPlayers], ['Neu', 'Netz', 30]);
  assert.strictEqual(C.yamlGet(fs.readFileSync(path.join(mc.addonDir('old'), 'floodgate', 'config.yml'), 'utf8'), ['username-prefix']), '#');
  assert.throws(() => b.setSettings('proxy', { prefix: 'ab' }), /prefix/);
});

test('update: staged with checksum, put in place before the start, old jars kept until the probe answers', async () => {
  const s = setup({ autoVia: true });
  await s.b.enable('proxy').promise;
  s.net.builds.geyser = 1300;
  await s.mc.start('proxy');
  const r = await s.b.checkUpdate('proxy');
  assert.deepStrictEqual(r.pending, { geyser: '2.12.0-1300' });
  assert.ok(fs.existsSync(path.join(s.mc.addonDir('proxy'), STAGE, 'Geyser-velocity.jar')), 'staged while running');
  assert.ok(s.net.downloads.some((d) => /builds\/1300/.test(d.url) && d.sha256), 'download with SHA-256');
  await s.mc.stop('proxy');
  assert.ok(s.b.applyStaged('proxy'));
  assert.ok(fs.existsSync(path.join(s.mc.addonDir('proxy'), ALT, 'Geyser-velocity.jar')), 'previous jar kept');
  await s.mc.start('proxy');
  await s.b.probeTick();
  assert.ok(!s.servers[0].geyser.probe, 'probe answered');
  assert.ok(!fs.existsSync(path.join(s.mc.addonDir('proxy'), ALT)), 'previous jar removed after success');
  assert.strictEqual(s.servers[0].geyser.builds.geyser, '2.12.0-1300');
});

test('update that does not answer: rolled back, build skipped next time, notification', async () => {
  const s = setup({ ping: async () => null, autoVia: true });
  await s.b.enable('proxy').promise;
  s.net.builds.geyser = 1400;
  await s.b.checkUpdate('proxy'); // proxy stopped → applied right away
  await s.mc.start('proxy');
  const t0 = Date.now();
  await s.b.probeTick(t0);
  await s.b.probeTick(t0 + 4 * 60000);
  const g = s.servers[0].geyser;
  assert.ok(!g.probe);
  assert.strictEqual(g.builds.geyser, '2.12.0-1267', 'previous build in effect again');
  assert.strictEqual(g.failed.geyser, '2.12.0-1400');
  assert.ok(s.host.notes.some((n) => n.notify === 'update-failed'));
  const again = await s.b.checkUpdate('proxy');
  assert.ok(again.upToDate !== undefined && !again.pending, 'failed build is not downloaded again');
});

test('compatibility: newer Geyser needs ViaVersion on older servers – update waits, or installs ViaVersion first', async () => {
  const s = setup({ net: { modrinthTarget: '26.3' } });
  await s.b.enable('proxy').promise;
  s.net.builds.geyser = 1500;
  const held = await s.b.checkUpdate('proxy');
  assert.strictEqual(held.held.reason, 'via');
  assert.deepStrictEqual(held.held.servers, ['Old']);
  assert.ok(s.host.notes.some((n) => /ViaVersion/.test(n.text || '')));
  // with the automatic version bridge
  const a = setup({ autoVia: true });
  await a.b.enable('proxy').promise;
  a.net.builds.geyser = 1500;
  const r = await a.b.checkUpdate('proxy');
  assert.ok(r.pending && r.pending.geyser);
  assert.ok(a.mc.calls.some((c) => c[0] === 'modrinth' && c[1] === 'old' && c[2] === 'viaversion'));
  assert.ok(a.b.via.has('old', 'viaversion'));
  assert.strictEqual(cmpMc('26.3', '1.21.11'), 1);
});

test('switching off removes Geyser and the Floodgate it put on servers; keys of others stay', async () => {
  const { b, mc, servers } = setup();
  await b.enable('proxy').promise;
  await b.disable('proxy');
  assert.ok(!servers[0].geyser);
  assert.ok(!fs.readdirSync(mc.addonDir('proxy')).some((f) => /\.jar$/.test(f)));
  assert.ok(!fs.existsSync(path.join(mc.addonDir('lobby'), 'floodgate')));
});

test('RakNet ping: packet out, pong parsed (players for status and probe)', async () => {
  const srv = dgram.createSocket('udp4');
  await new Promise((r) => srv.bind(0, '127.0.0.1', r));
  srv.on('message', (msg, rinfo) => { assert.strictEqual(msg[0], 0x01); srv.send(pongPacket('MCPE;Mein Netz;800;1.26.50;3;20;123;Lobby;Survival;1;19132;19133;'), rinfo.port, rinfo.address); });
  const r = await bedrockPing(srv.address().port);
  srv.close();
  assert.deepStrictEqual([r.motd, r.players, r.max, r.version], ['Mein Netz', 3, 20, '1.26.50']);
  assert.strictEqual(parsePong(Buffer.from('nope')), null);
});
