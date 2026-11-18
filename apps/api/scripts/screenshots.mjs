// Takes the screenshots used in the README, from a local ShopList filled by seed-demo.mjs.
//
//   npm run dev -w @shoplist/api -- --var DEV_AUTH:true --var INSECURE_DEV_COOKIES:true --var SIGNIN_MODE:open
//   node apps/api/scripts/seed-demo.mjs
//   CHROME="/path/to/chrome-or-chrome-headless-shell" node apps/api/scripts/screenshots.mjs
//
// Needs Node 22 (built-in WebSocket) and any Chromium. It signs in with the development sign-in, which exists only locally.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const OUT = new URL('../../../docs/screenshots/', import.meta.url).pathname;
const CHROME = process.env.CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
if (!CHROME) throw new Error('Set CHROME to a Chromium or chrome-headless-shell binary.');
mkdirSync(OUT, { recursive: true });

let n = 0;
const ip = () => `10.9.${(n >> 8) & 255}.${n++ & 255}`;
async function api(method, path, body, cookie) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { origin: BASE, 'cf-connecting-ip': ip(), ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { json: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.match(/((?:__Host-)?sl_session=[^;]+)/)?.[1] };
}
const login = async (email, name, superAdmin) => (await api('POST', '/auth/dev/login', { email, name, ...(superAdmin ? { superAdmin: true } : {}) })).cookie;

const maya = await login('maya.collins@willowpine.example', 'Maya Collins');
const priya = await login('priya.nair@willowpine.example', 'Priya Nair');
const owner = await login('owner@shoplist.example', 'Platform Owner', true);
const org = (await api('GET', '/me', null, maya)).json.organizations.find((o) => o.name.startsWith('Willow')).id;

// ---- a tiny Chrome DevTools client
const port = 9340 + Math.floor(Math.random() * 50);
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/shoplist-shots-${port}`, 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 50 && !target; i++) { await sleep(200); target = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null); }
if (!target) throw new Error('Chrome did not start.');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiting = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; waiting.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Page.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 860, deviceScaleFactor: 1, mobile: false });

async function shot(file, path, cookie, { scrollTo, wait = 1200, height } = {}) {
  await send('Network.clearBrowserCookies');
  if (cookie) { const [name, value] = cookie.split('='); await send('Network.setCookie', { name, value, url: BASE }); }
  if (height) await send('Emulation.setDeviceMetricsOverride', { width: 1360, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + path });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const ready = await evaluate(`document.readyState === 'complete' && !document.querySelector('.boot') && document.body.innerText.length > 150`);
    if (ready) break;
  }
  await sleep(wait);
  if (scrollTo) { await evaluate(`document.querySelector(${JSON.stringify(scrollTo)})?.scrollIntoView({ block: 'start' })`); await sleep(500); }
  const png = (await send('Page.captureScreenshot', { format: 'png' })).result.data;
  writeFileSync(OUT + file, Buffer.from(png, 'base64'));
  if (height) await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 860, deviceScaleFactor: 1, mobile: false });
  console.log('  ', file);
}

console.log(`Saving screenshots to ${OUT}`);
await shot('01-login.png', '/login', null, { height: 760 });
await shot('02-products.png', `/o/${org}/products`, maya);
await shot('03-orders.png', `/o/${org}/orders`, maya);
await shot('04-purchasing.png', `/o/${org}/purchasing`, maya);
await shot('05-approvals.png', `/o/${org}/approvals`, maya);
await shot('06-reports.png', `/o/${org}/reports`, maya);
await shot('07-settings-support.png', `/o/${org}/settings`, maya, { scrollTo: '#h-support' });
await shot('08-staff-sales-view.png', `/o/${org}/orders`, priya);
await shot('09-owner-overview.png', '/admin', owner);
await shot('10-owner-operations.png', '/admin/operations', owner, { height: 1500 });
await shot('11-owner-security.png', '/admin/security', owner);
await shot('12-owner-support.png', '/admin/support', owner, { height: 1100 });

ws.close();
chrome.kill();
console.log('Done.');
process.exit(0);
