'use strict';
/*
 * Moving over from the "Bedrock bridge": same data, nothing copied – settings read from the real files, existing
 * Velocity networks taken over, Geyser behind a proxy moved onto the proxy with the same port and key.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeHost, makeMc, makeNet } = require('./helpers');
const { Bedrock } = require('../server/bedrock');
const { McNetworks } = require('../server/network');
const M = require('../server/migrate');
const C = require('../server/configs');

/** What the bridge left behind: geyser entries, jars, configs (classic layout) and keys. */
function bridgeState() {
  const servers = [
    { id: 'solo', name: 'Solo', type: 'paper', version: '26.3', port: 25565, geyser: { port: 19132, floodgate: true, builds: { geyser: '2.11.0-1200', floodgate: '2.2.4-130' }, optionalPack: true } },
    { id: 'proxy', name: 'Proxy', type: 'velocity', version: '3.4.0', port: 25577 },
    { id: 'a', name: 'A', type: 'paper', version: '26.3', port: 25566, network: { proxy: 'proxy', key: 'a' }, geyser: { port: 19133, floodgate: true, builds: { geyser: '2.11.0-1200' } } },
    { id: 'b', name: 'B', type: 'paper', version: '26.3', port: 25567, network: { proxy: 'proxy', key: 'b' } },
  ];
  const mc = makeMc(servers);
  const put = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
  put(path.join(mc.addonDir('solo'), 'Geyser-Spigot', 'config.yml'), 'bedrock:\n  port: 19132\n  motd1: "Solo-Server"\n  motd2: "Hallo"\n  server-name: "Solo"\nremote:\n  auth-type: floodgate\nconfig-version: 4\n');
  put(path.join(mc.addonDir('solo'), 'floodgate', 'config.yml'), 'username-prefix: "*"\n');
  put(path.join(mc.addonDir('solo'), 'Geyser-spigot.jar'), 'x');
  put(path.join(mc.addonDir('a'), 'Geyser-spigot.jar'), 'x');
  put(path.join(mc.addonDir('a'), 'floodgate-spigot.jar'), 'x');
  put(path.join(mc.addonDir('a'), 'Geyser-Spigot', 'config.yml'), 'bedrock:\n  port: 19133\nremote:\n  auth-type: floodgate\nconfig-version: 4\n');
  put(path.join(mc.addonDir('a'), 'floodgate', 'key.pem'), Buffer.alloc(16, 7));
  return { mc, servers };
}

test('bridge data is read in place: settings from the real files, modes, network taken over, misplaced Geyser listed', () => {
  const { mc, servers } = bridgeState();
  const settings = {};
  const host = makeHost(settings);
  const b = new Bedrock(host, mc, makeNet(), { udpFree: async () => true });
  const n = new McNetworks(host, mc, b, makeNet());
  const r = M.migrate(host.ctx, mc, b, n);
  const solo = servers[0].geyser;
  assert.deepStrictEqual([solo.mode, solo.settings.prefix, solo.settings.motd1, solo.settings.serverName, solo.port, solo.optionalPack], ['server', '*', 'Solo-Server', 'Solo', 19132, true]);
  assert.strictEqual(r.adopted.length, 1, 'Velocity proxy with servers becomes a network');
  assert.deepStrictEqual(r.misplaced.map((x) => [x.id, x.proxy, x.port]), [['a', 'proxy', 19133]]);
  assert.ok(settings.mcNetwork.migrated);
  // running it again changes nothing
  const again = M.migrate(host.ctx, mc, b, n);
  assert.deepStrictEqual([again.imported.length, again.adopted.length], [0, 0]);
});

test('moving Geyser onto the proxy: same port, same key, Geyser off the servers, Floodgate stays', async () => {
  const { mc, servers } = bridgeState();
  const host = makeHost({});
  const net = makeNet();
  const b = new Bedrock(host, mc, net, { udpFree: async () => true });
  const n = new McNetworks(host, mc, b, net);
  M.migrate(host.ctx, mc, b, n);
  const r = await M.moveToProxy(mc, b, 'proxy', net.runJob).promise;
  assert.strictEqual(r.port, 19133, 'friends keep their address');
  assert.strictEqual(servers[1].geyser.port, 19133);
  assert.ok(fs.readFileSync(b.keyFile('proxy')).equals(Buffer.alloc(16, 7)), 'same Floodgate key');
  assert.ok(fs.readFileSync(b.keyFile('b')).equals(Buffer.alloc(16, 7)), 'and on the other servers');
  assert.ok(!servers[2].geyser && !fs.existsSync(path.join(mc.addonDir('a'), 'Geyser-spigot.jar')));
  assert.ok(fs.existsSync(path.join(mc.addonDir('a'), 'floodgate-spigot.jar')), 'Floodgate stays behind the proxy');
  assert.deepStrictEqual(M.misplaced(mc), []);
  const cfg = fs.readFileSync(path.join(mc.addonDir('proxy'), 'Geyser-Velocity', 'config.yml'), 'utf8');
  assert.strictEqual(C.yamlGet(cfg, ['bedrock', 'port']), 19133);
});

test('a failed move leaves the old installation as it was', async () => {
  const { mc, servers } = bridgeState();
  const host = makeHost({});
  const net = makeNet();
  net.downloadFile = async () => { throw new Error('offline'); };
  const b = new Bedrock(host, mc, net, { udpFree: async () => true });
  await assert.rejects(M.moveToProxy(mc, b, 'proxy', net.runJob).promise, /offline/);
  assert.strictEqual(servers[2].geyser.port, 19133);
  assert.ok(fs.existsSync(path.join(mc.addonDir('a'), 'Geyser-spigot.jar')));
});
