'use strict';
/*
 * Test doubles: Hostwerk's Minecraft manager, the extension host and the download/job helpers – no Java, no server,
 * no network. Servers "start" by flipping a flag; downloads write the URL into the file.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.HW_TEST = '1';

const fill = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : String(s));

function makeHost(settings = {}) {
  const notes = [];
  const toasts = [];
  const host = {
    id: 'mc-network',
    ctx: { settings: { get: () => settings, save: () => {} }, keeper: { record: (k, x) => notes.push({ k, ...x }), note: (k, x) => notes.push({ k, ...x }) }, router: null, security: null },
    t: fill,
    error: (status, m) => Object.assign(new Error(m), { status }),
    broadcast: (m) => toasts.push(m),
    notifications: { register: () => 'k', notify: (id, m) => notes.push({ notify: id, ...m }) },
    log: () => {},
    notes, toasts,
  };
  return host;
}

/** servers: [{ id, name, type, version, port, network? }] */
function makeMc(servers, { root } = {}) {
  const dir = root || fs.mkdtempSync(path.join(os.tmpdir(), 'hw-mcnet-'));
  const running = new Set();
  const procs = new Map();
  const calls = [];
  const settings = { get: () => ({}), save: () => {} };
  const proc = (id) => {
    if (!procs.has(id)) procs.set(id, { extra: { players: [], ready: false }, state: 'stopped', isRunning: () => running.has(id) });
    return procs.get(id);
  };
  const mc = {
    root: dir, calls, running, settings,
    list: () => servers,
    get: (id) => { const s = servers.find((x) => x.id === id); if (!s) throw Object.assign(new Error('Server nicht gefunden'), { status: 404 }); return s; },
    dir: (id) => path.join(dir, id),
    isProxy: (s) => ['velocity', 'bungeecord'].includes(s.type),
    addonDir: (id) => path.join(dir, id, ['fabric', 'neoforge'].includes(mc.get(id).type) ? 'mods' : 'plugins'),
    proc,
    start: async (id) => { calls.push(['start', id]); running.add(id); Object.assign(proc(id).extra, { ready: true }); proc(id).state = 'running'; },
    stop: async (id) => { calls.push(['stop', id]); running.delete(id); Object.assign(proc(id).extra, { ready: false, players: [] }); proc(id).state = 'stopped'; },
    restart: async (id) => { await mc.stop(id); await mc.start(id); },
    command: async (id, cmd) => { calls.push(['cmd', id, cmd]); if (!running.has(id)) throw new Error('not running'); },
    modrinthInstall: (id, slug) => ({ id: 'j', promise: (async () => { const d = mc.addonDir(id); fs.mkdirSync(d, { recursive: true }); const name = { viaversion: 'ViaVersion', viabackwards: 'ViaBackwards', viarewind: 'ViaRewind' }[slug] || slug; fs.writeFileSync(path.join(d, `${name}-5.0.0.jar`), 'jar'); calls.push(['modrinth', id, slug]); })() }),
    create: async (b) => ({ id: 'j', promise: (async () => { const id = `${b.type}-${servers.length}`; servers.push({ id, name: b.name, type: b.type, version: '26.3', port: 25600 + servers.length }); fs.mkdirSync(path.join(dir, id), { recursive: true }); calls.push(['create', b.type, b.name]); return { id }; })() }),
    network: {
      // Core double: writes what Hostwerk's core writes (forwarding, 127.0.0.1, [servers]/try, forced hosts)
      apply: (proxyId, { members, forcedHosts }) => ({ id: 'j', promise: (async () => {
        calls.push(['core-apply', proxyId, members.map((m) => m.key), forcedHosts]);
        for (const s of servers.filter((x) => x.network && x.network.proxy === proxyId && !members.some((m) => m.id === x.id))) delete s.network;
        for (const m of members) { const s = mc.get(m.id); s.network = { proxy: proxyId, key: m.key, prevOnline: 'true', prevIp: '' }; fs.mkdirSync(mc.dir(m.id), { recursive: true }); fs.writeFileSync(path.join(mc.dir(m.id), 'server.properties'), 'online-mode=false\nserver-ip=127.0.0.1\n'); }
        const toml = ['config-version = "2.7"', 'bind = "0.0.0.0:25577"', 'motd = "<#09add3>A Velocity Server"', 'online-mode = true', 'player-info-forwarding-mode = "modern"', '', '[servers]', ...members.map((m) => `${m.key} = "127.0.0.1:${mc.get(m.id).port}"`), `try = [${members.map((m) => `"${m.key}"`).join(', ')}]`, '', '[forced-hosts]', ...Object.entries(forcedHosts || {}).map(([h, k]) => `"${h}" = ["${k[0]}"]`), '', '[advanced]', 'compression-threshold = 256', ''].join('\n');
        fs.mkdirSync(mc.dir(proxyId), { recursive: true });
        fs.writeFileSync(path.join(mc.dir(proxyId), 'velocity.toml'), toml);
        if (!fs.existsSync(path.join(mc.dir(proxyId), 'forwarding.secret'))) fs.writeFileSync(path.join(mc.dir(proxyId), 'forwarding.secret'), 'S3CRET');
      })() }),
    },
    updates: { state: {}, get: (id) => mc.updates.state[id] || null },
    changeVersion: (id) => ({ id: 'j', promise: (async () => { const d = mc.dir(id); fs.mkdirSync(d, { recursive: true }); const jar = path.join(d, 'server.jar'); if (fs.existsSync(jar)) fs.renameSync(jar, path.join(d, 'server.jar.alt')); fs.writeFileSync(jar, 'new'); mc.get(id).build = '999'; calls.push(['changeVersion', id]); })() }),
  };
  for (const s of servers) fs.mkdirSync(path.join(dir, s.id), { recursive: true });
  return mc;
}

/** Download/job doubles. builds: { geyser, floodgate } numbers for the GeyserMC API; modrinthTarget: Java version Geyser speaks. */
function makeNet(o = {}) {
  const net = {
    builds: { geyser: 1267, floodgate: 141, geyseroptionalpack: 30, ...(o.builds || {}) },
    modrinthTarget: o.modrinthTarget || '26.3',
    downloads: [],
    fetchJson: async (url) => {
      if (/api\.modrinth\.com\/v2\/project\/geyser\/version/.test(url)) return [{ game_versions: ['1.21.11', '26.1', net.modrinthTarget] }];
      const m = url.match(/projects\/([^/]+)\/versions\/latest/);
      if (m) {
        const project = m[1];
        const version = project === 'floodgate' ? '2.2.5' : '2.12.0';
        const downloads = Object.fromEntries(['spigot', 'velocity', 'bungee', 'bungeecord', 'fabric', 'neoforge', 'standalone', 'geyseroptionalpack'].map((p) => [p, { name: `${project}-${p}.jar`, sha256: 'ab'.repeat(32) }]));
        return { version, build: net.builds[project], downloads };
      }
      if (/api\.mojang\.com/.test(url)) { const name = decodeURIComponent(url.split('/').pop()); if (name === 'Nobody') throw new Error('404'); return { id: '069a79f444e94726a5befca90e38aaf5', name }; }
      if (/api\.geysermc\.org\/v2\/xbox\/xuid/.test(url)) return { xuid: 2535412345678901 };
      if (/download\/links/.test(url)) return { result: { links: [{ downloadType: 'serverBedrockWindows', downloadUrl: `https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-${o.bds || '1.26.52.3'}.zip` }, { downloadType: 'serverBedrockLinux', downloadUrl: `https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-${o.bds || '1.26.52.3'}.zip` }] } };
      throw new Error(`unexpected fetch ${url}`);
    },
    downloadFile: async (url, file, opts = {}) => { net.downloads.push({ url, file, sha256: opts.sha256 }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, url); return file; },
    extractZip: async (zip, dir) => { fs.mkdirSync(dir, { recursive: true }); const v = (fs.readFileSync(zip, 'utf8').match(/bedrock-server-([\d.]+?)\.zip/) || [])[1]; for (const f of ['bedrock_server.exe', 'bedrock_server']) fs.writeFileSync(path.join(dir, f), `bds ${v}`); fs.writeFileSync(path.join(dir, 'server.properties'), 'server-name=Dedicated Server\ngamemode=survival\nserver-port=19132\nserver-portv6=19133\n'); fs.mkdirSync(path.join(dir, 'worlds'), { recursive: true }); },
    runJob: (title, fn) => { const job = { title, lines: [], progress() {}, log: (l) => job.lines.push(l) }; const p = fn(job); return { id: `job-${title}`, job, promise: p }; },
  };
  return net;
}

module.exports = { makeHost, makeMc, makeNet, fill };
