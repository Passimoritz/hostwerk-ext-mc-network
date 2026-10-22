'use strict';
/* The extension starts inside a Hostwerk double: routes, BungeeCord type, minecraft.geyser hook, port provider, clean stop. */
const test = require('node:test');
const assert = require('node:assert');
const { makeHost, makeMc, makeNet } = require('./helpers');

test('activate wires everything up and deactivate takes it back', async () => {
  const mc = makeMc([{ id: 'p', name: 'Proxy', type: 'velocity', version: '3.4.0', port: 25577 }, { id: 'l', name: 'Lobby', type: 'paper', version: '26.3', port: 25566, network: { proxy: 'p', key: 'lobby' } }]);
  const types = new Map();
  mc.registerType = (id, def, owner) => { types.set(id, { def, owner }); return () => types.delete(id); };
  const settings = {};
  const host = makeHost(settings);
  const routes = [];
  const verb = (m) => (p, fn) => routes.push([m, p, fn]);
  host.router = { get: verb('GET'), post: verb('POST'), put: verb('PUT'), delete: verb('DELETE') };
  const providers = new Map();
  host.ctx.security = { addPortProvider: (id, fn) => providers.set(id, fn), removePortProvider: (id) => providers.delete(id) };
  host.ctx.minecraft = mc;
  host.ctx.paths = { data: mc.root };
  const net = makeNet();
  host.core = (name) => (name === 'download' ? { fetchJson: net.fetchJson, downloadFile: net.downloadFile, extractZip: net.extractZip } : name === 'jobs' ? { runJob: net.runJob } : { ManagedProcess: class { constructor() { this.extra = {}; this.logs = []; } isRunning() { return false; } } });
  // The old bridge still runs and owns the name "bedrock" – provide() would refuse it
  host.ctx.bedrock = { status: () => 'old', isBedrock: () => 'old' };
  host.provide = (n) => { throw new Error(`provide: "${n}" is already provided`); };
  host.on = () => {};
  const ext = require('../server/index');
  ext.activate(host);
  assert.ok(mc.geyser && typeof mc.geyser.applyStaged === 'function' && typeof mc.geyser.checkAll === 'function', 'Hostwerk asks minecraft.geyser before every start');
  assert.strictEqual(types.get('bungeecord').def.proxy, true);
  assert.ok(types.get('bungeecord').def.hidden, 'not in the normal create dialog');
  assert.ok(providers.has('mc-network'));
  assert.notStrictEqual(host.ctx.bedrock.isBedrock('p', 'x'), 'old', 'service of the old bridge taken over in place');
  assert.strictEqual(settings.mcNetwork.networks.length, 1, 'existing Velocity network taken over');
  const paths = routes.map((r) => `${r[0]} ${r[1]}`);
  for (const p of ['GET /mc-network', 'POST /mc-network', 'POST /mc-network/net/:id/run/:action', 'POST /mc-network/bedrock/:server', 'POST /mc-network/bds', 'POST /mc-network/move-to-proxy/:proxy']) assert.ok(paths.includes(p), p);
  assert.ok(!paths.some((p) => /\(/.test(p)), 'no regex in paths (Express 5)');
  // overview answers
  let out = null;
  await routes.find((r) => r[0] === 'GET' && r[1] === '/mc-network')[2]({ query: {}, params: {} }, { json: (x) => { out = x; } });
  assert.strictEqual(out.networks[0].members[0].key, 'lobby');
  await ext.deactivate();
  assert.ok(!mc.geyser && !types.has('bungeecord') && !providers.has('mc-network'));
});

test('with Hostwerk’s Bedrock server type: new Bedrock servers go to the core, Standalone routes exist', async () => {
  const servers = [{ id: 'v', name: 'Vanilla', type: 'vanilla', version: '26.3', port: 25565 }, { id: 'bed', name: 'Insel', type: 'bedrock', version: '1.26.52.3', port: 19140, portv6: 19141 }];
  const mc = makeMc(servers);
  mc.isBedrock = (s) => s.type === 'bedrock';
  mc.bedrock = {};
  const created = [];
  mc.create = async (b) => { created.push(b); return { id: 'job-core' }; };
  const host = makeHost({});
  const routes = [];
  const verb = (m) => (p, fn) => routes.push([m, p, fn]);
  host.router = { get: verb('GET'), post: verb('POST'), put: verb('PUT'), delete: verb('DELETE') };
  host.ctx.minecraft = mc;
  host.ctx.paths = { data: mc.root };
  const net = makeNet();
  host.core = (name) => (name === 'download' ? { fetchJson: net.fetchJson, downloadFile: net.downloadFile, extractZip: net.extractZip } : name === 'jobs' ? { runJob: net.runJob } : { ManagedProcess: class { constructor() { this.extra = {}; this.logs = []; } isRunning() { return false; } } });
  host.provide = () => {};
  const events = [];
  host.on = (ev) => { events.push(ev); };
  const ext = require('../server/index');
  ext.activate(host);
  assert.ok(events.includes('service'), 'Geyser Standalone follows its server through the service event');
  const call = async (m, p, req) => { let out; await routes.find((r) => r[0] === m && r[1] === p)[2]({ query: {}, params: {}, body: {}, ...req }, { json: (x) => { out = x; } }); return out; };
  const o = await call('GET', '/mc-network');
  assert.deepStrictEqual([o.bdsCore, o.coreBds.map((b) => b.id), o.bedrock.map((b) => b.id)], [true, ['bed'], ['v']]);
  assert.strictEqual(o.bedrock[0].standalonePossible, true);
  await assert.rejects(() => call('POST', '/mc-network/bds', { body: { name: 'X' } }), /EULA/);
  const r = await call('POST', '/mc-network/bds', { body: { name: 'Neu', eula: true, gamemode: 'creative' } });
  assert.deepStrictEqual([r.job, created[0].type, created[0].name, created[0].gamemode], ['job-core', 'bedrock', 'Neu', 'creative']);
  const paths = routes.map((x) => `${x[0]} ${x[1]}`);
  for (const p of ['POST /mc-network/standalone/:server', 'POST /mc-network/standalone/:server/update', 'GET /mc-network/standalone/:server/log', 'POST /mc-network/bds/:id/to-core']) assert.ok(paths.includes(p), p);
  await ext.deactivate();
});
