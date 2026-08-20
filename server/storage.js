'use strict';

/**
 * 数据存储层 —— 零依赖，JSON 文件原子持久化
 *
 * 设计目标：保证多端同时操作时的数据一致性。
 * 采用「服务端权威 + 增量操作日志（op-based）+ opId 幂等去重」模型：
 *   1. 前端只提交「增量操作」(ops)，不提交整份覆盖数据，从根本上避免互相覆盖丢失；
 *   2. 每个操作携带全局唯一 opId，服务端对已应用的 opId 去重，保证网络重试 / 离线重放
 *      不会重复累加计数（幂等）；
 *   3. 每次应用操作后，全局 version 单调递增，用于 SSE 广播与客户端判断是否落后。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const TMP_FILE = path.join(DATA_DIR, 'store.json.tmp');

// 错误计数对象的合法 key
const WRONG_KEYS = ['fx', 'su', 'jx', 'zx', 'fqx'];

// 历史正确率最多保留条数
const MAX_HISTORY = 50;

// 每个用户保留的 appliedOps 上限（超出后裁剪最旧的，重放窗口足够大）
const MAX_APPLIED_OPS = 20000;

function emptyUser(id, name) {
  return {
    id,
    name: name || ('同学' + Math.floor(1000 + Math.random() * 9000)),
    deviceIds: [],
    practice: 0,
    pass1: 0,
    pass2: 0,
    correct3: 0,
    click: 0,
    practiceTime: 0,
    bestCorrect: 0,
    totalWrong: 0,
    wrongCount: { fx: 0, su: 0, jx: 0, zx: 0, fqx: 0 },
    historyRate: [],
    appliedOps: {},   // opId -> true
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

let store = null;

function defaultStore() {
  return { version: 0, users: {} };
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function load() {
  if (store) return store;
  ensureDir();
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      store = JSON.parse(raw);
      if (!store || typeof store !== 'object') store = defaultStore();
      if (!store.users || typeof store.users !== 'object') store.users = {};
      if (typeof store.version !== 'number') store.version = 0;
    } else {
      store = defaultStore();
    }
  } catch (e) {
    // 文件损坏时备份并重建，避免启动失败
    try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.corrupt-' + Date.now()); } catch (_) {}
    store = defaultStore();
  }
  return store;
}

// 原子写入：先写临时文件，再 rename，避免写一半导致数据损坏
function persist() {
  ensureDir();
  fs.writeFileSync(TMP_FILE, JSON.stringify(store), 'utf8');
  fs.renameSync(TMP_FILE, DATA_FILE);
}

function getUser(userId) {
  load();
  return store.users[userId] || null;
}

function getOrCreateUser(userId, name) {
  load();
  if (!store.users[userId]) {
    store.users[userId] = emptyUser(userId, name);
  } else if (name && name !== store.users[userId].name && !store.users[userId]._renamed) {
    store.users[userId].name = name;
  }
  return store.users[userId];
}

function addDevice(userId, deviceId) {
  const u = getUser(userId);
  if (u && deviceId) {
    if (!Array.isArray(u.deviceIds)) u.deviceIds = [];
    if (!u.deviceIds.includes(deviceId)) {
      u.deviceIds.push(deviceId);
    }
  }
}

// 记录已应用的 opId，超出上限裁剪最旧的
function markOp(user, opId) {
  user.appliedOps[opId] = true;
  const keys = Object.keys(user.appliedOps);
  if (keys.length > MAX_APPLIED_OPS) {
    const toRemove = keys.slice(0, keys.length - MAX_APPLIED_OPS);
    for (const k of toRemove) delete user.appliedOps[k];
  }
}

// 应用单个增量操作
function applyOp(user, op) {
  const { opId, field, op: opType, value, key } = op;
  const num = typeof value === 'number' && isFinite(value) ? value : 0;

  switch (field) {
    case 'practice':
    case 'pass1':
    case 'pass2':
    case 'correct3':
    case 'click':
    case 'practiceTime':
    case 'totalWrong':
      if (opType === 'inc') user[field] = (user[field] || 0) + num;
      else if (opType === 'set' && num >= 0) user[field] = num; // set 仅用于首拉校正，一般用 inc
      break;
    case 'bestCorrect':
      if (opType === 'max') user.bestCorrect = Math.max(user.bestCorrect || 0, num);
      else if (opType === 'set') user.bestCorrect = Math.max(user.bestCorrect || 0, num);
      break;
    case 'wrongCount':
      if (opType === 'incKey' && WRONG_KEYS.includes(key)) {
        user.wrongCount[key] = (user.wrongCount[key] || 0) + num;
      }
      break;
    case 'historyRate':
      if (opType === 'push' && op.id) {
        if (!Array.isArray(user.historyRate)) user.historyRate = [];
        if (!user.historyRate.some(h => h.id === op.id)) {
          user.historyRate.push({ id: op.id, rate: num, t: Date.now() });
          user.historyRate.sort((a, b) => a.t - b.t);
          if (user.historyRate.length > MAX_HISTORY) {
            user.historyRate = user.historyRate.slice(-MAX_HISTORY);
          }
        }
      }
      break;
    default:
      return false;
  }
  return true;
}

/**
 * 应用一批增量操作，返回应用后的用户快照。
 * @param {string} userId
 * @param {string} name
 * @param {string} deviceId
 * @param {Array}  ops
 */
function applyOps(userId, name, deviceId, ops) {
  load();
  const user = getOrCreateUser(userId, name);
  addDevice(userId, deviceId);

  let applied = 0;
  if (Array.isArray(ops)) {
    for (const op of ops) {
      if (!op || !op.opId) continue;
      if (user.appliedOps[op.opId]) continue; // 幂等去重
      if (applyOp(user, op)) {
        markOp(user, op.opId);
        applied++;
      }
    }
  }

  if (applied > 0) {
    user.updatedAt = Date.now();
    store.version += 1;
  }

  persist();
  return snapshot(user);
}

// 对外返回的干净快照（剥离服务端内部字段）
function snapshot(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    deviceCount: (user.deviceIds || []).length,
    practice: user.practice || 0,
    pass1: user.pass1 || 0,
    pass2: user.pass2 || 0,
    correct3: user.correct3 || 0,
    click: user.click || 0,
    practiceTime: user.practiceTime || 0,
    bestCorrect: user.bestCorrect || 0,
    totalWrong: user.totalWrong || 0,
    wrongCount: { fx: 0, su: 0, jx: 0, zx: 0, fqx: 0, ...(user.wrongCount || {}) },
    historyRate: (user.historyRate || []).map(h => ({ id: h.id, rate: h.rate, t: h.t })),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function listUsers() {
  load();
  return Object.keys(store.users)
    .map(id => snapshot(store.users[id]))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getVersion() {
  load();
  return store.version;
}

// 重命名用户（跨端身份绑定用：不同设备输入相同学号/昵称对应同一 userId）
function renameUser(userId, name) {
  load();
  const user = store.users[userId];
  if (user && name) {
    user.name = name;
    user._renamed = true;
    store.version += 1;
    persist();
  }
  return snapshot(user);
}

module.exports = {
  load,
  getVersion,
  getUser,
  getOrCreateUser,
  applyOps,
  listUsers,
  renameUser,
  snapshot,
};
