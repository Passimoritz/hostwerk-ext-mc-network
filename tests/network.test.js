'use strict';
/*
 * Networks with a simulated Minecraft manager: Velocity through Hostwerk's core (double), BungeeCord set up here, forced
 * hosts, MOTD, maintenance, shared lists, start order, checks, safe proxy update with rollback.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeHost, makeMc, makeNet } = require('./helpers');
const { Bedrock } = require('../server/bedrock');
const { McNetworks } = require('../server/network');
const C = require('../server/configs');

function setup() {
  const servers = [
    { id: 'lobby', name: 'Lobby', type: 'paper', version: '26.3', port: 25566 },
    { id: 'survival', name: 'Survival', type: 'purpur', version: '26.3', port: 25567 },
    { id: 'mods', name: 'Mods', type: 'fabric', version: '26.3', port: 25568 },
    { id: 'van', name: 'Vanilla', type: 'vanilla', version: '26.3', port: 25569 },
  ];
  const mc = makeMc(servers);
  const settings = {};
  const host = makeHost(settings);
  const net = makeNet();
  const b = new Bedrock(host, mc, net, { udpFree: async () => true });
  const n = new McNetworks(host, mc, b, net, { readyMs: 200, pollMs: 5 });
  for (const s of servers) fs.writeFileSync(path.join(mc.dir(s.id), 'server.properties'), 'online-mode=true\nserver-ip=\nmotd=x\n');
  return { mc, host, net, b, n, servers, settings };
}

test('Velocity network: proxy created, members through the core, lobby first, Vanilla refused', async () => {
  const s = setup();
  assert.throws(() => s.n.create({ name: 'Net', members: ['van'] }), /cannot run behind Velocity/);
  const r = await s.n.create({ name: 'Net', kind: 'velocity', members: ['lobby', 'survival', 'mods'] }).promise;
  const net = s.n.get(r.id);
  assert.strictEqual(s.mc.get(net.proxy).type, 'velocity');
  assert.deepStrictEqual(net.members.map((m) => m.key), ['lobby', 'survival', 'mods']);
  const apply = s.mc.calls.find((c) => c[0] === 'core-apply');
  assert.deepStrictEqual(apply[2], ['lobby', 'survival', 'mods']);
  const toml = fs.readFileSync(path.join(s.mc.dir(net.proxy), 'velocity.toml'), 'utf8');
  assert.match(toml, /try = \["lobby", "survival", "mods"\]/);
  assert.strictEqual(C.tomlTopGet(toml, 'online-mode'), true);
  assert.throws(() => s.n.create({ name: 'Other', members: ['lobby'] }), /already in the network/);
});

test('settings: forced hosts validated and written, MOTD/limit/ping passthrough, reload of a running proxy', async () => {
  const s = setup();
  const { id } = await s.n.create({ name: 'Net', members: ['lobby', 'survival'] }).promise;
  const net = s.n.get(id);
  await assert.rejects(s.n.setSettings(id, { forced: { 'not a host': 'lobby' } }), /not a valid address/);
  await assert.rejects(s.n.setSettings(id, { forced: { 'x.example.org': 'nope' } }), /not in the network/);
  await s.mc.start(net.proxy);
  await s.n.setSettings(id, { forced: { 'Survival.Example.org': 'survival' }, motd1: 'Willkommen', motd2: 'Java + Bedrock', showMaxPlayers: 64, pingPassthrough: 'ALL' });
  const toml = fs.readFileSync(path.join(s.mc.dir(net.proxy), 'velocity.toml'), 'utf8');
  assert.match(toml, /"survival\.example\.org" = \["survival"\]/);
  assert.strictEqual(C.tomlTopGet(toml, 'motd'), 'Willkommen\nJava + Bedrock');
  assert.strictEqual(C.tomlTopGet(toml, 'show-max-players'), 64);
  assert.ok(s.mc.calls.some((c) => c[0] === 'cmd' && c[2] === 'velocity reload'));
});

test('maintenance: server leaves try and forced hosts, players go to the lobby, last open server stays', async () => {
  const s = setup();
  const { id } = await s.n.create({ name: 'Net', members: ['lobby', 'survival'] }).promise;
  const net = s.n.get(id);
  await s.n.setSettings(id, { forced: { 'survival.example.org': 'survival' } });
  await s.mc.start(net.proxy); await s.mc.start('survival');
  s.mc.proc('survival').extra.players = ['Alex', '.BedrockBob'];
  const v = await s.n.maintenance(id, 'survival', true, { stop: true });
  assert.deepStrictEqual(v.moved, ['Alex', '.BedrockBob']);
  assert.ok(s.mc.calls.some((c) => c[0] === 'cmd' && c[2] === 'send .BedrockBob lobby'));
  const toml = fs.readFileSync(path.join(s.mc.dir(net.proxy), 'velocity.toml'), 'utf8');
  assert.match(toml, /try = \["lobby"\]/);
  assert.ok(!/survival\.example\.org/.test(toml));
  assert.ok(!s.mc.running.has('survival'), 'stopped after moving the players');
  await assert.rejects(s.n.maintenance(id, 'lobby', true), /At least one server/);
  await s.n.maintenance(id, 'survival', false);
  assert.match(fs.readFileSync(path.join(s.mc.dir(net.proxy), 'velocity.toml'), 'utf8'), /try = \["lobby", "survival"\]/);
});

test('BungeeCord network: IP forwarding, 127.0.0.1, offline backends, config.yml – and back when leaving', async () => {
  const s = setup();
  s.servers.push({ id: 'bc', name: 'Bungee', type: 'bungeecord', version: 'latest', port: 25577 });
  fs.mkdirSync(s.mc.dir('bc'), { recursive: true });
  assert.throws(() => s.n.create({ name: 'B', kind: 'bungeecord', proxyId: 'bc', members: ['mods'] }), /cannot run behind BungeeCord/);
  const { id } = await s.n.create({ name: 'B', kind: 'bungeecord', proxyId: 'bc', members: ['lobby', 'survival'] }).promise;
  const props = C.readProps(fs.readFileSync(path.join(s.mc.dir('lobby'), 'server.properties'), 'utf8'));
  assert.deepStrictEqual([props['online-mode'], props['server-ip']], ['false', '127.0.0.1']);
  assert.strictEqual(C.yamlGet(fs.readFileSync(path.join(s.mc.dir('lobby'), 'spigot.yml'), 'utf8'), ['settings', 'bungeecord']), true);
  const cfg = fs.readFileSync(path.join(s.mc.dir('bc'), 'config.yml'), 'utf8');
  assert.match(cfg, /lobby:\n {4}motd: "Lobby"\n {4}address: "127\.0\.0\.1:25566"/);
  assert.match(cfg, /^ip_forward: true$/m);
  assert.ok(s.n.checks(id).some((c) => c.level === 'info' && /without a secret/.test(c.text)));
  await s.n.setMembers(id, { members: [{ id: 'lobby', key: 'lobby' }] }).promise;
  const back = C.readProps(fs.readFileSync(path.join(s.mc.dir('survival'), 'server.properties'), 'utf8'));
  assert.deepStrictEqual([back['online-mode'], back['server-ip']], ['true', ''], 'previous values back');
  assert.strictEqual(C.yamlGet(fs.readFileSync(path.join(s.mc.dir('survival'), 'spigot.yml'), 'utf8'), ['settings', 'bungeecord']), false);
  assert.ok(!s.servers.find((x) => x.id === 'survival').network);
});

test('shared lists: Java and Bedrock names resolved, written to every server, own entries kept, running servers get commands', async () => {
  const s = setup();
  const { id } = await s.n.create({ name: 'Net', members: ['lobby', 'survival'] }).promise;
  fs.writeFileSync(path.join(s.mc.dir('lobby'), 'whitelist.json'), JSON.stringify([{ uuid: 'own-1', name: 'LocalAdmin' }]));
  await s.mc.start('survival');
  await s.n.setWhitelist(id, true);
  await s.n.listAdd(id, 'players', 'Notch');
  await s.n.listAdd(id, 'players', '.Bob');
  await assert.rejects(s.n.listAdd(id, 'players', 'Nobody'), /not found/);
  const wl = JSON.parse(fs.readFileSync(path.join(s.mc.dir('lobby'), 'whitelist.json'), 'utf8'));
  assert.deepStrictEqual(wl.map((x) => x.name), ['LocalAdmin', 'Notch', '.Bob']);
  assert.strictEqual(wl[2].uuid, '00000000-0000-0000-0009-01f1b0392c35', 'Floodgate UUID from the xuid');
  assert.strictEqual(C.readProps(fs.readFileSync(path.join(s.mc.dir('survival'), 'server.properties'), 'utf8'))['white-list'], 'true');
  assert.ok(s.mc.calls.some((c) => c[0] === 'cmd' && c[1] === 'survival' && c[2] === 'whitelist reload'));
  await s.n.listAdd(id, 'ops', 'Notch');
  assert.ok(s.mc.calls.some((c) => c[0] === 'cmd' && c[2] === 'op Notch'));
  await s.n.listRemove(id, 'players', '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  const wl2 = JSON.parse(fs.readFileSync(path.join(s.mc.dir('lobby'), 'whitelist.json'), 'utf8'));
  assert.deepStrictEqual(wl2.map((x) => x.name), ['LocalAdmin', '.Bob']);
});

test('start order: servers first (until ready), proxy last; stop: proxy first; servers in maintenance stay off', async () => {
  const s = setup();
  const { id } = await s.n.create({ name: 'Net', members: ['lobby', 'survival'] }).promise;
  const net = s.n.get(id);
  s.mc.calls.length = 0;
  await s.n.run(id, 'start').promise;
  assert.deepStrictEqual(s.mc.calls.filter((c) => c[0] === 'start').map((c) => c[1]), ['lobby', 'survival', net.proxy]);
  s.mc.calls.length = 0;
  await s.n.run(id, 'stop').promise;
  assert.deepStrictEqual(s.mc.calls.filter((c) => c[0] === 'stop').map((c) => c[1]), [net.proxy, 'survival', 'lobby']);
  await s.n.maintenance(id, 'survival', true);
  s.mc.calls.length = 0;
  await s.n.run(id, 'start').promise;
  assert.ok(!s.mc.calls.some((c) => c[0] === 'start' && c[1] === 'survival'));
});

test('checks: safe network is fine; a server listening on all addresses or without the secret is an error', async () => {
  const s = setup();
  const { id } = await s.n.create({ name: 'Net', members: ['lobby'] }).promise;
  assert.strictEqual(s.n.checks(id)[0].level, 'ok');
  fs.writeFileSync(path.join(s.mc.dir('lobby'), 'server.properties'), 'online-mode=false\nserver-ip=\n');
  fs.mkdirSync(path.join(s.mc.dir('lobby'), 'config'), { recursive: true });
  fs.writeFileSync(path.join(s.mc.dir('lobby'), 'config', 'paper-global.yml'), 'proxies:\n  velocity:\n    enabled: true\n    secret: "wrong"\n');
  const c = s.n.checks(id);
  assert.ok(c.some((x) => x.level === 'err' && /127\.0\.0\.1/.test(x.text)));
  assert.ok(c.some((x) => x.level === 'err' && /forwarding secret/.test(x.text)));
});

test('proxy update: only when nobody is online; a build that does not start is rolled back and skipped', async () => {
  const s = setup();
  const { id } = await s.n.create({ name: 'Net', members: ['lobby'] }).promise;
  const net = s.n.get(id);
  const p = s.mc.get(net.proxy);
  p.build = '500';
  fs.writeFileSync(path.join(s.mc.dir(p.id), 'server.jar'), 'old');
  await s.mc.start(p.id);
  s.mc.updates.state[p.id] = { server: { build: '600' } };
  s.mc.proc(p.id).extra.players = ['Steve'];
  await s.n.proxyUpdateTick();
  assert.ok(!s.mc.calls.some((c) => c[0] === 'changeVersion'), 'players online → waits');
  s.mc.proc(p.id).extra.players = [];
  // the new build never gets ready
  const start0 = s.mc.start;
  s.mc.start = async (x) => { await start0(x); if (x === p.id && fs.readFileSync(path.join(s.mc.dir(p.id), 'server.jar'), 'utf8') === 'new') s.mc.proc(x).extra.ready = false; };
  await s.n.proxyUpdateTick();
  assert.strictEqual(fs.readFileSync(path.join(s.mc.dir(p.id), 'server.jar'), 'utf8'), 'old', 'old jar back');
  assert.strictEqual(p.build, '500');
  assert.strictEqual(net.proxyUpdates.failed, '600');
  assert.ok(s.host.notes.some((x) => x.notify === 'update-failed'));
  s.mc.calls.length = 0;
  await s.n.proxyUpdateTick();
  assert.ok(!s.mc.calls.some((c) => c[0] === 'changeVersion'), 'failed build skipped');
});

test('taking over an existing Velocity proxy keeps the try order', () => {
  const s = setup();
  s.servers.push({ id: 'vp', name: 'Old proxy', type: 'velocity', version: '3.4.0', port: 25577 });
  fs.mkdirSync(s.mc.dir('vp'), { recursive: true });
  fs.writeFileSync(path.join(s.mc.dir('vp'), 'velocity.toml'), '[servers]\na = "127.0.0.1:1"\nb = "127.0.0.1:2"\ntry = ["survival", "lobby"]\n');
  s.mc.get('lobby').network = { proxy: 'vp', key: 'lobby' };
  s.mc.get('survival').network = { proxy: 'vp', key: 'survival' };
  assert.deepStrictEqual(s.n.proxies().map((x) => x.id), ['vp']);
  const v = s.n.adopt('vp');
  assert.deepStrictEqual(v.members.map((m) => m.key), ['survival', 'lobby']);
  assert.ok(v.members[0].lobby);
});
