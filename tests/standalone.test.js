'use strict';
/*
 * Geyser Standalone with doubles (no Java, no Geyser): which servers get it, config pointing at the Java server, coupled
 * start/stop through Hostwerk's service events, update with a way back (probe ok / no answer), switching off. Plus: Bedrock
 * servers of Hostwerk's core are left alone by Geyser and their UDP ports are taken; moving an old BDS into the core.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeHost, makeMc, makeNet } = require('./helpers');
const { Bedrock } = require('../server/bedrock');
const { GeyserStandalone } = require('../server/standalone');
const { BedrockServers } = require('../server/bds');
const C = require('../server/configs');

/** Process double: "starts" at once and prints Geyser's ready line unless the jar says "broken". */
function procClass() {
  return class {
    constructor(id) { this.id = id; this.extra = {}; this.logs = []; this.state = 'stopped'; this.run = false; this.starts = []; }
    isRunning() { return this.run; }
    setExtra(x) { Object.assign(this.extra, x); }
    async start(o) {
      this.starts.push(o);
      const jar = fs.readFileSync(path.join(o.cwd, o.args[o.args.indexOf('-jar') + 1]), 'utf8');
      if (/broken/.test(jar)) { this.state = 'error'; return; }
      this.run = true; this.state = 'running';
      o.onLine('[12:00:00 INFO] Done (2.345s)! Run /geyser help for help!');
    }
    write(l) { this.logs.push({ t: Date.now(), s: 'in', l }); }
    async stop() { this.run = false; this.state = 'stopped'; }
  };
}

function setup(servers) {
  const mc = makeMc(servers);
  mc.isBedrock = (s) => s.type === 'bedrock';
  const settings = {};
  const host = makeHost(settings);
  const net = makeNet();
  const pong = { ok: true };
  const bedrock = new Bedrock(host, mc, net, { udpFree: async () => true, ping: async () => (pong.ok ? { players: 0 } : null) });
  const sa = new GeyserStandalone(host, mc, bedrock, net, { Proc: procClass(), ping: async () => (pong.ok ? { online: 0 } : null), javaExe: () => process.execPath, probeMs: 300 });
  bedrock.standalone = sa;
  return { mc, host, net, bedrock, sa, pong };
}

test('who gets Geyser Standalone: Vanilla/Forge/own JAR yes; plugin servers, proxies, servers behind a proxy, Bedrock no', () => {
  const { bedrock, sa, mc } = setup([
    { id: 'v', name: 'Vanilla', type: 'vanilla', version: '26.3', port: 25565 }, { id: 'f', name: 'Forge', type: 'forge', version: '1.20.1', port: 25566 },
    { id: 'p', name: 'Paper', type: 'paper', version: '26.3', port: 25567 }, { id: 'x', name: 'Proxy', type: 'velocity', port: 25577 },
    { id: 'b', name: 'Behind', type: 'vanilla', port: 25568, network: { proxy: 'x' } }, { id: 'bed', name: 'Insel', type: 'bedrock', port: 19132, portv6: 19133 },
  ]);
  assert.deepStrictEqual(['v', 'f', 'p', 'x', 'b', 'bed'].map((id) => sa.possible(mc.get(id)).ok), [true, true, false, false, false, false]);
  assert.strictEqual(bedrock.status('v').standalonePossible, true, 'Geyser card offers Standalone for Vanilla');
  assert.strictEqual(bedrock.status('p').standalonePossible, false);
  assert.match(bedrock.supported(mc.get('bed')).why, /Bedrock server/);
  assert.ok(bedrock.usedUdp('v').has(19132) && bedrock.usedUdp('v').has(19133), 'ports of core Bedrock servers are taken');
});

test('enable: SHA-256 download of the standalone package, free port, config points at the Java server (online/offline)', async () => {
  const { sa, mc, net } = setup([{ id: 'v', name: 'Vanilla', type: 'vanilla', version: '26.3', port: 25565 }]);
  fs.writeFileSync(path.join(mc.dir('v'), 'server.properties'), 'online-mode=false\n');
  const r = await sa.enable('v', { settings: { address: '127.0.0.1', serverName: 'Welt' } }).promise;
  assert.deepStrictEqual([r.port, r.started], [19132, false]);
  const d = net.downloads.find((x) => /standalone/.test(x.url));
  assert.ok(d && d.sha256 && /geyser-standalone[\\/]Geyser-Standalone\.jar$/.test(d.file), JSON.stringify(net.downloads));
  const conf = C.geyserRead(fs.readFileSync(path.join(mc.dir('v'), 'geyser-standalone', 'config.yml'), 'utf8'));
  assert.deepStrictEqual([conf.port, conf.address, conf.remoteAddress, conf.remotePort, conf.authType, conf.serverName], [19132, '127.0.0.1', '127.0.0.1', 25565, 'offline', 'Welt']);
  const st = sa.status('v');
  assert.deepStrictEqual([st.enabled, st.mode, st.floodgate, st.authType, st.build], [true, 'standalone', false, 'offline', '2.12.0-1267']);
  assert.throws(() => sa.enable('nope'), /not found|nicht gefunden/i);
});

test('coupled to the server: starts when the server is ready, stops with it; console command on stop', async () => {
  const { sa, mc } = setup([{ id: 'v', name: 'Vanilla', type: 'vanilla', version: '26.3', port: 25565 }]);
  await sa.enable('v').promise;
  sa.onService({ svc: 'mc:v', info: { state: 'running', extra: { ready: false } } });
  assert.strictEqual(sa.proc('v').isRunning(), false, 'waits for the server to be ready');
  sa.onService({ svc: 'mc:v', info: { state: 'running', extra: { ready: true } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sa.proc('v').isRunning(), true);
  const o = sa.proc('v').starts[0];
  assert.deepStrictEqual([o.cmd, o.args.includes('--nogui'), path.basename(o.cwd)], [process.execPath, true, 'geyser-standalone']);
  assert.strictEqual(sa.proc('v').extra.ready, true);
  sa.onService({ svc: 'mc:v', info: { state: 'stopped', extra: {} } });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sa.proc('v').isRunning(), false);
  sa.onService({ svc: 'mc:other', info: { state: 'running', extra: { ready: true } } });
  assert.ok(mc.list().length === 1);
});

test('update with a way back: new build answers → stays; build that does not answer → old jar back, build skipped', async () => {
  const { sa, mc, net, host, pong } = setup([{ id: 'v', name: 'Vanilla', type: 'vanilla', version: '26.3', port: 25565 }]);
  await sa.enable('v').promise;
  await sa.start('v');
  net.builds.geyser = 1300;
  let c = await sa.checkUpdate('v');
  assert.deepStrictEqual([c.update, c.build, c.latest], [true, '2.12.0-1267', '2.12.0-1300']);
  const r = await sa.update('v').promise;
  assert.deepStrictEqual([r.build, r.previous], ['2.12.0-1300', '2.12.0-1267']);
  assert.ok(sa.proc('v').isRunning(), 'Geyser runs again (the Java server was never touched)');
  assert.ok(!mc.calls.some((x) => x[0] === 'stop'), 'Java server not stopped');
  assert.ok(!fs.existsSync(path.join(sa.dir('v'), '.hostwerk-alt')));
  // next build does not answer
  net.builds.geyser = 1301;
  pong.ok = false;
  await assert.rejects(() => sa.update('v').promise, /rolled back/);
  const g = mc.get('v').geyser;
  assert.deepStrictEqual([g.builds.standalone, g.failed], ['2.12.0-1300', '2.12.0-1301']);
  assert.match(fs.readFileSync(sa.jar('v'), 'utf8'), /builds\/1300\//, 'old jar back in place');
  assert.ok(sa.proc('v').isRunning(), 'old version runs again');
  assert.ok(host.notes.some((n) => n.notify === 'update-failed'));
  c = await sa.checkUpdate('v');
  assert.strictEqual(c.update, false, 'skipped build is not offered again');
  // players online → waits
  mc.proc('v').extra.players = ['Steve'];
  assert.throws(() => sa.update('v'), /Players are online/);
});

test('switching off: process stopped, files and port gone; plugin Geyser paths leave Standalone alone', async () => {
  const { sa, mc, bedrock } = setup([{ id: 'v', name: 'Vanilla', type: 'vanilla', version: '26.3', port: 25565 }]);
  await sa.enable('v').promise;
  await sa.start('v');
  assert.strictEqual(bedrock.applyStaged('v'), false, 'no plugin staging for Standalone');
  assert.strictEqual(await bedrock.checkUpdate('v'), null, 'plugin update path ignores Standalone');
  assert.strictEqual(bedrock.status('v').mode, 'standalone');
  await sa.disable('v');
  assert.ok(!mc.get('v').geyser && !fs.existsSync(sa.dir('v')) && !sa.proc('v').isRunning());
});

test('old Bedrock Dedicated Server of this extension moves into Hostwerk’s server list (same folder content and ports)', async () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hw-bds-move-'));
  const settings = {};
  const host = makeHost(settings);
  host.ctx.paths = { data: root };
  const net = makeNet();
  const Proc = class { constructor() { this.extra = {}; this.logs = []; this.state = 'stopped'; } isRunning() { return false; } setExtra(x) { Object.assign(this.extra, x); } };
  const bds = new BedrockServers(host, net, { root: path.join(root, 'bedrock-servers'), platform: 'win', ManagedProcess: Proc, ping: async () => ({}) });
  const { id } = await bds.create({ name: 'Insel', eula: true }).promise;
  const servers = [];
  const mc = makeMc(servers, { root: path.join(root, 'mc') });
  mc.isBedrock = (s) => s.type === 'bedrock';
  mc.paths = { mcDir: (x) => path.join(root, 'mc', x) };
  await assert.rejects(() => bds.moveToCore(id, {}), /update Hostwerk/);
  const r = await bds.moveToCore(id, mc);
  const s = mc.get(r.id);
  assert.deepStrictEqual([s.type, s.name, s.port, s.portv6, s.version], ['bedrock', 'Insel', 19132, 19133, '1.26.52.3']);
  assert.ok(fs.existsSync(path.join(root, 'mc', r.id, 'server.properties')) && fs.existsSync(path.join(root, 'mc', r.id, 'worlds')));
  assert.strictEqual(bds.list().length, 0);
});

test('ready line in every language (Geyser writes it in the system language)', () => {
  const { READY } = require('../server/standalone');
  assert.ok(READY.test('[22:50:42.430 main/INFO] Fertig (2,543s)! Verwende /geyser help für Hilfe!'));
  assert.ok(READY.test('[12:00:00 INFO] Done (2.345s)! Run /geyser help for help!'));
  assert.ok(!READY.test('[12:00:00 INFO] Geyser wird geladen'));
});
