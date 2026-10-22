'use strict';
/*
 * BungeeCord as a server type in Hostwerk (SDK 3.2: mc.registerType). The alternative proxy to Velocity – for networks with
 * BungeeCord-only plugins. Waterfall is not offered: PaperMC ended it in 2024 (no more updates).
 *
 * Official source: SpigotMC's build server (ci.md-5.net) – the newest successful build, checked with the MD5 Jenkins
 * computes for the archived file itself (its "*fingerprint*" page; Jenkins publishes no SHA-256). Not the fingerprint list
 * of the build: its entry "BungeeCord.jar" belongs to another file of the same name and never matched (found with the
 * real download). Version "latest" + build number, so Hostwerk's server-update check (latestBuild) finds new builds.
 * Hidden from the normal "New server" dialog – networks with BungeeCord are created on this extension's page.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./configs');

const JOB = 'https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild';
const API = `${JOB}/api/json?tree=number`;
const JAR = `${JOB}/artifact/bootstrap/target/BungeeCord.jar`;
const FINGERPRINT = `${JAR}/*fingerprint*/`;
/** MD5 from Jenkins' fingerprint page of the archived file ("The fingerprint <md5> …" / link to /fingerprint/<md5>/). */
function md5FromPage(html) {
  const m = String(html || '').match(/fingerprint\/([0-9a-f]{32})\b|The fingerprint ([0-9a-f]{32})|tooltip="([0-9a-f]{32})"/i);
  return m ? (m[1] || m[2] || m[3]).toLowerCase() : null;
}

function bungeeType(net) {
  const build = async () => {
    const j = await net.fetchJson(API);
    let md5 = null;
    try { if (typeof net.fetchText === 'function') md5 = md5FromPage(await net.fetchText(FINGERPRINT)); } catch { /* checked below */ }
    return { number: j && j.number != null ? String(j.number) : null, md5 };
  };
  return {
    label: 'BungeeCord',
    homepage: 'https://www.spigotmc.org/wiki/bungeecord/',
    description: 'Proxy for a network (alternative to Velocity).',
    proxy: true,
    hidden: true,
    plugins: true,
    loaders: ['bungeecord', 'waterfall'],
    java: () => 21,
    readyRe: /Listening on \//,
    async versions() { return { latest: 'latest', versions: [{ id: 'latest', stable: true }] }; },
    async latestBuild() { return (await build()).number; },
    async download(version, dest, job) {
      const b = await build();
      if (job) job.log(`BungeeCord #${b.number || '?'}`);
      await net.downloadFile(JAR, dest, {});
      const data = fs.readFileSync(dest);
      const got = crypto.createHash('md5').update(data).digest('hex');
      if ((b.md5 && got !== b.md5) || data.slice(0, 2).toString() !== 'PK') { fs.rmSync(dest, { force: true }); throw new Error('BungeeCord download is damaged (MD5 does not match).'); }
      if (!b.md5 && job) job.log('BungeeCord: Jenkins named no MD5 this time – the file is a complete JAR (checked).');
      return { build: b.number };
    },
    launchArgs: (s, jar) => ['-jar', jar],
    /** Hostwerk owns the port – written into BungeeCord's config.yml before every start. */
    beforeStart: (s, dir) => {
      const f = path.join(dir, 'config.yml');
      if (fs.existsSync(f)) fs.writeFileSync(f, C.bungeePortText(fs.readFileSync(f, 'utf8'), s.port));
      else fs.writeFileSync(f, C.bungeeConfigText({ port: s.port, servers: [] }));
    },
  };
}

module.exports = { bungeeType, md5FromPage, API, JAR, FINGERPRINT };
