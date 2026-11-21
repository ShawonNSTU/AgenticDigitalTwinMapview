// Serve the PoC over HTTPS so other computers on the network can use it.
//
// Why: the 3D view (Godot web export) only runs in a "secure context": an https:// page, or http://localhost. On the
// server itself http://localhost:3000 works; from another PC http://<server-ip>:3000 is NOT secure and the browser
// refuses to start Godot ("Secure Context - Check web server configuration (use HTTPS)").
//
//   npm run dev:https            development (hot reload)  ->  https://<server-ip>:3443
//   npm run build && npm run start:https                   production
//
// Certificate: HTTPS_CERT and HTTPS_KEY (PEM file paths) if you have a real one; otherwise a self-signed one is made
// once in web/.cert/ for localhost, this machine's name and every LAN address it has. Browsers warn about a
// self-signed certificate the first time: choose "Advanced" -> "Proceed"; the page is then a secure context and the
// 3D view runs. (Or install web/.cert/cert.pem as trusted on the other PCs to avoid the warning.)
// Options: HTTPS_PORT (default 3443), HTTP_PORT (default 3000: plain http too, which redirects other computers to https).
import { createServer as createHttps } from 'node:https';
import { createServer as createHttp } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import path from 'node:path';
import { parse } from 'node:url';
import next from 'next';

const dev = process.argv.includes('--dev');
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 3000;
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const lanIps = () => Object.values(networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);

async function certificate() {
  if (process.env.HTTPS_CERT && process.env.HTTPS_KEY) return { cert: readFileSync(process.env.HTTPS_CERT), key: readFileSync(process.env.HTTPS_KEY) };
  const dir = path.join(root, '.cert');
  const certFile = path.join(dir, 'cert.pem'), keyFile = path.join(dir, 'key.pem'), forFile = path.join(dir, 'names.json');
  const names = ['localhost', hostname(), ...lanIps(), '127.0.0.1'];
  const have = existsSync(forFile) ? JSON.parse(readFileSync(forFile, 'utf8')) : [];
  if (existsSync(certFile) && existsSync(keyFile) && names.every(n => have.includes(n))) return { cert: readFileSync(certFile), key: readFileSync(keyFile) };
  // (re)make it when this machine has a name or address the certificate doesn't cover yet
  const selfsigned = (await import('selfsigned')).default;
  const alt = [...new Set(names)].map(n => (/^\d+\.\d+\.\d+\.\d+$/.test(n) ? { type: 7, ip: n } : { type: 2, value: n }));
  const pems = selfsigned.generate([{ name: 'commonName', value: hostname() }], {
    days: 825, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: alt }],
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(certFile, pems.cert); writeFileSync(keyFile, pems.private, { mode: 0o600 }); writeFileSync(forFile, JSON.stringify([...new Set(names)]));
  console.log(`> Made a self-signed certificate for: ${[...new Set(names)].join(', ')} (web/.cert/cert.pem)`);
  return { cert: pems.cert, key: pems.private };
}

const app = next({ dev, dir: root, hostname: '0.0.0.0', port: HTTPS_PORT });
const handle = app.getRequestHandler();
await app.prepare();
const tls = await certificate();

createHttps(tls, (req, res) => handle(req, res, parse(req.url, true))).listen(HTTPS_PORT, '0.0.0.0', () => {
  console.log(`> HTTPS ready (${dev ? 'development' : 'production'}):`);
  for (const h of ['localhost', ...lanIps()]) console.log(`    https://${h}:${HTTPS_PORT}`);
});

// plain http too: this machine keeps http://localhost:3000; any other computer is sent to https
if (HTTP_PORT) {
  createHttp((req, res) => {
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    if (host === 'localhost' || host === '127.0.0.1') return handle(req, res, parse(req.url, true));
    res.writeHead(308, { Location: `https://${host}:${HTTPS_PORT}${req.url}` }); res.end();
  }).listen(HTTP_PORT, '0.0.0.0', () => console.log(`> HTTP on :${HTTP_PORT} (localhost only; other computers are redirected to https)`))
    .on('error', e => console.log(`> HTTP :${HTTP_PORT} not started (${e.code}); use https://<this-pc>:${HTTPS_PORT}`));
}
