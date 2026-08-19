# 🧪 氨基酸分类·闯关学园（跨端实时同步版）

一个面向生物化学学习的网页小游戏，包含三关闯关玩法与一个**数据档案**模块，支持**手机、平板、电脑多端学习数据实时同步**——同一学员在不同设备上登录相同学号，学习进度、通关记录与统计信息会即时同步到网页端数据档案。

> 原版为纯前端单机游戏（数据仅存于本机 `localStorage`，设备间无法互通）。本版新增轻量级 Node 后端，实现真正的跨端数据同步与实时刷新。

---

## ✨ 功能特性

- **三关闯关玩法**：连线分类 → 飞机接龙 → 转盘答题，覆盖 20 种氨基酸的类别、必需/非必需、代谢类型。
- **跨端实时同步**：手机 / 平板 / 电脑通过「学号绑定」共享同一份学习档案。
- **数据档案模块**（全新优化）：
  - 🔄 同步状态指示（云端 / 同步中 / 本地模式）
  - 🪪 身份卡片（学号绑定、设备数、最后更新时间）
  - 📈 学习进度条、统计卡片、通关记录
  - 🔍 薄弱点条形图、📊 正确率趋势折线图
  - 👨‍🏫 教师后台（全员总览、班级评价、共性薄弱、学生明细）
- **多端一致性保障**：增量操作 + 幂等去重 + 离线重放，多设备同时操作不丢数据、不重复计数。
- **零第三方依赖**：后端仅用 Node 原生 `http` 模块，前端纯原生 JS，`npm install` 都省了。
- **离线可用**：无后端时自动降级为本地模式，游戏仍可正常游玩。

---

## 📁 目录结构

```
amino-acid-game/
├── README.md               # 项目说明（本文件）
├── package.json            # 项目配置与启动脚本（零依赖）
├── .gitignore              # 忽略 data/ 与 node_modules/
├── server/
│   ├── server.js           # 自建 Node 后端（方案 B）：静态文件 + REST API + SSE 实时推送
│   └── storage.js          # 数据存储层：JSON 原子持久化 + 增量合并 + opId 去重
├── supabase/
│   └── schema.sql          # Supabase 建表 + RPC 函数（方案 A，复制到 SQL Editor 执行一次）
├── public/
│   ├── index.html          # 游戏前端（含数据档案 UI，支持双后端切换）
│   └── js/
│       ├── sync.js         # 自建后端云同步引擎（身份绑定 / 离线队列 / SSE / 多标签同步）
│       └── sync-supabase.js# Supabase 云同步引擎（RPC 增量同步 / Realtime 实时推送）
└── data/                   # 自建后端运行时生成的学习数据存档（gitignore）
    └── store.json
```

---

## 🚀 快速开始

### 环境要求

- Node.js **>= 18**（本项目零第三方依赖，无需 `npm install`）

### 启动

```bash
# 方式一：直接运行
node server/server.js

# 方式二：npm 脚本
npm start
```

启动后：

- 电脑本机访问：<http://localhost:3000>
- 手机/平板访问：`http://<电脑局域网IP>:3000`（需与电脑在同一局域网）
- 自定义端口：`PORT=8080 node server/server.js`

> 手机/平板访问前，请确认防火墙放行 3000 端口，或使用同一 WiFi。

---

## 🔗 跨端同步使用说明

1. 在任意设备打开网页，进入 **「📜 数据档案」** 页。
2. 在 **身份卡片** 中输入一个**学号或昵称**，点击「绑定」。
3. 在其他设备（手机、平板、电脑）打开同一网址，输入**完全相同的学号**并绑定。
4. 此后各设备的学习进度、通关记录、统计信息会**实时同步**——一台设备过关，另一台设备的数据档案立即更新（无需刷新）。

**未绑定时**：数据仅存本机（本地模式），各设备相互独立（等价于原版行为）。

> 教师视角：教师可在任意设备进入「👨‍🏫 教师后台」，实时查看全体已绑定的学习者总览、平均正确率、共性薄弱点与每位学员明细。

---

## 🏗️ 架构与多端一致性设计

```
┌────────────┐   POST /api/sync (增量 ops)   ┌──────────────┐
│  手机/平板  │ ─────────────────────────────▶│              │
│  电脑浏览器 │ ◀─────────────────────────────│  Node 后端   │──▶ data/store.json
│  (前端)    │   SSE /api/events (实时广播)   │  (原生 http) │
└────────────┘                               └──────────────┘
```

**一致性保障机制：**

1. **增量操作（op-based）**：前端不提交整份覆盖数据，只提交每次变化的「增量 op」（如 `practice +1`、`bestCorrect = max(..., n)`），从根本上避免多端同时写入时相互覆盖。
2. **幂等去重（opId）**：每个操作携带全局唯一 `opId`，服务端对已应用的 `opId` 去重，保证网络重试、离线重放不会重复累加计数。
3. **服务端权威 + 单调版本号**：服务端应用操作后全局 `version` 递增，SSE 广播最新快照，各端据此校准。
4. **离线队列**：断网时操作暂存本地队列，恢复连接后自动重放，不影响继续学习。
5. **实时推送（SSE）**：服务端在数据变更时向所有在线端广播 `update` 事件，数据档案即时刷新。
6. **多标签同步（BroadcastChannel）**：同一浏览器多标签页之间自动保持一致。

**字段合并策略：**

| 字段 | 策略 |
| --- | --- |
| `practice / pass1 / pass2 / correct3 / click / totalWrong` | 累加（`inc`） |
| `bestCorrect`（最高接对） | 取最大值（`max`） |
| `wrongCount.*`（各类错误数） | 按类别累加（`incKey`） |
| `historyRate`（正确率历史） | 按唯一 id 去重追加，保留最近 50 条 |

---

## 🔌 API 文档

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查，返回版本号 |
| `GET` | `/api/users` | 全部用户列表 |
| `GET` | `/api/users/:id` | 单个用户快照 |
| `POST` | `/api/sync` | 提交增量操作（含 opId 幂等去重） |
| `POST` | `/api/rename` | 绑定/重命名用户 |
| `GET` | `/api/events` | SSE 实时推送（`update` 事件） |

**`POST /api/sync` 请求体示例：**

```json
{
  "userId": "stu_%E5%BC%A0%E4%B8%89",
  "name": "张三",
  "deviceId": "dev_xxx",
  "ops": [
    { "opId": "x1a2b3", "field": "pass1", "op": "inc", "value": 1 },
    { "opId": "x1a2b4", "field": "bestCorrect", "op": "max", "value": 8 },
    { "opId": "x1a2b5", "field": "wrongCount", "op": "incKey", "key": "fx", "value": 1 }
  ]
}
```

---

## 🌐 部署到 GitHub（两种方案）

### 方案 A（推荐）：GitHub Pages + Supabase 免费云数据库

这是**唯一能在 GitHub 上实现「数据实时同步」**的方案——前端静态托管在 GitHub Pages，数据存 Supabase（免费 Postgres + Realtime 实时推送），无需自建后端。

**步骤：**

1. **注册 Supabase**（免费，无需信用卡）：<https://supabase.com> → 新建项目。

2. **执行建表 SQL**：进入项目控制台 → **SQL Editor** → 把本仓库 `supabase/schema.sql` 内容完整粘贴 → 点 **Run**（会建表、建 RPC 函数、开启实时订阅）。

3. **拿到两个 key**：控制台 → **Project Settings → API**，复制：
   - `Project URL`（形如 `https://xxxx.supabase.co`）
   - `anon public` key（形如 `eyJ...`）

4. **填入前端配置**：打开 `public/index.html`，把顶部注释里的这行取消注释并填入你的值：

   ```js
   window.AMINO_SUPABASE = { url: 'https://xxxx.supabase.co', anonKey: 'eyJ...' };
   ```

5. **推送到 GitHub 并开启 Pages**：

   ```bash
   git init && git add . && git commit -m "amino-acid-game"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/amino-acid-game.git
   git push -u origin main
   ```

   然后在仓库 **Settings → Pages → Build and deployment**：Source 选 **GitHub Actions** 或 `main` 分支 + `/public` 目录，保存后即可通过 `https://<用户名>.github.io/amino-acid-game/` 访问。

> 手机/平板/电脑打开同一网址，输入相同学号绑定，即可实时同步学习数据（数据存 Supabase，不依赖任何自建服务器）。

### 方案 B：自建 Node 后端

- **本地 / 服务器运行**：`node server/server.js`。
- **后端部署**：将 `server/` 部署到任意支持 Node.js 的云平台（Render、Railway、VPS 等），并把 `public/index.html` 顶部的 `window.AMINO_SERVER` 指向该地址。
- 注意：免费 Node 平台（如 Render 免费层）磁盘为临时盘、重启即清空，需另挂免费数据库才能持久化——因此更推荐方案 A。

---

## 🛠️ 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | 原生 HTML / CSS / JavaScript（移动优先响应式，无框架） |
| 同步方案 A | Supabase（Postgres + Realtime，RPC 增量同步） |
| 同步方案 B | Node.js 原生 `http` 模块（零依赖）+ SSE |
| 数据一致性 | 增量操作 + opId 幂等去重 + 版本号 |
| 离线策略 | 本地队列 + 自动重放 + localStorage 降级 |

---

## 📄 License

MIT License

---

## 🔭 后续可扩展

- [ ] 接入 SQLite / MongoDB 替换 JSON 文件，支持更大规模并发
- [ ] 增加 WebSocket 替代 SSE（更低延迟双向通信）
- [ ] 学员成绩导出 CSV / 教师端批量查看
- [ ] 登录鉴权与学号密码
