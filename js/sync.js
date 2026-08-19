/**
 * 云同步引擎（前端）—— 零依赖
 *
 * 职责：
 *  1. 身份绑定：用户输入学号/昵称 → 生成稳定 userId，多设备输入相同即同步同一份档案；
 *  2. 增量操作：游戏每步变化只提交「增量 op」，不做整份覆盖，避免多端互相覆盖丢失；
 *  3. 离线队列：断网时操作暂存本地，恢复后自动重放（服务端 opId 幂等去重，不重复计数）；
 *  4. 实时推送：SSE 订阅服务端广播，其他设备的更新即时刷新到本端数据档案；
 *  5. 多标签同步：BroadcastChannel 让同浏览器多标签页保持一致；
 *  6. 降级：无后端时自动回退到 localStorage，游戏仍可单机运行。
 */
(function () {
  'use strict';

  var LS = {
    deviceId: 'amino_device_id_v2',
    userId: 'amino_user_id_v2',
    userName: 'amino_user_name_v2',
    localUser: 'amino_local_user_v2',
    pending: 'amino_pending_ops_v2',
  };

  function uid() {
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function jsonGet(key) {
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : null;
    } catch (e) { return null; }
  }
  function jsonSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  function emptyUser(id, name) {
    return {
      id: id,
      name: name || '',
      deviceCount: 1,
      practice: 0, pass1: 0, pass2: 0, correct3: 0, click: 0,
      bestCorrect: 0, totalWrong: 0,
      wrongCount: { fx: 0, su: 0, jx: 0, zx: 0, fqx: 0 },
      historyRate: [],
      updatedAt: Date.now(),
    };
  }

  // 本地镜像应用单个 op（与服务端 storage.applyOp 逻辑保持一致）
  function applyOpLocal(user, op) {
    var num = (typeof op.value === 'number' && isFinite(op.value)) ? op.value : 0;
    switch (op.field) {
      case 'practice': case 'pass1': case 'pass2': case 'correct3': case 'click': case 'totalWrong':
        if (op.op === 'inc') user[op.field] = (user[op.field] || 0) + num;
        break;
      case 'bestCorrect':
        if (op.op === 'max') user.bestCorrect = Math.max(user.bestCorrect || 0, num);
        break;
      case 'wrongCount':
        if (op.op === 'incKey' && op.key) {
          user.wrongCount[op.key] = (user.wrongCount[op.key] || 0) + num;
        }
        break;
      case 'historyRate':
        if (op.op === 'push' && op.id) {
          if (!user.historyRate.some(function (h) { return h.id === op.id; })) {
            user.historyRate.push({ id: op.id, rate: num, t: Date.now() });
            user.historyRate.sort(function (a, b) { return a.t - b.t; });
            if (user.historyRate.length > 50) user.historyRate = user.historyRate.slice(-50);
          }
        }
        break;
    }
  }

  function SyncEngine(opts) {
    opts = opts || {};
    this.serverBase = (opts.serverBase || '').replace(/\/+$/, '');
    this.deviceId = this._getDeviceId();
    this.status = 'init';                 // init | online | offline | syncing
    this.user = null;                     // 本人本地镜像
    this.listeners = { update: [], status: [], remote: [] };
    this._pending = jsonGet(LS.pending) || [];
    this._flushing = false;
    this._flushTimer = null;
    this._es = null;
    this._bc = null;
    this._probePromise = null;
  }

  SyncEngine.prototype._getDeviceId = function () {
    var id = localStorage.getItem(LS.deviceId);
    if (!id) { id = 'dev_' + uid(); localStorage.setItem(LS.deviceId, id); }
    return id;
  };

  SyncEngine.prototype.on = function (evt, fn) {
    (this.listeners[evt] = this.listeners[evt] || []).push(fn);
  };
  SyncEngine.prototype._emit = function (evt, payload) {
    (this.listeners[evt] || []).forEach(function (fn) { try { fn(payload); } catch (e) {} });
  };
  SyncEngine.prototype._setStatus = function (s) {
    if (s !== this.status) { this.status = s; this._emit('status', s); }
  };

  // ---------- 身份 ----------
  SyncEngine.prototype.getUserId = function () {
    return localStorage.getItem(LS.userId) || '';
  };
  SyncEngine.prototype.getUserName = function () {
    return localStorage.getItem(LS.userName) || '';
  };
  SyncEngine.prototype.isBound = function () {
    return !!localStorage.getItem(LS.userName);
  };

  // 由昵称/学号生成稳定 userId（多设备输入相同 → 同一 userId）
  // 注意：保留可读中文，仅在 URL 传参时用 encodeURIComponent 编码
  SyncEngine.prototype.userIdFromName = function (name) {
    return 'stu_' + String(name).trim();
  };

  // 身份绑定 / 切换
  SyncEngine.prototype.bind = function (name) {
    name = String(name || '').trim().slice(0, 40);
    if (!name) return;
    var newId = this.userIdFromName(name);
    var oldId = this.getUserId();

    // 先尽力把旧身份的离线队列刷掉
    if (oldId && oldId !== newId && this._pending.length) {
      this.flush();
    }

    localStorage.setItem(LS.userId, newId);
    localStorage.setItem(LS.userName, name);
    // 切换身份后丢弃旧 pending（属于旧 userId）
    if (oldId !== newId) { this._pending = []; jsonSet(LS.pending, []); }

    this.user = null;
    return this._loadUser();
  };

  SyncEngine.prototype.rename = function (name) {
    var that = this;
    var userId = this.getUserId();
    if (!userId) return Promise.resolve(null);
    return fetch(this.serverBase + '/api/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userId, name: name }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.user) { that.user = d.user; that._saveLocalUser(d.user); localStorage.setItem(LS.userName, name); that._emit('update', { user: d.user }); }
      return d.user;
    }).catch(function () { return null; });
  };

  // ---------- 本地镜像 ----------
  SyncEngine.prototype._saveLocalUser = function (u) { jsonSet(LS.localUser, u); };
  SyncEngine.prototype._loadLocalUser = function () { return jsonGet(LS.localUser); };

  SyncEngine.prototype.getUser = function () {
    return this.user || this._loadLocalUser() || null;
  };

  SyncEngine.prototype.ensureUser = function () {
    if (this.user) return Promise.resolve(this.user);
    return this._loadUser();
  };

  SyncEngine.prototype._loadUser = function () {
    var that = this;
    var userId = this.getUserId();
    var name = this.getUserName();

    // 无身份：使用设备 ID 作为本地用户（等价旧版「每设备独立」）
    if (!userId) {
      var id = this.deviceId;
      localStorage.setItem(LS.userId, id);
      this.user = emptyUser(id, '同学');
      this._saveLocalUser(this.user);
      this._setStatus('offline');
      return Promise.resolve(this.user);
    }

    if (this.status !== 'online') {
      // 离线：用本地缓存
      var cached = this._loadLocalUser();
      if (cached && cached.id === userId) {
        this.user = cached;
        return Promise.resolve(cached);
      }
      this.user = emptyUser(userId, name);
      this._saveLocalUser(this.user);
      return Promise.resolve(this.user);
    }

    // 在线：从服务器拉取
    return fetch(this.serverBase + '/api/users/' + encodeURIComponent(userId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.user) {
          that.user = d.user;
          that._saveLocalUser(d.user);
        } else {
          that.user = emptyUser(userId, name);
          that._saveLocalUser(that.user);
        }
        return that.user;
      })
      .catch(function () { return that.user || that._loadLocalUser() || emptyUser(userId, name); });
  };

  // ---------- 增量操作 ----------
  // track 是游戏层唯一需要调用的「记录一次操作」入口
  SyncEngine.prototype.track = function (op) {
    if (!op || !op.field) return;
    var full = {
      opId: uid(),
      field: op.field,
      op: op.op || 'inc',
      value: op.value,
      key: op.key,
    };
    if (op.field === 'historyRate') full.id = op.id || full.opId;
    // 1) 本地乐观更新（立即反映到界面）
    if (!this.user) {
      this.user = this._loadLocalUser() || emptyUser(this.getUserId() || this.deviceId, this.getUserName());
    }
    applyOpLocal(this.user, full);
    this.user.updatedAt = Date.now();
    this._saveLocalUser(this.user);

    // 2) 入离线队列
    this._pending.push(full);
    jsonSet(LS.pending, this._pending);

    // 3) 广播给同浏览器其他标签页
    this._bcPost({ type: 'local-update', userId: this.user.id });

    // 4) 触发界面刷新
    this._emit('update', { user: this.user, local: true });

    // 5) 尝试同步到服务器
    this.flush();
  };

  SyncEngine.prototype._loadPending = function () { return jsonGet(LS.pending) || []; };

  SyncEngine.prototype.flush = function () {
    var that = this;
    if (this.status !== 'online' || this._flushing || this._pending.length === 0) return;
    this._flushing = true;
    this._setStatus('syncing');

    var batch = this._pending.splice(0, this._pending.length);
    var userId = this.getUserId();

    fetch(this.serverBase + '/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: userId,
        name: this.getUserName(),
        deviceId: this.deviceId,
        ops: batch,
      }),
    }).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('http ' + r.status)); })
      .then(function (d) {
        if (d.user) {
          that.user = d.user;
          that._saveLocalUser(d.user);
          that._emit('update', { user: d.user, remote: true });
        }
        that._setStatus('online');
      })
      .catch(function () {
        // 失败：放回队列，稍后重试
        that._pending = batch.concat(that._pending);
        jsonSet(LS.pending, that._pending);
        that._setStatus('offline');
        that._scheduleProbe();
      })
      .then(function () {
        that._flushing = false;
        if (that._pending.length) that._scheduleFlush();
      });
  };

  SyncEngine.prototype._scheduleFlush = function () {
    var that = this;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(function () { that.flush(); }, 1500);
  };

  // ---------- 服务器探测 & 在线状态 ----------
  SyncEngine.prototype.probe = function () {
    var that = this;
    if (this._probePromise) return this._probePromise;
    this._probePromise = fetch(this.serverBase + '/api/health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('http ' + r.status)); })
      .then(function (d) {
        that._setStatus('online');
        that._openSSE();
        return d;
      })
      .catch(function () {
        that._setStatus('offline');
        return null;
      })
      .then(function (d) {
        that._probePromise = null;
        return d;
      });
    return this._probePromise;
  };

  SyncEngine.prototype._scheduleProbe = function () {
    var that = this;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(function () {
      that._probePromise = null;
      that.probe().then(function (ok) { if (ok && that._pending.length) that.flush(); });
    }, 5000);
  };

  // ---------- SSE 实时推送 ----------
  SyncEngine.prototype._openSSE = function () {
    var that = this;
    if (this._es || typeof EventSource === 'undefined') return;
    try {
      this._es = new EventSource(this.serverBase + '/api/events');
      this._es.addEventListener('update', function (e) {
        try {
          var d = JSON.parse(e.data);
          if (d && d.user) {
            if (d.user.id === that.getUserId()) {
              that.user = d.user;
              that._saveLocalUser(d.user);
            }
            that._emit('remote', { user: d.user });
            that._emit('update', { user: d.user, remote: true });
          }
        } catch (err) {}
      });
      this._es.onerror = function () {
        that._setStatus('offline');
        if (that._es) { that._es.close(); that._es = null; }
        that._scheduleProbe();
      };
    } catch (e) {}
  };

  // ---------- BroadcastChannel 多标签同步 ----------
  SyncEngine.prototype._openBC = function () {
    var that = this;
    if (this._bc || typeof BroadcastChannel === 'undefined') return;
    try {
      this._bc = new BroadcastChannel('amino_game_sync');
      this._bc.onmessage = function (e) {
        var d = e.data || {};
        if (d.type === 'local-update' && d.userId === that.getUserId()) {
          // 别的标签页更新了本人数据，重新拉取
          if (that.status === 'online') {
            that._loadUser().then(function (u) { that._emit('update', { user: u, remote: true }); });
          } else {
            var c = that._loadLocalUser();
            if (c) { that.user = c; that._emit('update', { user: c, local: true }); }
          }
        }
      };
    } catch (e) {}
  };
  SyncEngine.prototype._bcPost = function (msg) {
    if (this._bc) { try { this._bc.postMessage(msg); } catch (e) {} }
  };

  // ---------- 教师后台：全量用户 ----------
  SyncEngine.prototype.getAllUsers = function (cb) {
    if (this.status !== 'online') {
      // 离线：返回本地缓存的本人
      var u = this.getUser();
      cb([u].filter(Boolean));
      return;
    }
    fetch(this.serverBase + '/api/users')
      .then(function (r) { return r.json(); })
      .then(function (d) { cb(d.users || []); })
      .catch(function () { cb([this.getUser()].filter(Boolean)); }.bind(this));
  };

  // ---------- 初始化 ----------
  SyncEngine.prototype.init = function () {
    var that = this;
    this._openBC();
    this._loadUser();
    // 启动时探测服务器（失败则降级离线）
    this.probe().then(function () {
      if (that.status === 'online') {
        that._loadUser().then(function (u) { that._emit('update', { user: u, remote: true }); });
        if (that._pending.length) that.flush();
      }
    });
    return this;
  };

  window.SyncEngine = SyncEngine;
})();
