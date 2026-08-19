'use strict';

/**
 * 氨基酸闯关学园 —— 跨端实时同步后端（零依赖，Node 原生 http）
 *
 * 启动：node server/server.js   （或 npm start）
 * 默认监听 0.0.0.0:3000，可用环境变量 PORT / HOST 覆盖。
 *
 * 路由：
 *   GET  /api/health          健康检查
 *   GET  /api/users           全部用户列表
 *   GET  /api/users/:id       单个用户快照
 *   POST /api/sync            提交增量操作（含 opId 幂等去重）
 *   POST /api/rename          绑定/重命名用户（跨端身份绑定）
 *   GET  /api/events          SSE 实时推送（广播数据更新）
 *   其余                       静态文件服务（public/）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const storage = require('./storage');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const PUBLIC_DIR = path.join(__dirname, '..');

// ---------- 工具 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) { // 5MB 上限
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseJSON(data) {
  try {
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

// ---------- SSE 广播中心 ----------
const sseClients = new Set();

function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(msg);
    } catch (e) {
      sseClients.delete(res);
    }
  }
}

// ---------- 静态文件服务 ----------
function serveStatic(req, res, urlPath) {
  // 防目录穿越
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404 Not Found</h1>');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- 路由处理 ----------
async function handleApi(req, res, url) {
  const urlObj = new URL(url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // 健康检查
  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJSON(res, 200, {
      ok: true,
      app: 'amino-acid-game',
      version: storage.getVersion(),
      time: Date.now(),
    });
  }

  // 全部用户列表
  if (pathname === '/api/users' && req.method === 'GET') {
    return sendJSON(res, 200, { version: storage.getVersion(), users: storage.listUsers() });
  }

  // 单个用户
  const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && req.method === 'GET') {
    const id = decodeURIComponent(userMatch[1]);
    const user = storage.getUser(id);
    if (!user) return sendJSON(res, 404, { error: 'user not found' });
    return sendJSON(res, 200, { version: storage.getVersion(), user: storage.snapshot(user) });
  }

  // 增量同步
  if (pathname === '/api/sync' && req.method === 'POST') {
    const body = parseJSON(await readBody(req));
    if (!body || !body.userId) {
      return sendJSON(res, 400, { error: 'missing userId' });
    }
    const user = storage.applyOps(
      body.userId,
      typeof body.name === 'string' ? body.name.slice(0, 40) : '',
      typeof body.deviceId === 'string' ? body.deviceId : '',
      Array.isArray(body.ops) ? body.ops : []
    );
    // 广播给所有在线端
    broadcast('update', { user });
    return sendJSON(res, 200, { version: storage.getVersion(), user });
  }

  // 重命名 / 身份绑定
  if (pathname === '/api/rename' && req.method === 'POST') {
    const body = parseJSON(await readBody(req));
    if (!body || !body.userId || typeof body.name !== 'string') {
      return sendJSON(res, 400, { error: 'missing userId or name' });
    }
    const user = storage.renameUser(body.userId, body.name.slice(0, 40));
    if (!user) return sendJSON(res, 404, { error: 'user not found' });
    broadcast('update', { user });
    return sendJSON(res, 200, { version: storage.getVersion(), user });
  }

  return sendJSON(res, 404, { error: 'not found' });
}

// ---------- 服务器 ----------
const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  // SSE 长连接
  if (url === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    res.write(`event: hello\ndata: ${JSON.stringify({ version: storage.getVersion() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (url.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (e) {
      sendJSON(res, 500, { error: 'internal error', detail: String(e && e.message) });
    }
    return;
  }

  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  🧪 氨基酸闯关学园 · 跨端同步服务已启动');
  console.log('  ─────────────────────────────────────────');
  console.log(`  本机访问   http://localhost:${PORT}`);
  console.log(`  局域网访问 http://<本机IP>:${PORT}`);
  console.log(`  数据文件   ${path.join(__dirname, '..', 'data', 'store.json')}`);
  console.log('');
  console.log('  提示：手机/平板需与电脑在同一局域网，');
  console.log('  并在游戏首页「数据档案 → 身份绑定」输入相同学号即可跨端同步。');
  console.log('');
});
