'use strict';
/*
 * Bedrock Dedicated Server with a simulated download list, zip and process: install, settings, ports, update with worlds
 * moved over, rollback when the new version does not answer. No real BDS runs.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeHost, makeNet } = require('./helpers');
const { BedrockServers, versionOf, cmpVer } = require('../server/bds');

/** Process double: "starts" instantly, says "Server started." unless told otherwise. */
function procClass(o) {
  return class {
    constructor(id) { this.id = id; this.extra = {}; this.logs = []; this.state = 'stopped'; this.run = false; }
    isRunning() { return this.run; }
    setExtra(x) { Object.assign(this.extra, x); }
    async start({ onLine }) { this.run = true; this.state = 'running'; this.onLine = onLine; if (!o.silent()) onLine('[INFO] Server started.'); }
    write(l) { this.logs.push({ t: Date.now(), s: 'in', l }); }
    async stop() { this.run = false; this.state = 'stopped'; }
  };
}

function setup(o = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-bds-'));
  const settings = {};
  const host = makeHost(settings);
  host.ctx.paths = { data: root };
  const net = makeNet({ bds: o.bds });
  let silent = false;
  const pong = { ok: true };
  const bds = new BedrockServers(host, net, { root, platform: 'win', ManagedProcess: procClass({ silent: () => silent }), ping: async () => (pong.ok ? { players: 0 } : null) });
  return { root, host, net, bds, settings, pong, setSilent: (v) => { silent = v; } };
}

test('version from the official download address, version compare', () => {
  assert.strictEqual(versionOf('https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.52.3.zip'), '1.26.52.3');
  assert.ok(cmpVer('1.26.60.1', '1.26.52.3') > 0 && cmpVer('1.26.52.3', '1.26.52.3') === 0);
});

test('create: EULA required, free UDP ports next to Geyser, properties written, public ports for firewall/router', async () => {
  const s = setup();
  assert.throws(() => s.bds.create({ name: 'Insel' }), /EULA/);
  const r = await s.bds.create({ name: 'Insel', eula: true, public: true, gamemode: 'creative' }, new Set([19132])).promise;
  const b = s.bds.get(r.id);
  assert.deepStrictEqual([b.port, b.portv6, b.version], [19133, 19134, '1.26.52.3']);
  const st = s.bds.view(b).settings;
  assert.deepStrictEqual([st['server-name'], st.gamemode], ['Insel', 'creative']);
  assert.deepStrictEqual(s.bds.publicPorts().map((p) => `${p.port}/${p.proto}`), ['19133/UDP', '19134/UDP']);
  assert.ok(s.net.downloads[0].url.includes('bin-win'), 'Windows build from Mojang');
  const v = s.bds.setSettings(r.id, { difficulty: 'hard', 'max-players': 999, gamemode: 'nonsense' });
  assert.deepStrictEqual([v.settings.difficulty, v.settings['max-players'], v.settings.gamemode], ['hard', '200', 'survival']);
});

test('players from the log, commands, start/stop', async () => {
  const s = setup();
  const { id } = await s.bds.create({ name: 'Insel', eula: true }).promise;
  await s.bds.start(id);
  const p = s.bds.proc(s.bds.get(id));
  p.onLine('[INFO] Player connected: Steve Bedrock, xuid: 2535412345678901');
  assert.deepStrictEqual(s.bds.view(s.bds.get(id)).players, ['Steve Bedrock']);
  p.onLine('[INFO] Player disconnected: Steve Bedrock, xuid: 2535412345678901, pfid: x');
  assert.deepStrictEqual(s.bds.view(s.bds.get(id)).players, []);
  s.bds.command(id, 'say hi');
  assert.strictEqual(p.logs.pop().l, 'say hi');
  await s.bds.stop(id);
  assert.ok(!s.bds.view(s.bds.get(id)).running);
});

test('update: worlds and settings move to the new version; the old folder goes after the probe', async () => {
  const s = setup();
  const { id } = await s.bds.create({ name: 'Insel', eula: true }).promise;
  const b = s.bds.get(id);
  fs.writeFileSync(path.join(s.bds.dir(b), 'worlds', 'level.dat'), 'my world');
  s.bds.setSettings(id, { 'server-name': 'Meine Insel' });
  s.net.fetchJson = makeNet({ bds: '1.26.60.1' }).fetchJson;
  assert.strictEqual((await s.bds.checkUpdate(id)).upToDate, false);
  const r = await s.bds.update(id).promise;
  assert.strictEqual(r.version, '1.26.60.1');
  assert.strictEqual(fs.readFileSync(path.join(s.bds.dir(b), 'bedrock_server.exe'), 'utf8'), 'bds 1.26.60.1');
  assert.strictEqual(fs.readFileSync(path.join(s.bds.dir(b), 'worlds', 'level.dat'), 'utf8'), 'my world');
  assert.strictEqual(s.bds.view(b).settings['server-name'], 'Meine Insel');
  assert.ok(!fs.existsSync(`${s.bds.dir(b)}.alt`));
  assert.ok(!s.bds.proc(b).isRunning(), 'was off → off again');
});

test('update that does not answer: old version back, version skipped, notification', async () => {
  const s = setup();
  const { id } = await s.bds.create({ name: 'Insel', eula: true }).promise;
  const b = s.bds.get(id);
  fs.writeFileSync(path.join(s.bds.dir(b), 'worlds', 'level.dat'), 'my world');
  s.net.fetchJson = makeNet({ bds: '1.26.60.1' }).fetchJson;
  s.pong.ok = false;
  // shorten the probe for the test
  const probe0 = s.bds.probe.bind(s.bds);
  s.bds.probe = (x) => probe0(x, 50);
  await assert.rejects(s.bds.update(id).promise, /rolled back/);
  assert.strictEqual(fs.readFileSync(path.join(s.bds.dir(b), 'bedrock_server.exe'), 'utf8'), 'bds 1.26.52.3');
  assert.strictEqual(fs.readFileSync(path.join(s.bds.dir(b), 'worlds', 'level.dat'), 'utf8'), 'my world');
  assert.deepStrictEqual([b.version, b.failed], ['1.26.52.3', '1.26.60.1']);
  assert.ok(s.host.notes.some((n) => n.notify === 'update-failed'));
  assert.strictEqual((await s.bds.checkUpdate(id)).upToDate, true, 'failed version is skipped');
});

test('players online: the update waits', async () => {
  const s = setup();
  const { id } = await s.bds.create({ name: 'Insel', eula: true }).promise;
  await s.bds.start(id);
  s.bds.proc(s.bds.get(id)).extra.players = ['Alex'];
  assert.throws(() => s.bds.update(id), /Players are online/);
});
