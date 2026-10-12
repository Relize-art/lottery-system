const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const OSS = require('ali-oss');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
// 位于 Nginx 反向代理之后时，从 X-Forwarded-For 取真实客户端 IP（限流按人而非按代理）
app.set('trust proxy', true);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const OSS_CONFIG_FILE = path.join(__dirname, 'oss-config.json');
const ADMIN_PASSWORD = '135790';

// 内存中的管理员 token 集合
const adminTokens = new Set();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  // HTML 每次都向服务端校验：发布新版后用户刷新即生效，避免缓存旧页面
  setHeaders(res, filePath) {
    if (/\.html$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// ---------- 阿里云 OSS 配置与上传 ----------
// 每次上传时重新读取配置文件，修改后无需重启服务
function readOssConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(OSS_CONFIG_FILE, 'utf-8'));
    const ready = cfg.region && cfg.bucket &&
      cfg.accessKeyId && cfg.accessKeySecret &&
      !/在这里填/.test(cfg.accessKeyId + cfg.accessKeySecret + cfg.bucket);
    return { cfg, ready };
  } catch (e) {
    return { cfg: null, ready: false };
  }
}

// 文件仅在内存中暂存，不落本地磁盘，直接中转上传到 OSS
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp|bmp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('仅支持 jpg/png/gif/webp/bmp 格式的图片'));
  }
});


function imgUrl(prompt, size = 'square') {
  return `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${encodeURIComponent(prompt)}&image_size=${size}`;
}

// ---------- 数据存储：内存状态(唯一权威) + WAL 追加日志 + 防抖原子快照 ----------
// 设计目标：数百人并发抽奖时临界区极短、绝不超发；进程崩溃后库存零丢失。
const WAL_FILE = path.join(DATA_DIR, 'wal.log');
const TMP_DATA_FILE = DATA_FILE + '.tmp';
const MAX_RECORDS = 10000;                 // 中奖记录保留上限，防止内存/快照无限膨胀
const SNAPSHOT_DEBOUNCE_MS = 1000;        // 抽奖快照合并窗口
const DRAW_INTERVAL_MS = Number(process.env.DRAW_RATE_MS ?? 1500); // 同 IP 最小抽奖间隔，设为 0 关闭限流

let state = null;   // { prizes: [], records: [], participants: Set<id> }
let walFd = null;
let snapshotTimer = null;

// 已参与抽奖的浏览器身份集合（运行时为 Set，快照中以数组持久化）
function normalizeState(s) {
  if (!s || !Array.isArray(s.prizes)) s = defaultState();
  if (!Array.isArray(s.records)) s.records = [];
  s.participants = new Set(Array.isArray(s.participants) ? s.participants : []);
  return s;
}

function serializeState() {
  return JSON.stringify({ ...state, participants: [...state.participants] }, null, 2);
}

function defaultState() {
  return {
    prizes: [
      { id: genId(), name: '一等奖 iPhone', probability: 1, total: 1, drawn: 0, image: imgUrl('一部最新款智能手机产品图，纯白背景，居中展示，高端商业摄影风格，高清写实') },
      { id: genId(), name: '二等奖 无线耳机', probability: 5, total: 3, drawn: 0, image: imgUrl('一副白色真无线蓝牙耳机和充电盒产品图，纯白背景，居中展示，高端商业摄影风格，高清写实') },
      { id: genId(), name: '三等奖 充电宝', probability: 15, total: 10, drawn: 0, image: imgUrl('一个白色轻薄移动电源充电宝产品图，纯白背景，居中展示，极简商业摄影风格，高清写实') },
      { id: genId(), name: '谢谢参与', probability: 79, total: 9999, drawn: 0, image: imgUrl('一个系着红色丝带的米白色礼物盒，纯白背景，居中构图，柔和光线，扁平插画风格，极简') }
    ],
    records: [],
    participants: new Set()
  };
}

// 将一条 WAL 日志应用到内存状态（draw 按 recordId 幂等，保证"快照后清 WAL 前崩溃"不重复扣减）
function applyWalEntry(state, e) {
  if (e.type === 'draw' && e.prizeId) {
    if (e.recordId && state.records.some(r => r.id === e.recordId)) return; // 已包含在快照中
    const p = state.prizes.find(x => x.id === e.prizeId);
    if (p && p.drawn < p.total) p.drawn += 1;  // 重放也做库存防御
    state.records.unshift({
      id: e.recordId || genId(), prizeId: e.prizeId, prizeName: e.prizeName,
      participant: e.p || null, test: !!e.test, time: e.time
    });
    if (state.records.length > MAX_RECORDS) state.records.length = MAX_RECORDS;
    if (e.p) state.participants.add(e.p);   // 恢复"每人一次"标记（管理员测试抽奖无此字段）
  } else if (e.type === 'config' && Array.isArray(e.prizes)) {
    state.prizes = e.prizes;  // 重复重放天然幂等
  } else if (e.type === 'reset') {
    state.prizes.forEach(p => { p.drawn = 0; });
    state.records = [];       // 重复重放天然幂等
    state.participants.clear();
  }
}

// 启动恢复：读快照 -> 重放 WAL -> 打开 WAL 句柄
function loadState() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(DATA_FILE)) {
    try {
      state = normalizeState(JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')));
    } catch (err) {
      // 快照损坏时不直接丢弃：隔离备份后用默认状态，WAL 仍会尝试重放
      fs.renameSync(DATA_FILE, DATA_FILE + '.corrupt-' + Date.now());
      console.warn('数据快照损坏，已隔离备份，使用默认数据启动');
      state = defaultState();
    }
  } else {
    state = defaultState();
  }

  if (fs.existsSync(WAL_FILE)) {
    const lines = fs.readFileSync(WAL_FILE, 'utf-8').split('\n').filter(Boolean);
    let replayed = 0;
    for (const line of lines) {
      try { applyWalEntry(state, JSON.parse(line)); replayed++; }
      catch (_) { /* 跳过损坏的半行日志 */ }
    }
    if (replayed > 0) console.log(`崩溃恢复：已重放 ${replayed} 条 WAL 日志`);
  }

  walFd = fs.openSync(WAL_FILE, 'a');
  saveSnapshotNow();  // 恢复后立即固化，清空已重放的 WAL
}

// 同步追加 WAL 并 fsync：返回后即使断电该笔抽奖也不丢
function appendWal(entry) {
  fs.writeSync(walFd, JSON.stringify(entry) + '\n');
  fs.fsyncSync(walFd);
}

// 原子快照：写临时文件 -> rename 替换 -> 归档旧 WAL -> 开新 WAL
// 注：Windows 不允许对 append 句柄 ftruncate，且 rename 为原子操作；
//     即使在两步之间崩溃，draw 的 recordId 幂等重放也不会重复扣减
function saveSnapshotNow() {
  if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
  fs.writeFileSync(TMP_DATA_FILE, serializeState(), 'utf-8');
  fs.renameSync(TMP_DATA_FILE, DATA_FILE);
  fs.closeSync(walFd);
  try { fs.unlinkSync(WAL_FILE + '.old'); } catch (_) { /* 无旧归档忽略 */ }
  try { fs.renameSync(WAL_FILE, WAL_FILE + '.old'); } catch (_) { /* WAL 不存在忽略 */ }
  walFd = fs.openSync(WAL_FILE, 'a');
}

// 抽奖高频路径：1 秒内的多次抽奖合并为一次快照写盘（WAL 已保证安全）
function scheduleSnapshot() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    try { saveSnapshotNow(); } catch (err) { console.error('快照写入失败：', err.message); }
  }, SNAPSHOT_DEBOUNCE_MS);
}

process.on('SIGINT', () => { try { saveSnapshotNow(); } catch (_) {} process.exit(0); });
process.on('SIGTERM', () => { try { saveSnapshotNow(); } catch (_) {} process.exit(0); });

function genId() {
  return crypto.randomBytes(6).toString('hex');
}

function nowStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 同 IP 抽奖频率限制（防止双击/脚本刷库存）
const lastDrawAt = new Map();
function rateLimited(ip) {
  if (DRAW_INTERVAL_MS <= 0) return false;
  const now = Date.now();
  const last = lastDrawAt.get(ip) || 0;
  if (now - last < DRAW_INTERVAL_MS) return true;
  lastDrawAt.set(ip, now);
  // 顺带清理过期项，避免 Map 无限增长
  if (lastDrawAt.size > 5000) {
    for (const [k, v] of lastDrawAt) if (now - v > 60000) lastDrawAt.delete(k);
  }
  return false;
}

// ---------- 鉴权中间件 ----------
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: '未登录或登录已失效' });
  }
  next();
}

// ---------- 路由 ----------

// 管理员登录
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(24).toString('hex');
    adminTokens.add(token);
    return res.json({ token });
  }
  res.status(401).json({ error: '密码错误' });
});

// 登出
app.post('/api/logout', requireAdmin, (req, res) => {
  const token = req.headers['x-admin-token'];
  adminTokens.delete(token);
  res.json({ ok: true });
});

// 获取奖品列表（公开）
app.get('/api/prizes', (req, res) => {
  res.json(state.prizes);
});

// 更新奖品配置（管理员）
app.put('/api/prizes', requireAdmin, (req, res) => {
  const prizes = req.body.prizes;
  if (!Array.isArray(prizes)) {
    return res.status(400).json({ error: '奖品数据格式错误' });
  }
  // 保留已抽取数量：按 id 匹配
  const oldMap = new Map(state.prizes.map(p => [p.id, p.drawn]));
  const cleaned = prizes.map(p => {
    const id = p.id || genId();
    const drawn = oldMap.has(id) ? Math.min(oldMap.get(id), Number(p.total) || 0) : 0;
    return {
      id,
      name: String(p.name || '未命名奖品').slice(0, 30),
      probability: Math.max(0, Number(p.probability) || 0),
      total: Math.max(0, Math.floor(Number(p.total) || 0)),
      image: String(p.image || '').slice(0, 500),
      drawn
    };
  });
  state.prizes = cleaned;
  appendWal({ type: 'config', prizes: cleaned });
  saveSnapshotNow();  // 管理操作低频，立即原子落盘
  res.json(state.prizes);
});

// 查询当前浏览器身份是否已抽过（公开，供前台刷新后恢复按钮状态）
app.get('/api/my-draw', (req, res) => {
  const pid = String(req.query.participantId || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(pid)) return res.json({ drawn: false });
  res.json({ drawn: state.participants.has(pid) });
});

// 执行抽奖（临界区：纯内存操作 + WAL 同步追加，单线程内天然串行，绝不超发）
// 规则：普通参与者凭浏览器身份每人限抽 1 次；携带有效管理员 token 时为测试模式，不限次数
app.post('/api/draw', (req, res) => {
  const adminToken = req.headers['x-admin-token'];
  const isAdmin = !!adminToken && adminTokens.has(adminToken);

  // 参与者浏览器身份（由前台生成并持久保存在 localStorage）
  const participantId = String((req.body && req.body.participantId) || '');
  if (!isAdmin) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(participantId)) {
      return res.status(400).json({ error: '无法确认您的参与身份，请刷新页面后重试', code: 'NO_IDENTITY' });
    }
    if (state.participants.has(participantId)) {
      return res.status(409).json({ error: '您已参与过抽奖，每人限抽一次', code: 'ALREADY_DRAWN' });
    }
    if (rateLimited(req.ip)) {
      return res.status(429).json({ error: '操作太频繁，请稍后再试' });
    }
  }

  // 筛选有剩余库存且概率 > 0 的奖品
  const available = state.prizes.filter(p => p.drawn < p.total && p.probability > 0);
  if (available.length === 0) {
    return res.status(400).json({ error: '所有奖品已抽完，暂无可用奖品' });
  }
  const totalProb = available.reduce((s, p) => s + p.probability, 0);
  if (totalProb <= 0) {
    return res.status(400).json({ error: '可用奖品概率总和为 0' });
  }
  let r = Math.random() * totalProb;
  let winner = available[0];
  for (const p of available) {
    r -= p.probability;
    if (r <= 0) { winner = p; break; }
  }
  // 扣减库存（防御性二次断言）
  const target = state.prizes.find(p => p.id === winner.id);
  if (!target || target.drawn >= target.total) {
    return res.status(409).json({ error: '该奖品刚被抽完，请再试一次' });
  }

  // 先登记参与者再扣库存：登记与扣减在同一事件循环临界区内，并发请求也不会放过第二次
  if (!isAdmin) state.participants.add(participantId);
  target.drawn += 1;

  // 写入记录
  const record = {
    id: genId(),
    prizeId: target.id,
    prizeName: target.name,
    participant: isAdmin ? null : participantId,
    test: isAdmin,
    time: nowStr()
  };
  state.records.unshift(record);
  if (state.records.length > MAX_RECORDS) state.records.length = MAX_RECORDS;

  // 先持久化 WAL 再响应：客户端收到中奖结果时，这笔抽奖已保证落盘
  appendWal({
    type: 'draw',
    prizeId: target.id,
    prizeName: target.name,
    recordId: record.id,
    p: isAdmin ? undefined : participantId,
    test: isAdmin || undefined,
    time: record.time
  });
  scheduleSnapshot();
  res.json({ prize: target, record });
});

// 获取抽奖记录
app.get('/api/records', requireAdmin, (req, res) => {
  res.json(state.records);
});

// 重置（清空所有抽取记录和库存计数）
app.post('/api/reset', requireAdmin, (req, res) => {
  state.prizes.forEach(p => { p.drawn = 0; });
  state.records = [];
  state.participants.clear();
  appendWal({ type: 'reset' });
  saveSnapshotNow();
  res.json({ ok: true, prizes: state.prizes });
});

// 查询 OSS 是否已配置（后台据此显示上传入口或配置提示）
app.get('/api/oss-status', requireAdmin, (req, res) => {
  res.json({ configured: readOssConfig().ready });
});

// 上传奖品图片：浏览器选图 -> 服务器中转 -> 阿里云 OSS 留档，返回可公开访问的 URL
app.post('/api/upload', requireAdmin, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || '图片上传失败' });
    }
    if (!req.file) return res.status(400).json({ error: '未收到图片文件' });

    const { cfg, ready } = readOssConfig();
    if (!ready) {
      return res.status(503).json({ error: 'OSS 尚未配置，请先在服务器 oss-config.json 中填写阿里云密钥' });
    }

    const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };
    const ext = extMap[req.file.mimetype] || 'jpg';
    const d = new Date();
    const month = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
    const dir = (cfg.dir || 'lottery').replace(/^\/+|\/+$/g, '');
    const key = `${dir}/${month}/${crypto.randomBytes(12).toString('hex')}.${ext}`;

    const client = new OSS({
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      accessKeySecret: cfg.accessKeySecret,
      bucket: cfg.bucket,
      secure: cfg.secure !== false
    });

    client.put(key, req.file.buffer, {
      mime: req.file.mimetype,
      headers: { 'x-oss-object-acl': 'public-read' }
    }).then(() => {
      const url = cfg.cdnDomain
        ? `https://${cfg.cdnDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/${key}`
        : `https://${cfg.bucket}.${cfg.region}.aliyuncs.com/${key}`;
      res.json({ url, key });
    }).catch(e => {
      res.status(502).json({ error: '上传到 OSS 失败：' + (e.code || e.message) });
    });
  });
});

// ---------- 启动 ----------
loadState();
// backlog 加大：应对现场数百人在短时间内集中点击时的 TCP 连接排队
const server = app.listen(PORT, '0.0.0.0', 1024, () => {
  console.log(`\n  抽奖转盘系统已启动`);
  console.log(`  前台抽奖页: http://localhost:${PORT}/`);
  console.log(`  后台管理页: http://localhost:${PORT}/admin.html`);
  console.log(`  管理密码: 135790\n`);
});
