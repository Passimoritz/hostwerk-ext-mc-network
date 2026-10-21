'use strict';
/*
 * Configuration files of the network – pure text functions, no file access (everything here is tested on its own).
 *
 * Kept small on purpose: only the keys Hostwerk owns are written, everything else in a file stays as it is. That is why
 * there is a tiny block-YAML editor instead of re-serialising whole files (comments and order survive), and TOML is only
 * touched at the top level (velocity.toml) – the [servers]/[forced-hosts] sections are written by Hostwerk's core.
 *
 * Geyser: since Geyser 2.9 its config.yml has a new layout ("java:" instead of "remote:", "motd:" and "gameplay:"
 * sections, config-version 5 and up). Geyser migrates the classic layout (config-version 4) by itself – so a new
 * config is written in the classic layout (a stable contract) and existing files are edited in whichever layout they have.
 */

/* ---------------- server.properties ---------------- */

function readProps(text) {
  const out = {};
  for (const l of String(text || '').split(/\r?\n/)) { const m = l.match(/^([\w.-]+)=(.*)$/); if (m) out[m[1]] = m[2]; }
  return out;
}
function writeProps(text, values) {
  const done = new Set();
  const src = String(text || '#Minecraft server properties\n');
  const nl = /\r\n/.test(src) ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/).map((l) => {
    const m = l.match(/^([\w.-]+)=/);
    if (m && m[1] in values) { done.add(m[1]); return `${m[1]}=${values[m[1]]}`; }
    return l;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(values)) if (!done.has(k)) lines.push(`${k}=${v}`);
  return lines.join(nl) + nl;
}

/* ---------------- Tiny block-YAML editor ---------------- */

const indentOf = (l) => l.match(/^ */)[0].length;
const blank = (l) => /^\s*(#.*)?$/.test(l);
const keyRe = (k) => new RegExp(`^( *)(?:"${k.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}"|'${k.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}'|${k.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')})\\s*:(\\s|$)`);

/** Find a key path → { line, indent, end } (end = first line after its block) or null. */
function yamlFind(lines, keys) {
  let from = 0; let to = lines.length; let parent = -1; let hit = null;
  for (const k of keys) {
    hit = null;
    const re = keyRe(k);
    let childIndent = null;
    for (let i = from; i < to; i++) {
      if (blank(lines[i])) continue;
      const ind = indentOf(lines[i]);
      if (ind <= parent) break;
      if (childIndent === null) childIndent = ind;
      if (ind !== childIndent) continue;
      if (re.test(lines[i])) { hit = { line: i, indent: ind }; break; }
    }
    if (!hit) return null;
    let end = hit.line + 1;
    while (end < to && (blank(lines[end]) || indentOf(lines[end]) > hit.indent)) end++;
    // trailing blank/comment lines belong to the next key
    while (end > hit.line + 1 && blank(lines[end - 1])) end--;
    hit.end = end;
    from = hit.line + 1; to = end; parent = hit.indent;
  }
  return hit;
}

/** YAML scalar: numbers and booleans as they are, everything else double-quoted (JSON strings are valid YAML). */
function yamlScalar(v) {
  if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return String(v);
  return JSON.stringify(String(v));
}
function yamlUnquote(s) {
  const t = String(s || '').replace(/\s+#.*$/, '').trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) { try { return JSON.parse(t); } catch { return t.slice(1, -1); } }
  if (/^'(?:[^']|'')*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if (t === 'true' || t === 'false') return t === 'true';
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

function yamlGet(text, keys) {
  const lines = String(text || '').split(/\r?\n/);
  const hit = yamlFind(lines, keys);
  if (!hit) return undefined;
  const m = lines[hit.line].match(/:\s*(.*)$/);
  return m && m[1].trim() !== '' ? yamlUnquote(m[1]) : undefined;
}

/** Set a scalar at a key path – creates missing parents. Keeps comments, order and line endings. */
function yamlSet(text, keys, value) {
  const src = String(text || '');
  const nl = /\r\n/.test(src) ? '\r\n' : '\n';
  const lines = src === '' ? [] : src.replace(/(\r?\n)+$/, '').split(/\r?\n/);
  const hit = yamlFind(lines, keys);
  if (hit) {
    lines[hit.line] = lines[hit.line].replace(/:(\s.*)?$/, `: ${yamlScalar(value)}`);
    return lines.join(nl) + nl;
  }
  // Deepest existing parent
  let depth = keys.length - 1; let parent = null;
  while (depth > 0 && !(parent = yamlFind(lines, keys.slice(0, depth)))) depth--;
  const base = parent ? parent.indent + 2 : 0;
  let childIndent = base;
  if (parent) for (let i = parent.line + 1; i < parent.end; i++) if (!blank(lines[i])) { childIndent = indentOf(lines[i]); break; }
  const add = [];
  keys.slice(depth).forEach((k, i) => {
    const pad = ' '.repeat(childIndent + i * 2);
    add.push(i === keys.length - depth - 1 ? `${pad}${k}: ${yamlScalar(value)}` : `${pad}${k}:`);
  });
  const at = parent ? parent.end : lines.length;
  // a parent written as "key: {}" or "key: value" cannot take children – turn it into a block
  if (parent) lines[parent.line] = lines[parent.line].replace(/:\s*(\{\}|\[\]|null|~)?\s*$/, ':');
  lines.splice(at, 0, ...add);
  return lines.join(nl) + nl;
}

/* ---------------- Paper / Spigot behind a proxy ---------------- */

/** Paper (paper-global.yml): Velocity modern forwarding with the secret, or BungeeCord legacy forwarding. */
function paperProxyText(text, { kind, secret }) {
  let t = String(text || '');
  if (kind === 'velocity') {
    t = yamlSet(t, ['proxies', 'velocity', 'enabled'], true);
    t = yamlSet(t, ['proxies', 'velocity', 'online-mode'], true);
    t = yamlSet(t, ['proxies', 'velocity', 'secret'], String(secret || ''));
  } else {
    if (yamlGet(t, ['proxies', 'velocity', 'enabled']) === true) t = yamlSet(t, ['proxies', 'velocity', 'enabled'], false);
    t = yamlSet(t, ['proxies', 'bungee-cord', 'online-mode'], true);
  }
  return t;
}
/** spigot.yml: settings.bungeecord (BungeeCord's IP forwarding). */
function spigotBungeeText(text, on) { return yamlSet(String(text || ''), ['settings', 'bungeecord'], !!on); }

/* ---------------- Velocity (top level of velocity.toml) ---------------- */

const tomlStr = (s) => JSON.stringify(String(s));
function tomlTopSet(toml, key, value) {
  const src = String(toml || '');
  const line = `${key} = ${typeof value === 'string' ? tomlStr(value) : String(value)}`;
  const firstSection = src.search(/^\[[^\]\n]+\]\s*$/m);
  const head = firstSection < 0 ? src : src.slice(0, firstSection);
  const rest = firstSection < 0 ? '' : src.slice(firstSection);
  const re = new RegExp(`^\\s*${key.replace(/[-]/g, '\\-')}\\s*=.*$`, 'm');
  if (re.test(head)) return head.replace(re, line) + rest;
  return `${head.replace(/\n*$/, '\n')}${line}\n${rest ? `\n${rest}` : ''}`;
}
function tomlTopGet(toml, key) {
  const src = String(toml || '');
  const firstSection = src.search(/^\[[^\]\n]+\]\s*$/m);
  const head = firstSection < 0 ? src : src.slice(0, firstSection);
  const m = head.match(new RegExp(`^\\s*${key.replace(/[-]/g, '\\-')}\\s*=\\s*(.*)$`, 'm'));
  if (!m) return undefined;
  const v = m[1].replace(/\s+#.*$/, '').trim();
  if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}
/** Plain text (two lines) → MiniMessage for Velocity; tags the person typed (<green>) stay. */
function velocityMotd(line1, line2) {
  const clean = (s) => String(s || '').replace(/[\r\n]/g, ' ').slice(0, 120);
  return clean(line2) ? `${clean(line1)}\n${clean(line2)}` : clean(line1);
}
const PING = ['DISABLED', 'MODS', 'DESCRIPTION', 'ALL'];
/** Settings Hostwerk owns at the top of velocity.toml. */
function velocityTopText(toml, o = {}) {
  let t = String(toml || '');
  t = tomlTopSet(t, 'online-mode', true); // the proxy checks accounts – the servers behind it cannot
  t = tomlTopSet(t, 'player-info-forwarding-mode', 'modern');
  if (o.motd !== undefined) t = tomlTopSet(t, 'motd', o.motd);
  if (o.showMaxPlayers !== undefined) t = tomlTopSet(t, 'show-max-players', Math.max(0, Math.min(100000, Math.round(Number(o.showMaxPlayers) || 0))));
  if (o.pingPassthrough !== undefined) t = tomlTopSet(t, 'ping-passthrough', PING.includes(o.pingPassthrough) ? o.pingPassthrough : 'DISABLED');
  if (o.kickExisting !== undefined) t = tomlTopSet(t, 'kick-existing-players', !!o.kickExisting);
  if (o.preventProxyConnections !== undefined) t = tomlTopSet(t, 'prevent-client-proxy-connections', !!o.preventProxyConnections);
  return t;
}
/** try = [...] inside [servers] and [forced-hosts] – used for maintenance without a full network rebuild. */
function velocityRouting(toml, { tryKeys, forced }) {
  let t = String(toml || '');
  const sec = t.match(/^\[servers\][^\n]*\n([\s\S]*?)(?=^\[[^\]\n]+\]\s*$|(?![\s\S]))/m);
  if (sec) {
    const body = sec[1];
    const line = `try = [${tryKeys.map((k) => tomlStr(k)).join(', ')}]`;
    const nb = /^\s*try\s*=\s*\[[\s\S]*?\]/m.test(body) ? body.replace(/^\s*try\s*=\s*\[[\s\S]*?\]/m, line) : `${body.replace(/\n*$/, '\n')}${line}\n`;
    t = t.replace(sec[0], `[servers]\n${nb}`);
  }
  const fl = Object.entries(forced || {}).map(([h, k]) => `${tomlStr(h)} = [${[].concat(k).map(tomlStr).join(', ')}]`);
  const block = `[forced-hosts]\n${fl.length ? fl.join('\n') : '# (empty)'}\n\n`;
  const re = /^\[forced-hosts\][^\n]*\n[\s\S]*?(?=^\[[^\]\n]+\]\s*$|(?![\s\S]))/m;
  t = re.test(t) ? t.replace(re, block) : `${t.replace(/\n*$/, '\n\n')}${block}`;
  return t;
}

/* ---------------- BungeeCord (config.yml, owned by Hostwerk) ---------------- */

/**
 * BungeeCord's config.yml is written as a whole – BungeeCord adds any key that is missing on its next start.
 * servers: [{ key, port, motd, restricted }] in try order; forced: { host: key }.
 */
function bungeeConfigText({ port, motd, maxPlayers = 100, servers = [], tryKeys, forced = {}, pingPassthrough = false }) {
  const q = JSON.stringify;
  const prio = (tryKeys || servers.map((s) => s.key));
  const lines = [
    '# Managed by Hostwerk (Minecraft server network) – change it there, manual changes are overwritten.',
    'online_mode: true',
    'ip_forward: true',
    'prevent_proxy_connections: false',
    'log_commands: false',
    ...(servers.length
      ? ['servers:', ...servers.flatMap((s) => [`  ${s.key}:`, `    motd: ${q(String(s.motd || s.key))}`, `    address: ${q(`127.0.0.1:${s.port}`)}`, `    restricted: ${!!s.restricted}`])]
      : ['servers: {}']),
    'listeners:',
    '- query_port: 25577',
    `  motd: ${q(String(motd || 'A Minecraft network'))}`,
    '  tab_list: GLOBAL_PING',
    '  query_enabled: false',
    '  proxy_protocol: false',
    `  forced_hosts:${Object.keys(forced).length ? '' : ' {}'}`,
    ...Object.entries(forced).map(([h, k]) => `    ${q(h)}: ${q([].concat(k)[0])}`),
    '  ping_passthrough: ' + !!pingPassthrough,
    '  priorities:',
    ...prio.map((k) => `  - ${q(k)}`),
    '  bind_local_address: true',
    `  host: ${q(`0.0.0.0:${port}`)}`,
    `  max_players: ${Math.max(1, Math.round(Number(maxPlayers) || 100))}`,
    '  tab_size: 60',
    '  force_default_server: false',
  ];
  return lines.join('\n') + '\n';
}
/** Port of the first listener ("host: 0.0.0.0:25577") – rewritten before every start (Hostwerk owns the port). */
function bungeePortText(text, port) {
  return String(text || '').replace(/^(\s*host:\s*)(["']?)([^"'\n]*?):\d+\2\s*$/m, (m, a, q, h) => `${a}${q || '"'}${h || '0.0.0.0'}:${port}${q || '"'}`);
}

/* ---------------- Geyser ---------------- */

/** Where each setting lives: [new layout (config-version 5+), classic layout (4)] */
const GEYSER_KEYS = {
  port: [['bedrock', 'port'], ['bedrock', 'port']],
  authType: [['java', 'auth-type'], ['remote', 'auth-type']],
  motd1: [['motd', 'primary-motd'], ['bedrock', 'motd1']],
  motd2: [['motd', 'secondary-motd'], ['bedrock', 'motd2']],
  serverName: [['gameplay', 'server-name'], ['bedrock', 'server-name']],
  passthrough: [['motd', 'passthrough-motd'], ['passthrough-motd']],
  passthroughCounts: [['motd', 'passthrough-player-counts'], ['passthrough-player-counts']],
  maxPlayers: [['motd', 'max-players'], ['max-players']],
  showCoordinates: [['gameplay', 'show-coordinates'], ['show-coordinates']],
  xboxAchievements: [['gameplay', 'xbox-achievements-enabled'], ['xbox-achievements-enabled']],
  forceResourcePacks: [['gameplay', 'force-resource-packs'], ['force-resource-packs']],
};
const geyserNewLayout = (text) => /^java:\s*$/m.test(String(text || '')) || Number(yamlGet(text, ['config-version'])) >= 5;

/** A new Geyser config in the classic layout (config-version 4) – Geyser moves it to its current layout at the first start. */
function geyserConfigText(o = {}) {
  const q = (v) => yamlScalar(v);
  return [
    '# Written by Hostwerk (Minecraft server network). Geyser updates this file to its current layout at the first start.',
    'bedrock:',
    '  address: 0.0.0.0',
    `  port: ${Number(o.port) || 19132}`,
    '  clone-remote-port: false',
    `  motd1: ${q(o.motd1 || 'Minecraft')}`,
    `  motd2: ${q(o.motd2 || 'Java + Bedrock')}`,
    `  server-name: ${q(o.serverName || 'Minecraft')}`,
    'remote:',
    '  address: auto',
    `  port: ${Number(o.remotePort) || 25565}`,
    `  auth-type: ${o.authType === 'online' ? 'online' : 'floodgate'}`,
    'floodgate-key-file: key.pem',
    `passthrough-motd: ${o.passthrough !== false}`,
    'passthrough-player-counts: true',
    `max-players: ${Number(o.maxPlayers) || 100}`,
    `show-coordinates: ${o.showCoordinates !== false}`,
    `xbox-achievements-enabled: ${!!o.xboxAchievements}`,
    'config-version: 4',
    '',
  ].join('\n');
}
/** Change Geyser settings in an existing config – in its own layout. Only keys that are given. */
function geyserPatchText(text, o = {}) {
  const nu = geyserNewLayout(text) ? 0 : 1;
  let t = String(text || '');
  for (const [k, paths] of Object.entries(GEYSER_KEYS)) {
    if (o[k] === undefined || o[k] === null) continue;
    let v = o[k];
    if (['motd1', 'motd2'].includes(k)) v = String(v).replace(/[\r\n]/g, ' ').slice(0, 80);
    if (k === 'serverName') v = String(v).replace(/[\r\n]/g, ' ').slice(0, 40);
    if (k === 'authType') v = v === 'online' ? 'online' : 'floodgate';
    if (['port', 'maxPlayers'].includes(k)) v = Math.round(Number(v)) || 0;
    // auth-type is an enum – unquoted like Geyser writes it
    t = k === 'authType' ? yamlSetRaw(t, paths[nu], v) : yamlSet(t, paths[nu], v);
  }
  return t;
}
function yamlSetRaw(text, keys, raw) {
  const t = yamlSet(text, keys, 'X__RAW__X');
  return t.replace('"X__RAW__X"', String(raw));
}
/** Read the settings Hostwerk shows from a Geyser config (either layout). */
function geyserRead(text) {
  const nu = geyserNewLayout(text) ? 0 : 1;
  const out = { layout: nu === 0 ? 'new' : 'classic' };
  for (const [k, paths] of Object.entries(GEYSER_KEYS)) { const v = yamlGet(text, paths[nu]); if (v !== undefined) out[k] = v; }
  return out;
}

/* ---------------- Floodgate ---------------- */

/** Floodgate config: a new file is minimal (Floodgate fills in the rest from its template); existing files keep everything else. */
function floodgateText(text, { prefix, replaceSpaces, proxy, globalLinking } = {}) {
  let t = String(text || '');
  if (!t.trim()) t = `# Written by Hostwerk (Minecraft server network) – Floodgate adds its other settings at the first start.\nkey-file-name: key.pem\nconfig-version: 3\n`;
  if (prefix !== undefined) t = yamlSet(t, ['username-prefix'], String(prefix));
  if (replaceSpaces !== undefined) t = yamlSet(t, ['replace-spaces'], !!replaceSpaces);
  // On a proxy Floodgate must hand the Bedrock data on – otherwise the servers behind it kick Bedrock players
  if (proxy !== undefined) t = yamlSet(t, ['send-floodgate-data'], !!proxy);
  if (globalLinking !== undefined) t = yamlSet(t, ['player-link', 'enable-global-linking'], !!globalLinking);
  return t;
}
/** Bedrock name prefix: only characters Minecraft names cannot have (a letter could collide with a Java name). */
function validPrefix(p) { return typeof p === 'string' && p.length >= 1 && p.length <= 3 && /^[^A-Za-z0-9_\s"'\\]+$/.test(p); }

/* ---------------- Player lists (whitelist.json, ops.json, banned-players.json) ---------------- */

/**
 * Merge the network's list into a server's own list: entries the network added before (managed) and no longer has are
 * removed, the server's own entries stay. → { list, managed }
 */
function mergeList(current, wanted, managed, shape) {
  const cur = Array.isArray(current) ? current : [];
  const want = new Map(wanted.filter((p) => p && p.uuid).map((p) => [p.uuid, p]));
  const prev = new Set(managed || []);
  const kept = cur.filter((e) => e && e.uuid && !(prev.has(e.uuid) && !want.has(e.uuid)) && !want.has(e.uuid));
  const list = [...kept, ...[...want.values()].map(shape)];
  return { list, managed: [...want.keys()] };
}
const shapes = {
  whitelist: (p) => ({ uuid: p.uuid, name: p.name }),
  ops: (p) => ({ uuid: p.uuid, name: p.name, level: 4, bypassesPlayerLimit: false }),
  bans: (p) => ({ uuid: p.uuid, name: p.name, created: p.created || '2026-01-01 00:00:00 +0000', source: 'Hostwerk', expires: 'forever', reason: p.reason || 'Banned by an operator.' }),
};
/** Mojang UUID without dashes → with dashes. */
function dashUuid(id) { const h = String(id || '').replace(/-/g, '').toLowerCase(); return /^[0-9a-f]{32}$/.test(h) ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : null; }
/** Floodgate UUID of a Bedrock player: 00000000-0000-0000-<xuid as 16 hex digits>. */
function floodgateUuid(xuid) {
  const h = BigInt(String(xuid)).toString(16).padStart(16, '0');
  return `00000000-0000-0000-${h.slice(0, 4)}-${h.slice(4)}`;
}

/* ---------------- Names, hosts, ports ---------------- */

const keyName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'server';
function validHost(h) { return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(String(h || '')); }
/** First free port from start (inclusive) that is not in used. */
function pickPort(start, used, isFree = () => true, span = 200) {
  for (let p = start; p < start + span; p++) if (!used.has(p) && isFree(p)) return p;
  return null;
}
/** 64×64 PNG? (Velocity/BungeeCord show server-icon.png only in that size) → { ok, w, h } */
function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return { ok: false };
  const w = buf.readUInt32BE(16); const h = buf.readUInt32BE(20);
  return { ok: w === 64 && h === 64, w, h };
}

module.exports = {
  readProps, writeProps, yamlFind, yamlGet, yamlSet, yamlUnquote, paperProxyText, spigotBungeeText,
  tomlTopSet, tomlTopGet, velocityMotd, velocityTopText, velocityRouting, PING, bungeeConfigText, bungeePortText,
  GEYSER_KEYS, geyserNewLayout, geyserConfigText, geyserPatchText, geyserRead, floodgateText, validPrefix,
  mergeList, shapes, dashUuid, floodgateUuid, keyName, validHost, pickPort, pngSize,
};
