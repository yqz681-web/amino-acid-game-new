/**
 * Supabase 云同步引擎（前端）
 *
 * 与 sync.js 的 SyncEngine 接口完全一致（track / bind / getUser / getAllUsers / on / init），
 * 因此 index.html 无需改动即可切换后端。区别仅在于传输层：
 *   - 提交增量操作：调用 Supabase RPC 函数 sync_ops（原子累加 + opId 幂等去重）
 *   - 实时推送：订阅 Supabase Realtime 的 postgres_changes
 *   - 无后端/未配置时：自动降级 localStorage 本地模式
 *
 * 前置：需在页面中先引入 supabase-js（CDN），并配置 window.AMINO_SUPABASE = { url, anonKey }。
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
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function jsonSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  function emptyUser(id, name) {
    return {
      id: id, name: name || '',
      deviceCount: 1,
      practice: 0, pass1: 0, pass2: 0, correct3: 0, click: 0,
      bestCorrect: 0, totalWrong: 0,
      wrongCount: { fx: 0, su: 0, jx: 0, zx: 0, fqx: 0 },
      historyRate: [], updatedAt: Date.now(),
    };
  }

  // Supabase 行（snake_case）→ 前端镜像（camelCase），与 SyncEngine.snapshot 结构一致
  function rowToMirror(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name || '同学',
      deviceCount: (row.device_ids || []).length || 1,
      practice: row.practice || 0,
      pass1: row.pass1 || 0,
      pass2: row.pass2 || 0,
      correct3: row.correct3 || 0,
      click: row.click || 0,
      bestCorrect: row.best_correct || 0,
      totalWrong: row.total_wrong || 0,
      wrongCount: {
        fx: row.wrong_fx || 0, su: row.wrong_su || 0, jx: row.wrong_jx || 0,
        zx: row.wrong_zx || 0, fqx: row.wrong_fqx || 0,
      },
      historyRate: (row.history_rate || []).map(function (h) { return { id: h.id, rate: h.rate, t: h.t }; }),
      updatedAt: row.updated_at || Date.now(),
      createdAt: row.created_at || 0,
    };
  }

  // 本地镜像应用单个 op（与 sync.js 保持一致）
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
        if (op.op === 'incKey' && op.key) user.wrongCount[op.key] = (user.wrongCount[op.key] || 0) + num;
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

  function SupabaseSyncEngine(config) {
    config = config || {};
    this.config = config;
    this.deviceId = this._getDeviceId();
    this.status = 'init';
    this.user = null;
    this.listeners = { update: [], status: [], remote: [] };
    this._pending = jsonGet(LS.pending) || [];
    this._flushing = false;
    this._flushTimer = null;
    this._channel = null;
    this._sb = null;
  }

  SupabaseSyncEngine.prototype._getDeviceId = function () {
    var id = localStorage.getItem(LS.deviceId);
    if (!id) { id = 'dev_' + uid(); localStorage.setItem(LS.deviceId, id); }
    return id;
  };
  SupabaseSyncEngine.prototype.on = function (evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn); };
  SupabaseSyncEngine.prototype._emit = function (evt, payload) { (this.listeners[evt] || []).forEach(function (fn) { try { fn(payload); } catch (e) {} }); };
  SupabaseSyncEngine.prototype._setStatus = function (s) { if (s !== this.status) { this.status = s; this._emit('status', s); } };

  SupabaseSyncEngine.prototype.getUserId = function () { return localStorage.getItem(LS.userId) || ''; };
  SupabaseSyncEngine.prototype.getUserName = function () { return localStorage.getItem(LS.userName) || ''; };
  SupabaseSyncEngine.prototype.isBound = function () { return !!localStorage.getItem(LS.userName); };
  SupabaseSyncEngine.prototype.userIdFromName = function (name) { return 'stu_' + String(name).trim(); };

  SupabaseSyncEngine.prototype._available = function () {
    return !!(this.config.url && this.config.anonKey && window.supabase && window.supabase.createClient);
  };

  SupabaseSyncEngine.prototype.init = function () {
    var that = this;
    if (!this._available()) {
      this._setStatus('offline');
      this._ensureLocalUser();
      return this;
    }
    try {
      this._sb = window.supabase.createClient(this.config.url, this.config.anonKey);
      this._setStatus('online');
      this._subscribeRealtime();
    } catch (e) {
      this._setStatus('offline');
      this._ensureLocalUser();
      return this;
    }
    // 启动后拉取本人数据 + 重放离线队列
    this.ensureUser().then(function (u) {
      that._emit('update', { user: u, remote: true });
      if (that._pending.length) that.flush();
    });
    return this;
  };

  // 离线本地用户
  SupabaseSyncEngine.prototype._ensureLocalUser = function () {
    var userId = this.getUserId();
    if (!userId) { userId = this.deviceId; localStorage.setItem(LS.userId, userId); }
    var cached = jsonGet(LS.localUser);
    if (cached && cached.id === userId) { this.user = cached; }
    else { this.user = emptyUser(userId, this.getUserName()); this._saveLocalUser(); }
    return this.user;
  };

  SupabaseSyncEngine.prototype._saveLocalUser = function () { jsonSet(LS.localUser, this.user); };

  SupabaseSyncEngine.prototype.getUser = function () { return this.user || jsonGet(LS.localUser) || null; };

  SupabaseSyncEngine.prototype.ensureUser = function () {
    var that = this;
    if (!this._available()) return Promise.resolve(this._ensureLocalUser());
    var userId = this.getUserId();
    if (!userId) {
      userId = this.deviceId;
      localStorage.setItem(LS.userId, userId);
      this.user = emptyUser(userId, this.getUserName());
      this._saveLocalUser();
      return Promise.resolve(this.user);
    }
    return this._sb.from('learning_records').select('*').eq('id', userId).maybeSingle()
      .then(function (res) {
        if (res.error) throw res.error;
        that.user = res.data ? rowToMirror(res.data) : emptyUser(userId, that.getUserName());
        that._saveLocalUser();
        return that.user;
      })
      .catch(function () { return that.user || jsonGet(LS.localUser) || emptyUser(userId, that.getUserName()); });
  };

  // 身份绑定
  SupabaseSyncEngine.prototype.bind = function (name) {
    var that = this;
    name = String(name || '').trim().slice(0, 40);
    if (!name) return Promise.resolve(null);
    var newId = this.userIdFromName(name);
    var oldId = this.getUserId();
    if (oldId && oldId !== newId && this._pending.length) this.flush();
    localStorage.setItem(LS.userId, newId);
    localStorage.setItem(LS.userName, name);
    if (oldId !== newId) { this._pending = []; jsonSet(LS.pending, []); }
    this.user = null;
    return this.ensureUser().then(function (u) { that._emit('update', { user: u }); return u; });
  };

  SupabaseSyncEngine.prototype.rename = function (name) {
    var that = this;
    var userId = this.getUserId();
    if (!this._available() || !userId) return Promise.resolve(null);
    return this._sb.rpc('rename_user', { p_id: userId, p_name: name })
      .then(function (res) {
        if (!res.error && res.data) {
          that.user = rowToMirror(res.data);
          that._saveLocalUser();
          localStorage.setItem(LS.userName, name);
          that._emit('update', { user: that.user });
        }
        return that.user;
      })
      .catch(function () { return null; });
  };

  // 增量操作入口
  SupabaseSyncEngine.prototype.track = function (op) {
    if (!op || !op.field) return;
    var full = { opId: uid(), field: op.field, op: op.op || 'inc', value: op.value, key: op.key };
    if (op.field === 'historyRate') full.id = op.id || full.opId;

    if (!this.user) this.user = this.getUser() || emptyUser(this.getUserId() || this.deviceId, this.getUserName());
    applyOpLocal(this.user, full);
    this.user.updatedAt = Date.now();
    this._saveLocalUser();

    this._pending.push(full);
    jsonSet(LS.pending, this._pending);
    this._emit('update', { user: this.user, local: true });

    this.flush();
  };

  SupabaseSyncEngine.prototype.flush = function () {
    var that = this;
    if (!this._available() || this._flushing || this._pending.length === 0) return;
    this._flushing = true;
    this._setStatus('syncing');

    var batch = this._pending.splice(0, this._pending.length);
    var userId = this.getUserId();

    this._sb.rpc('sync_ops', {
      p_id: userId,
      p_name: this.getUserName(),
      p_device: this.deviceId,
      p_ops: batch,
    }).then(function (res) {
      if (res.error) throw res.error;
      if (res.data) {
        that.user = rowToMirror(res.data);
        that._saveLocalUser();
        that._emit('update', { user: that.user, remote: true });
      }
      that._setStatus('online');
    }).catch(function () {
      that._pending = batch.concat(that._pending);
      jsonSet(LS.pending, that._pending);
      that._setStatus('offline');
      that._scheduleFlush();
    }).then(function () {
      that._flushing = false;
      if (that._pending.length) that._scheduleFlush();
    });
  };

  SupabaseSyncEngine.prototype._scheduleFlush = function () {
    var that = this;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(function () { that.flush(); }, 2000);
  };

  // Realtime 订阅：其他设备的数据变更即时推送
  SupabaseSyncEngine.prototype._subscribeRealtime = function () {
    var that = this;
    if (!this._sb || this._channel) return;
    try {
      this._channel = this._sb.channel('amino-realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'learning_records' }, function (payload) {
          var row = payload.new;
          if (!row) return;
          var mirror = rowToMirror(row);
          if (row.id === that.getUserId()) {
            that.user = mirror;
            that._saveLocalUser();
          }
          that._emit('remote', { user: mirror });
          that._emit('update', { user: mirror, remote: true });
        })
        .subscribe();
    } catch (e) {}
  };

  // 教师后台：全部用户
  SupabaseSyncEngine.prototype.getAllUsers = function (cb) {
    var that = this;
    if (!this._available()) { cb([this.getUser()].filter(Boolean)); return; }
    this._sb.from('learning_records').select('*')
      .then(function (res) {
        var rows = res.data || [];
        cb(rows.map(rowToMirror).filter(Boolean));
      })
      .catch(function () { cb([that.getUser()].filter(Boolean)); });
  };

  window.SupabaseSyncEngine = SupabaseSyncEngine;
})();
