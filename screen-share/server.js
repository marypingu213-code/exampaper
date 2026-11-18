// 教室畫面同步：老師電腦畫面 → 學生手機（區域網路）
// 用法：node server.js   （預設埠 8080，可用 PORT=xxxx 改）
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
// 學生網路較慢時，緩衝超過這個量就略過該幀（避免延遲越積越多）
const MAX_BUFFERED = 1.5 * 1024 * 1024;

function isLocal(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// 找出本機在區域網路的 IPv4 位址（學生要連的位址）
function lanAddresses() {
  const list = [];
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) list.push({ name, address: i.address });
    }
  }
  const score = (a) =>
    a.address.startsWith('192.168.') ? 0 :
    a.address.startsWith('10.') ? 1 :
    /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 3;
  // 排除常見虛擬網卡
  const virtual = /vEthernet|VirtualBox|VMware|docker|WSL|Hyper-V|utun|tailscale|zerotier/i;
  return list
    .sort((a, b) => (virtual.test(a.name) - virtual.test(b.name)) || (score(a) - score(b)))
    .map((a) => ({ ...a, url: `http://${a.address}:${PORT}/` }));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendFile(res, file) {
  fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const local = isLocal(req.socket.remoteAddress);

  if (url.pathname === '/' || url.pathname === '/view') return sendFile(res, 'view.html');

  // 老師控制台：只允許本機開啟，學生無法搶走控制權
  if (url.pathname === '/host') {
    if (!local) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('老師控制台只能在老師電腦上開啟'); }
    return sendFile(res, 'host.html');
  }

  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ port: PORT, addresses: lanAddresses() }));
  }

  if (url.pathname === '/api/qr.svg') {
    const target = url.searchParams.get('url') || (lanAddresses()[0] || {}).url || `http://localhost:${PORT}/`;
    const svg = await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    return res.end(svg);
  }

  res.writeHead(404); res.end('Not found');
});

// ---- WebSocket：老師送畫面，伺服器轉發給所有學生 ----
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 * 1024 });
let host = null;
const viewers = new Set();
let lastFrame = null;      // 新加入的學生立刻看到最新畫面
let state = { live: false, paused: false };

function broadcastState() {
  const msg = JSON.stringify({ type: 'state', ...state });
  for (const v of viewers) if (v.readyState === 1) v.send(msg);
}
function reportCount() {
  if (host && host.readyState === 1) host.send(JSON.stringify({ type: 'viewers', count: viewers.size }));
}

wss.on('connection', (ws, req) => {
  const role = new URL(req.url, 'http://x').searchParams.get('role');

  if (role === 'host') {
    if (!isLocal(req.socket.remoteAddress)) return ws.close(1008, 'host must be local');
    if (host) host.close(4000, 'replaced');
    host = ws;
    reportCount();

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        lastFrame = data;
        for (const v of viewers) {
          if (v.readyState === 1 && v.bufferedAmount < MAX_BUFFERED) v.send(data, { binary: true });
        }
        return;
      }
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'state') {
          state = { live: !!msg.live, paused: !!msg.paused };
          if (!state.live) lastFrame = null;
          broadcastState();
        }
      } catch { /* ignore */ }
    });
    ws.on('close', () => {
      if (host === ws) {
        host = null;
        state = { live: false, paused: false };
        broadcastState();
      }
    });
    return;
  }

  // 學生
  viewers.add(ws);
  ws.send(JSON.stringify({ type: 'state', ...state }));
  if (lastFrame) ws.send(lastFrame, { binary: true });
  reportCount();
  ws.on('close', () => { viewers.delete(ws); reportCount(); });
});

// 定期 ping，清掉斷線的手機
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);
wss.on('connection', (ws) => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });

server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  console.log('\n=== 教室畫面同步 已啟動 ===');
  console.log(`老師控制台（請在這台電腦開）： http://localhost:${PORT}/host`);
  if (addrs.length) {
    console.log('學生觀看網址（同一個 Wi-Fi）：');
    for (const a of addrs) console.log(`  ${a.url}   (${a.name})`);
  } else {
    console.log('找不到區域網路位址，請確認電腦已連上 Wi-Fi / 網路。');
  }
  console.log('按 Ctrl+C 結束\n');
});
