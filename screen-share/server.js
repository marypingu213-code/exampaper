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

// ---- WebSocket：老師送畫面，伺服器轉發給所有學生；並處理作答 ----
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 * 1024 });
let host = null;
const viewers = new Set();
let lastFrame = null;      // 新加入的學生立刻看到最新畫面
let state = { live: false, paused: false };

// 作答：question = { id, mode: 'choice' | 'draw', options, open, correct }
let question = null;
let answers = new Map();   // 學生 id → { id, name, choice, drawing, mark }

const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const toViewers = (obj) => { const m = JSON.stringify(obj); for (const v of viewers) if (v.readyState === 1) v.send(m); };

function broadcastState() { toViewers({ type: 'state', ...state }); }

function roster() {
  const map = new Map();
  for (const v of viewers) if (v.clientId) map.set(v.clientId, { id: v.clientId, name: v.name });
  return [...map.values()];
}
function reportCount() { send(host, { type: 'viewers', count: viewers.size, students: roster() }); }

// 給學生的題目資訊（不含正確答案，除非已公布）
function questionFor(id) {
  if (!question) return { type: 'question', question: null };
  const a = answers.get(id);
  return {
    type: 'question',
    question: { id: question.id, mode: question.mode, options: question.options, open: question.open,
                correct: question.revealed ? question.correct : null },
    mine: a ? { choice: a.choice ?? null, hasDrawing: !!a.drawing, mark: a.mark ?? null } : null,
  };
}
function pushQuestionToAll() { for (const v of viewers) if (v.clientId) send(v, questionFor(v.clientId)); }

wss.on('connection', (ws, req) => {
  const role = new URL(req.url, 'http://x').searchParams.get('role');

  if (role === 'host') {
    if (!isLocal(req.socket.remoteAddress)) return ws.close(1008, 'host must be local');
    if (host) host.close(4000, 'replaced');
    host = ws;
    reportCount();
    send(ws, { type: 'question', question });
    for (const a of answers.values()) send(ws, { type: 'answer', answer: a });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        lastFrame = data;
        for (const v of viewers) {
          if (v.readyState === 1 && v.bufferedAmount < MAX_BUFFERED) v.send(data, { binary: true });
        }
        return;
      }
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      switch (msg.type) {
        case 'state':
          state = { live: !!msg.live, paused: !!msg.paused };
          if (!state.live) lastFrame = null;
          broadcastState();
          break;
        case 'ask': {   // 出題
          const mode = msg.mode === 'draw' ? 'draw' : 'choice';
          const n = Math.min(Math.max(Number(msg.options) || 4, 2), 6);
          question = { id: Date.now().toString(36), mode, options: n, open: true, correct: null, revealed: false };
          answers = new Map();
          send(ws, { type: 'question', question });
          pushQuestionToAll();
          break;
        }
        case 'close':   // 收卷
          if (question) { question.open = false; send(ws, { type: 'question', question }); pushQuestionToAll(); }
          break;
        case 'reopen':
          if (question) { question.open = true; send(ws, { type: 'question', question }); pushQuestionToAll(); }
          break;
        case 'reveal':  // 公布選擇題答案
          if (question && question.mode === 'choice') {
            question.correct = Number(msg.correct) || null;
            question.revealed = !!question.correct;
            question.open = false;
            send(ws, { type: 'question', question });
            pushQuestionToAll();
          }
          break;
        case 'mark': {  // 圈選題：老師逐一批改 ✓ / ✗
          const a = answers.get(msg.id);
          if (a) {
            a.mark = msg.mark === true ? true : msg.mark === false ? false : null;
            send(ws, { type: 'answer', answer: a });
            for (const v of viewers) if (v.clientId === a.id) send(v, questionFor(a.id));
          }
          break;
        }
        case 'end':     // 結束作答，學生回到觀看畫面
          question = null; answers = new Map();
          send(ws, { type: 'question', question });
          pushQuestionToAll();
          break;
      }
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
  send(ws, { type: 'state', ...state });
  if (lastFrame) ws.send(lastFrame, { binary: true });
  reportCount();

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'hello') {
      ws.clientId = String(msg.id || '').slice(0, 64) || Math.random().toString(36).slice(2);
      ws.name = String(msg.name || '').trim().slice(0, 20) || '未署名';
      const a = answers.get(ws.clientId);
      if (a && a.name !== ws.name) { a.name = ws.name; send(host, { type: 'answer', answer: a }); }
      reportCount();
      send(ws, questionFor(ws.clientId));
      return;
    }
    if (msg.type === 'answer' && ws.clientId && question && question.open && msg.qid === question.id) {
      const a = { id: ws.clientId, name: ws.name, choice: null, drawing: null, mark: null, at: Date.now() };
      if (question.mode === 'choice') {
        const c = Number(msg.choice);
        if (!(c >= 1 && c <= question.options)) return;
        a.choice = c;
      } else {
        const d = String(msg.drawing || '');
        if (!d.startsWith('data:image/') || d.length > 4_000_000) return;
        a.drawing = d;
      }
      answers.set(ws.clientId, a);
      send(host, { type: 'answer', answer: a });
      send(ws, questionFor(ws.clientId));
    }
  });
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
