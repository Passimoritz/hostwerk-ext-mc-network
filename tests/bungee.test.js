'use strict';
/*
 * BungeeCord download check: the MD5 comes from Jenkins' fingerprint page of the archived file (the build's fingerprint
 * list names another "BungeeCord.jar" – the real download never matched it). Download double, no network.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { bungeeType, md5FromPage, FINGERPRINT } = require('../server/bungee');

const JAR = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('bungee')]);
const MD5 = crypto.createHash('md5').update(JAR).digest('hex');
const page = (h) => `<a tooltip="${h}" href="/jenkins/">${h}</a><h1>No matching record found</h1><p>The fingerprint ${h} did not match</p>`;

function net(o = {}) {
  return {
    fetchJson: async () => ({ number: 2104, fingerprint: [{ fileName: 'net.md-5:BungeeCord.jar', hash: 'f'.repeat(32) }] }),
    fetchText: async (url) => { assert.strictEqual(url, FINGERPRINT); if (o.pageFails) throw new Error('403'); return page(o.md5 || MD5); },
    downloadFile: async (url, dest) => { fs.writeFileSync(dest, o.body || JAR); },
  };
}

test('MD5 from Jenkins’ fingerprint page of the archived file', () => {
  assert.strictEqual(md5FromPage(page('85CC03AC02AB95647F52CBAB7977308E')), '85cc03ac02ab95647f52cbab7977308e');
  assert.strictEqual(md5FromPage('<html>nothing</html>'), null);
});

test('download: matching MD5 passes (the build list’s other "BungeeCord.jar" is ignored), damaged file is removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-bungee-'));
  const dest = path.join(dir, 'server.jar');
  const r = await bungeeType(net()).download('latest', dest, null);
  assert.strictEqual(r.build, '2104');
  assert.ok(fs.existsSync(dest));
  await assert.rejects(() => bungeeType(net({ md5: '0'.repeat(32) })).download('latest', dest, null), /damaged/);
  assert.ok(!fs.existsSync(dest), 'damaged download removed');
  // page not reachable: a complete JAR is still accepted, an HTML error page is not
  const lines = [];
  await bungeeType(net({ pageFails: true })).download('latest', dest, { log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => /no MD5/.test(l)));
  await assert.rejects(() => bungeeType(net({ pageFails: true, body: '<html>Cloudflare</html>' })).download('latest', dest, null), /damaged/);
});
