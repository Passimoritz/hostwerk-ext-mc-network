'use strict';
/*
 * BungeeCord as a server type in Hostwerk (SDK 3.2: mc.registerType). The alternative proxy to Velocity – for networks with
 * BungeeCord-only plugins. Waterfall is not offered: PaperMC ended it in 2024 (no more updates).
 *
 * Official source: SpigotMC's build server (ci.md-5.net) – the newest successful build, checked with the MD5 checksum
 * Jenkins records for it (Jenkins publishes no SHA-256). Version "latest" + build number, so Hostwerk's server-update
 * check (latestBuild) finds new builds like it does for Velocity.
 * Hidden from the normal "New server" dialog – networks with BungeeCord are created on this extension's page.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./configs');

const JOB = 'https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild';
const API = `${JOB}/api/json?tree=number,fingerprint[fileName,hash]`;
const JAR = `${JOB}/artifact/bootstrap/target/BungeeCord.jar`;

function bungeeType(net) {
  const build = async () => {
    const j = await net.fetchJson(API);
    // Maven job: the artifact is listed as „net.md-5:BungeeCord.jar“
    const fp = ((j && j.fingerprint) || []).find((f) => /(^|:)BungeeCord\.jar$/.test(f.fileName));
    return { number: j && j.number != null ? String(j.number) : null, md5: fp ? fp.hash : null };
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
      if (b.md5) {
        const got = crypto.createHash('md5').update(fs.readFileSync(dest)).digest('hex');
        if (got !== b.md5) { fs.rmSync(dest, { force: true }); throw new Error('BungeeCord download is damaged (MD5 does not match).'); }
      }
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

module.exports = { bungeeType, API, JAR };
