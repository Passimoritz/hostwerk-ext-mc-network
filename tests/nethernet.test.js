'use strict';
/*
 * NetherNet (Bedrock 26.60 drops RakNet on 27 October 2026): Geyser configs in both layouts switched to "both" with an own
 * UDP port, what the person set on purpose stays, port choice without collisions, switching before the start and while
 * running (restart when nobody plays), state for the UI (ready/old/silent/off), firewall/router ports, the signaling probe
 * (GET /v1/join against a real local HTTP server) and Geyser Standalone.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { makeHost, makeMc, makeNet } = require('./helpers');
const { Bedrock, netherNetPing, buildNo, NETHERNET_BUILD } = require('../server/bedrock');
const { GeyserStandalone } = require('../server/standalone');
const C = require('../server/configs');

/** Part of the config Geyser 2.12 (build 1269) writes – comments, sections and "transport: raknet" as its default. */
const NEW_LAYOUT = [
  '# Network settings for the Bedrock listener',
  'bedrock:',
  '  # The IP address that Geyser will bind on to listen for incoming Bedrock connections.',
  '  address: 0.0.0.0',
  '',
  '  # The port that Geyser will listen on for incoming Bedrock connections.',
  '  port: 19132',
  '',
  '  # The UDP port used for NetherNet connections. When set to 0, Geyser uses the "port" value set above.',
  '  webrtc-port: 0',
  '',
  '  # How Bedrock players can connect. Changes require a restart.',
  '  transport: raknet',
  '',
  '  signaling:',
  '    mode: builtin',
  '    advertise-addresses: []',
  'java:',
  '  address: 127.0.0.1',
  '  port: 25565',
  '  auth-type: floodgate',
  'config-version: 11',
  '',
].join('\n');

test('config: classic file from Hostwerk carries "both" + WebRTC port, Geyser keeps them when it moves the file', () => {
  const t = C.geyserConfigText({ port: 19132, webrtcPort: 19133, remotePort: 25565 });
  assert.deepStrictEqual([C.yamlGet(t, ['bedrock', 'transport']), C.yamlGet(t, ['bedrock', 'webrtc-port']), C.yamlGet(t, ['config-version'])], ['both', 19133, 4]);
  assert.match(t, /^ {2}transport: both$/m, 'enum unquoted like Geyser writes it');
  // without a WebRTC port (older callers): no NetherNet keys – geyserNetherNet adds them
  const plain = C.geyserConfigText({ port: 19132 });
  assert.strictEqual(C.yamlGet(plain, ['bedrock', 'transport']), undefined);
  const r = C.geyserNetherNet(plain, { webrtcPort: 19140 });
  assert.deepStrictEqual([r.changed, r.transport, r.webrtcPort, C.yamlGet(r.text, ['bedrock', 'transport']), C.yamlGet(r.text, ['bedrock', 'webrtc-port'])], [true, 'both', 19140, 'both', 19140]);
});

test('config: Geyser’s own "transport: raknet" becomes "both" with an own port – comments, order and CRLF stay', () => {
  const r = C.geyserNetherNet(NEW_LAYOUT, { webrtcPort: 19133 });
  assert.deepStrictEqual([r.changed, r.transport, r.webrtcPort, r.needsPort], [true, 'both', 19133, false]);
  assert.match(r.text, /^ {2}transport: both$/m);
  assert.match(r.text, /^ {2}webrtc-port: 19133$/m);
  assert.strictEqual(r.text.split('\n').length, NEW_LAYOUT.split('\n').length, 'edited in place, nothing added');
  assert.match(r.text, /# How Bedrock players can connect/);
  assert.strictEqual(C.yamlGet(r.text, ['bedrock', 'signaling', 'mode']), 'builtin', 'signaling stays Geyser’s built-in default');
  const crlf = C.geyserNetherNet(NEW_LAYOUT.replace(/\n/g, '\r\n'), { webrtcPort: 19133 });
  assert.ok(!/[^\r]\n/.test(crlf.text), 'CRLF kept');
  // again: nothing to do
  assert.strictEqual(C.geyserNetherNet(r.text, { webrtcPort: 19150 }).changed, false, 'its own valid port is not moved');
  // without a port to give: says so instead of writing "both" with one shared port
  const none = C.geyserNetherNet(NEW_LAYOUT, {});
  assert.deepStrictEqual([none.changed, none.needsPort], [false, true]);
});

test('config: what the person set on purpose stays', () => {
  // only NetherNet (webrtc-port 0 = the Bedrock port)
  const nn = NEW_LAYOUT.replace('transport: raknet', 'transport: nethernet');
  assert.deepStrictEqual(Object.values((({ changed, transport, webrtcPort }) => ({ changed, transport, webrtcPort }))(C.geyserNetherNet(nn, { webrtcPort: 19133 }))), [false, 'nethernet', 19132]);
  // own "both" port
  const own = NEW_LAYOUT.replace('transport: raknet', 'transport: both').replace('webrtc-port: 0', 'webrtc-port: 20000');
  const r = C.geyserNetherNet(own, { webrtcPort: 19133 });
  assert.deepStrictEqual([r.changed, r.webrtcPort], [false, 20000]);
  // "both" with RakNet and NetherNet on the same UDP port cannot start – Hostwerk's port instead
  const clash = C.geyserNetherNet(NEW_LAYOUT.replace('transport: raknet', 'transport: both').replace('webrtc-port: 0', 'webrtc-port: 19132'), { webrtcPort: 19133 });
  assert.deepStrictEqual([clash.changed, clash.webrtcPort], [true, 19133]);
  // back to RakNet by hand after Hostwerk had switched: kept
  assert.deepStrictEqual([C.geyserNetherNet(NEW_LAYOUT, { webrtcPort: 19133, keepRaknet: true }).changed, C.geyserNetherNet(NEW_LAYOUT, { keepRaknet: true }).transport], [false, 'raknet']);
});

function setup(o = {}) {
  const servers = o.servers || [
    { id: 'proxy', name: 'Proxy', type: 'velocity', version: '3.4.0', port: 25577 },
    { id: 'lobby', name: 'Lobby', type: 'paper', version: '26.3', port: 25566, network: { proxy: 'proxy', key: 'lobby' } },
    { id: 'solo', name: 'Solo', type: 'paper', version: '26.3', port: 25565 },
  ];
  const mc = makeMc(servers);
  mc.isBedrock = (s) => s.type === 'bedrock';
  const host = makeHost({});
  const net = makeNet(o.net);
  const busy = new Set(o.busy || []);
  const pings = [];
  const b = new Bedrock(host, mc, net, {
    udpFree: async (p) => !busy.has(p), tcpFree: async (p) => !(o.tcpBusy || []).includes(p), ping: async () => ({ players: 0 }),
    nnPing: async (port) => { pings.push(port); return o.nnPing ? o.nnPing(port) : { name: 'Hostwerk', version: '26.52', players: 0 }; },
  });
  b.via = { has: () => true, autoFor: () => true };
  return { mc, host, net, b, servers, busy, pings };
}

test('switching Bedrock on: WebRTC port right after the Bedrock port, both in the config, state "set up"', async () => {
  const { b, mc } = setup();
  const r = await b.enable('proxy').promise;
  assert.deepStrictEqual([r.port, r.webrtcPort], [19132, 19133]);
  const cfg = fs.readFileSync(b.configFile('proxy'), 'utf8');
  assert.deepStrictEqual([C.yamlGet(cfg, ['bedrock', 'transport']), C.yamlGet(cfg, ['bedrock', 'webrtc-port'])], ['both', 19133]);
  const st = b.status('proxy');
  assert.deepStrictEqual([st.webrtcPort, st.nethernet.state, st.nethernet.transport, st.nethernet.port], [19133, 'configured', 'both', 19132]);
  assert.ok(mc.get('proxy').geyser.nethernet.at, 'remembered when Hostwerk switched it');
});

test('port choice: no collision with other Geyser, Bedrock servers, public UDP ports, router forwardings or a taken TCP port', async () => {
  const { b, mc, host } = setup({
    servers: [
      { id: 'a', name: 'A', type: 'paper', version: '26.3', port: 25565, geyser: { port: 19132, webrtcPort: 19133 } },
      { id: 'bds', name: 'Insel', type: 'bedrock', port: 19134, portv6: 19135 },
      { id: 'c', name: 'C', type: 'paper', version: '26.3', port: 25566 },
    ],
    busy: [19137], tcpBusy: [19136],
  });
  host.ctx.security = { publicPorts: () => [{ port: 19138, proto: 'UDP' }] };
  host.ctx.router = { forwards: { list: () => [{ port: 19139, protocol: 'UDP', owner: 'game-servers' }] } };
  const port = await b.freePort('c');
  assert.strictEqual(port, 19140, '19132–19135 taken by Hostwerk, 19136 TCP taken, 19137 bound, 19138 public, 19139 forwarded');
  assert.strictEqual(await b.freeWebrtcPort('c', port), 19141);
  assert.strictEqual(b.webrtcPortNow('c', 19132), 19136, 'synchronous fallback skips Hostwerk’s own ports');
  assert.ok(b.usedUdp('c').has(19133), 'WebRTC port of another Geyser is taken');
  void mc;
});

test('existing Geyser on RakNet: switched before the next start; while running → restart when nobody plays; firewall ports', async () => {
  const { b, mc } = setup();
  const s = mc.get('solo');
  s.geyser = { port: 19140, floodgate: true, mode: 'server', builds: { geyser: '2.12.0-1269' } };
  const f = path.join(b.geyserDir('solo'), 'config.yml');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, NEW_LAYOUT.replace('port: 19132', 'port: 19140'));
  // before the start (Hostwerk calls applyStaged before every start – synchronous)
  b.applyStaged('solo');
  let cfg = fs.readFileSync(f, 'utf8');
  assert.deepStrictEqual([C.yamlGet(cfg, ['bedrock', 'transport']), C.yamlGet(cfg, ['bedrock', 'webrtc-port']), s.geyser.webrtcPort], ['both', 19141, 19141]);
  assert.deepStrictEqual(b.publicPorts(), [{ port: 19140, proto: 'TCP', label: 'Minecraft Bedrock (NetherNet): Solo' }, { port: 19141, proto: 'UDP', label: 'Minecraft Bedrock (NetherNet): Solo' }]);

  // A running server whose config was reset to RakNet before Hostwerk ever switched it (fresh data)
  delete s.geyser.nethernet; delete s.geyser.webrtcPort;
  fs.writeFileSync(f, NEW_LAYOUT.replace('port: 19132', 'port: 19140'));
  await mc.start('solo');
  const r = await b.netherNetEnsure('solo');
  assert.deepStrictEqual([r.changed, r.webrtcPort], [true, 19141]);
  assert.strictEqual(s.geyser.restartNeeded, true, 'applyWhenEmpty restarts it when nobody plays');
  assert.strictEqual(b.status('solo').nethernet.state, 'restart');
  mc.proc('solo').extra.players = ['Steve'];
  await b.applyWhenEmpty();
  assert.ok(!mc.calls.some((c) => c[0] === 'stop'), 'not while somebody plays');
  mc.proc('solo').extra.players = [];
  await b.applyWhenEmpty();
  assert.ok(mc.calls.filter((c) => c[0] === 'start').length === 2, 'restarted when empty');
  cfg = fs.readFileSync(f, 'utf8');
  assert.strictEqual(C.yamlGet(cfg, ['bedrock', 'transport']), 'both');
});

test('back to RakNet by hand after the switch: Hostwerk leaves it, says so in the self-maintenance, closes no ports it never opened', async () => {
  const { b, mc, host } = setup();
  await b.enable('solo').promise;
  const f = b.configFile('solo');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('transport: both', 'transport: raknet'));
  await b.netherNetAll();
  assert.match(fs.readFileSync(f, 'utf8'), /transport: raknet/);
  assert.strictEqual(b.status('solo').nethernet.state, 'off');
  assert.deepStrictEqual(b.publicPorts(), [], 'no NetherNet ports while it is off');
  const note = host.notes.filter((n) => n.k === 'mc-network-nethernet').pop();
  assert.ok(note && note.ok === false && /RakNet by hand: Solo/.test(note.text), JSON.stringify(note));
  void mc;
});

test('Geyser older than build 1237: state "old", bundled note; the normal update brings a new build', async () => {
  const { b, mc, host, net } = setup();
  await b.enable('solo').promise;
  const s = mc.get('solo');
  s.geyser.builds.geyser = '2.11.2-1230';
  assert.strictEqual(b.status('solo').nethernet.state, 'old');
  await b.netherNetAll();
  const note = host.notes.filter((n) => n.k === 'mc-network-nethernet').pop();
  assert.ok(note.ok === false && /too old for NetherNet \(build 1237/.test(note.text), note.text);
  const c = await b.checkUpdate('solo');
  assert.ok(c.applied && s.geyser.builds.geyser === `2.12.0-${net.builds.geyser}`, JSON.stringify(c));
  assert.notStrictEqual(b.status('solo').nethernet.state, 'old');
  assert.deepStrictEqual([buildNo('2.12.0-1269'), buildNo('2.11.3-b1237'), buildNo(null), NETHERNET_BUILD], [1269, 1237, null, 1237]);
});

test('NetherNet probe: signaling answers → "ready" (once per process); no answer three times → "silent", bundled note', async () => {
  let answer = true;
  const { b, mc, host, pings } = setup({ nnPing: () => (answer ? { name: 'Solo', version: '26.52', players: 2 } : null) });
  await b.enable('solo').promise;
  await mc.start('solo');
  mc.proc('solo').pid = 111;
  await b.probeTick();
  let st = b.status('solo').nethernet;
  assert.deepStrictEqual([st.state, st.answer && st.answer.players], ['ready', 2]);
  await b.probeTick();
  assert.strictEqual(pings.length, 1, 'asked once per process');
  assert.ok(host.notes.some((n) => n.k === 'mc-network-nethernet' && n.ok && /over NetherNet: Solo/.test(n.text)));
  // new process that does not answer
  answer = false; mc.proc('solo').pid = 222;
  for (let i = 0; i < 3; i++) await b.probeTick();
  st = b.status('solo').nethernet;
  assert.strictEqual(st.state, 'silent');
  assert.ok(host.notes.some((n) => n.k === 'mc-network-nethernet' && n.ok === false && /does not answer/.test(n.text)));
  // Geyser stopped: no stale answer
  await mc.stop('solo');
  await b.probeTick();
  assert.strictEqual(b.status('solo').nethernet.state, 'configured');
});

test('netherNetPing: GET /v1/join on a real local HTTP server – JSON status or null', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/join')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ dataVersion: 7, name: 'Probe', protocol: 2193, version: '26.52', players: 1, maxPlayers: 100 })); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const j = await netherNetPing(port);
    assert.deepStrictEqual([j.name, j.version, j.players], ['Probe', '26.52', 1]);
  } finally { await new Promise((r) => srv.close(r)); }
  assert.strictEqual(await netherNetPing(port, '127.0.0.1', 500), null, 'nothing listening → null');
});

test('servers behind a proxy never get NetherNet ports; a proxy does', async () => {
  const { b, mc } = setup();
  await b.enable('proxy').promise;
  mc.get('lobby').geyser = { port: 19150 }; // leftover of the old bridge behind the proxy – not reachable from outside
  assert.deepStrictEqual(b.publicPorts().map((p) => `${p.port}/${p.proto}`), ['19132/TCP', '19133/UDP']);
});

/* ---------------- Geyser Standalone ---------------- */

function procClass() {
  return class {
    constructor(id) { this.id = id; this.extra = {}; this.logs = []; this.state = 'stopped'; this.run = false; }
    isRunning() { return this.run; }
    setExtra(x) { Object.assign(this.extra, x); }
    async start(o) { this.run = true; this.state = 'running'; o.onLine('[12:00:00 INFO] Done (2.345s)! Run /geyser help for help!'); }
    write(l) { this.logs.push(l); }
    async stop() { this.run = false; this.state = 'stopped'; }
  };
}

test('Geyser Standalone: new config with "both", an old RakNet config is switched before its start', async () => {
  const { b, mc, net, host } = setup({ servers: [{ id: 'v', name: 'Vanilla', type: 'vanilla', version: '26.3', port: 25565 }] });
  const sa = new GeyserStandalone(host, mc, b, net, { Proc: procClass(), ping: async () => ({}), javaExe: () => process.execPath, probeMs: 300 });
  b.standalone = sa;
  const r = await sa.enable('v').promise;
  assert.deepStrictEqual([r.port, r.webrtcPort], [19132, 19133]);
  const f = path.join(sa.dir('v'), 'config.yml');
  assert.strictEqual(C.yamlGet(fs.readFileSync(f, 'utf8'), ['bedrock', 'transport']), 'both');
  assert.strictEqual(sa.status('v').nethernet.state, 'configured');
  // a config Geyser rewrote to its own default (data from before this version: no "nethernet" entry yet)
  delete mc.get('v').geyser.nethernet; delete mc.get('v').geyser.webrtcPort;
  fs.writeFileSync(f, NEW_LAYOUT);
  await sa.start('v');
  assert.deepStrictEqual([C.yamlGet(fs.readFileSync(f, 'utf8'), ['bedrock', 'transport']), mc.get('v').geyser.webrtcPort], ['both', 19133]);
  assert.deepStrictEqual(b.publicPorts().map((p) => `${p.port}/${p.proto}`), ['19132/TCP', '19133/UDP']);
  await sa.stop('v');
});
