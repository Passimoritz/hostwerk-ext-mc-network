'use strict';
/* Configuration files: velocity.toml, paper-global.yml/spigot.yml, BungeeCord config.yml, Geyser (both layouts), Floodgate, lists. */
const test = require('node:test');
const assert = require('node:assert');
const C = require('../server/configs');

const PAPER_GLOBAL = '# comment stays\n_version: 29\nproxies:\n  bungee-cord:\n    online-mode: true\n  proxy-protocol: false\n  velocity:\n    enabled: false\n    online-mode: false\n    secret: \'\'\nscoreboards:\n  track-plugin-scoreboards: false\n';

test('paper-global.yml: modern forwarding with the secret, everything else untouched', () => {
  const t = C.paperProxyText(PAPER_GLOBAL, { kind: 'velocity', secret: 'abc"1' });
  assert.strictEqual(C.yamlGet(t, ['proxies', 'velocity', 'enabled']), true);
  assert.strictEqual(C.yamlGet(t, ['proxies', 'velocity', 'online-mode']), true);
  assert.strictEqual(C.yamlGet(t, ['proxies', 'velocity', 'secret']), 'abc"1');
  assert.match(t, /^# comment stays/);
  assert.strictEqual(C.yamlGet(t, ['scoreboards', 'track-plugin-scoreboards']), false);
  // BungeeCord: Velocity forwarding off again, bungee-cord online-mode on
  const b = C.paperProxyText(t, { kind: 'bungeecord' });
  assert.strictEqual(C.yamlGet(b, ['proxies', 'velocity', 'enabled']), false);
  assert.strictEqual(C.yamlGet(b, ['proxies', 'bungee-cord', 'online-mode']), true);
});

test('YAML editor: creates missing parents, keeps CRLF, turns "{}" into a block', () => {
  assert.strictEqual(C.yamlSet('', ['settings', 'bungeecord'], true), 'settings:\n  bungeecord: true\n');
  const crlf = C.yamlSet('settings:\r\n  debug: false\r\n', ['settings', 'bungeecord'], true);
  assert.strictEqual(crlf, 'settings:\r\n  debug: false\r\n  bungeecord: true\r\n');
  assert.strictEqual(C.yamlGet(C.yamlSet('a:\n  b: {}\n', ['a', 'b', 'c'], 1), ['a', 'b', 'c']), 1);
  // same key name at another level is not mixed up
  const t = C.yamlSet('x:\n  port: 1\nbedrock:\n  port: 2\n', ['bedrock', 'port'], 9);
  assert.strictEqual(C.yamlGet(t, ['x', 'port']), 1);
  assert.strictEqual(C.yamlGet(t, ['bedrock', 'port']), 9);
});

test('velocity.toml: online-mode, modern forwarding, MOTD, limit, ping passthrough – sections stay', () => {
  const src = 'config-version = "2.7"\nbind = "0.0.0.0:25577"\nmotd = "<#09add3>A Velocity Server"\nonline-mode = false\n\n[servers]\nlobby = "127.0.0.1:25566"\ntry = ["lobby"]\n\n[forced-hosts]\n"lobby.example.com" = ["lobby"]\n\n[advanced]\ncompression-threshold = 256\n';
  const t = C.velocityTopText(src, { motd: C.velocityMotd('Hello', 'World'), showMaxPlayers: 50, pingPassthrough: 'DESCRIPTION', kickExisting: true });
  assert.strictEqual(C.tomlTopGet(t, 'online-mode'), true, 'the proxy checks accounts');
  assert.strictEqual(C.tomlTopGet(t, 'player-info-forwarding-mode'), 'modern');
  assert.strictEqual(C.tomlTopGet(t, 'motd'), 'Hello\nWorld');
  assert.strictEqual(C.tomlTopGet(t, 'show-max-players'), 50);
  assert.strictEqual(C.tomlTopGet(t, 'ping-passthrough'), 'DESCRIPTION');
  assert.match(t, /\[advanced\]\ncompression-threshold = 256/);
  assert.strictEqual(C.tomlTopGet(C.velocityTopText(t, { pingPassthrough: 'NONSENSE' }), 'ping-passthrough'), 'DISABLED');
});

test('velocity.toml routing: maintenance leaves try, forced hosts written', () => {
  const src = '[servers]\nlobby = "127.0.0.1:1"\nsurvival = "127.0.0.1:2"\ntry = ["lobby", "survival"]\n\n[forced-hosts]\n\n[advanced]\nx = 1\n';
  const t = C.velocityRouting(src, { tryKeys: ['lobby'], forced: { 'survival.example.org': 'survival' } });
  assert.match(t, /try = \["lobby"\]/);
  assert.match(t, /survival = "127\.0\.0\.1:2"/, 'server stays known (/server works for staff)');
  assert.match(t, /\[forced-hosts\]\n"survival\.example\.org" = \["survival"\]/);
  assert.match(t, /\[advanced\]\nx = 1/);
});

test('BungeeCord config.yml: ip_forward, online_mode, 127.0.0.1, priorities, forced hosts; port before start', () => {
  const t = C.bungeeConfigText({ port: 25577, motd: 'Net', servers: [{ key: 'lobby', port: 25566 }, { key: 'pvp', port: 25567, restricted: true }], forced: { 'pvp.example.org': 'pvp' } });
  assert.match(t, /^ip_forward: true$/m);
  assert.match(t, /^online_mode: true$/m);
  assert.match(t, /address: "127\.0\.0\.1:25567"\n {4}restricted: true/);
  assert.match(t, /priorities:\n {2}- "lobby"\n {2}- "pvp"/);
  assert.match(t, /"pvp\.example\.org": "pvp"/);
  assert.match(C.bungeePortText(t, 25600), /host: "0\.0\.0\.0:25600"/);
  // no server yet: a closed placeholder – BungeeCord does not start with an empty list
  const empty = C.bungeeConfigText({ port: 1, servers: [] });
  assert.match(empty, /^servers:\n  none:\n[\s\S]*address: "127\.0\.0\.1:1"\n    restricted: true$/m);
  assert.match(empty, /priorities:\n  - "none"/);
});

const NEW_GEYSER = 'bedrock:\n  address: 0.0.0.0\n  port: 19132\njava:\n  address: 127.0.0.1\n  port: 25565\n  auth-type: online\nmotd:\n  primary-motd: Geyser\n  secondary-motd: Another Geyser server.\n  passthrough-motd: true\n  max-players: 100\ngameplay:\n  server-name: Geyser\n  show-coordinates: true\nconfig-version: 11\n';

test('Geyser: new config in the classic layout; edits land in the layout of the file', () => {
  const fresh = C.geyserConfigText({ port: 19140, motd1: 'Hi', serverName: 'Net', authType: 'floodgate' });
  assert.match(fresh, /config-version: 4/);
  assert.deepStrictEqual([C.yamlGet(fresh, ['bedrock', 'port']), C.yamlGet(fresh, ['remote', 'auth-type']), C.yamlGet(fresh, ['bedrock', 'motd1'])], [19140, 'floodgate', 'Hi']);
  assert.strictEqual(C.geyserRead(fresh).layout, 'classic');
  // Geyser 2.9+ layout: java/motd/gameplay sections
  const t = C.geyserPatchText(NEW_GEYSER, { port: 19133, authType: 'floodgate', motd1: 'Hallo', motd2: 'Welt', serverName: 'Mein Netz', maxPlayers: 40, passthrough: false });
  const r = C.geyserRead(t);
  assert.strictEqual(r.layout, 'new');
  assert.deepStrictEqual([r.port, r.authType, r.motd1, r.motd2, r.serverName, r.maxPlayers, r.passthrough], [19133, 'floodgate', 'Hallo', 'Welt', 'Mein Netz', 40, false]);
  assert.match(t, /^ {2}auth-type: floodgate$/m, 'enum unquoted');
  assert.ok(!/^remote:/m.test(t) && !/motd1/.test(t), 'no classic keys in a new-layout file');
});

test('Floodgate: minimal new file, proxy sends the data, prefix check', () => {
  const t = C.floodgateText('', { prefix: '*', proxy: true });
  assert.match(t, /config-version: 3/);
  assert.strictEqual(C.yamlGet(t, ['username-prefix']), '*');
  assert.strictEqual(C.yamlGet(t, ['send-floodgate-data']), true);
  const existing = C.floodgateText('key-file-name: key.pem\nusername-prefix: "."\nsend-floodgate-data: false\nplayer-link:\n  enabled: true\n', { proxy: true, globalLinking: false });
  assert.strictEqual(C.yamlGet(existing, ['send-floodgate-data']), true);
  assert.strictEqual(C.yamlGet(existing, ['player-link', 'enable-global-linking']), false);
  assert.ok(C.validPrefix('.') && C.validPrefix('*') && !C.validPrefix('a') && !C.validPrefix('') && !C.validPrefix('....'));
});

test('player lists: network entries merged, own entries of a server stay, removed network entries go', () => {
  const cur = [{ uuid: 'own', name: 'Admin' }, { uuid: 'u1', name: 'Old' }];
  const r = C.mergeList(cur, [{ uuid: 'u2', name: 'New' }], ['u1'], C.shapes.whitelist);
  assert.deepStrictEqual(r.list.map((x) => x.uuid), ['own', 'u2']);
  assert.deepStrictEqual(r.managed, ['u2']);
  assert.strictEqual(C.mergeList([], [{ uuid: 'x', name: 'A' }], [], C.shapes.ops).list[0].level, 4);
  assert.strictEqual(C.dashUuid('069a79f444e94726a5befca90e38aaf5'), '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  assert.strictEqual(C.floodgateUuid('2535412345678901'), '00000000-0000-0000-0009-01f1b0392c35');
});

test('server.properties, hosts, ports, icon size', () => {
  assert.strictEqual(C.writeProps('a=1\r\nb=2\r\n', { b: '3', c: '4' }), 'a=1\r\nb=3\r\nc=4\r\n');
  assert.ok(C.validHost('survival.example.org') && !C.validHost('nope') && !C.validHost('a..b'));
  assert.strictEqual(C.pickPort(19132, new Set([19132, 19133])), 19134);
  const png = Buffer.alloc(33); png.writeUInt32BE(0x89504e47, 0); png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(64, 16); png.writeUInt32BE(64, 20);
  assert.ok(C.pngSize(png).ok);
  png.writeUInt32BE(128, 16);
  assert.deepStrictEqual(C.pngSize(png), { ok: false, w: 128, h: 64 });
});

test('Velocity 4 (config 2.9): ping passthrough goes into the [ping-passthrough] section, never a second top-level key', () => {
  const v4 = ['config-version = "2.9"', 'bind = "0.0.0.0:25565"', 'online-mode = true', '', '[ping-passthrough]', 'version = false', 'players = false', 'description = false', 'favicon = false', 'modinfo = false', '', '[servers]', 'lobby = "127.0.0.1:30066"', ''].join('\n');
  let t = C.velocityTopText(v4, { pingPassthrough: 'DESCRIPTION' });
  assert.ok(!/^ping-passthrough\s*=/m.test(t), 'no top-level key next to the section');
  assert.match(t, /\[ping-passthrough\][^[]*description = true[^[]*favicon = true[^[]*modinfo = true/);
  assert.match(t, /\[ping-passthrough\][^[]*version = false/);
  t = C.velocityTopText(`ping-passthrough = "ALL"\n${v4}`, { pingPassthrough: 'ALL' });
  assert.strictEqual((t.match(/ping-passthrough/g) || []).length, 1, 'a wrongly written top-level key is removed again');
  assert.match(t, /version = true[\s\S]*players = true/);
  assert.match(t, /\[servers\]\nlobby/, 'next section untouched');
  // Velocity 3: still one value at the top
  assert.match(C.velocityTopText('bind = "0.0.0.0:25577"\n\n[servers]\n', { pingPassthrough: 'MODS' }), /^ping-passthrough = "MODS"$/m);
});
