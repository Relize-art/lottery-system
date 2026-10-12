# 抽奖系统（抽奖转盘）

一个轻量级的转盘抽奖小系统，基于 **Node.js + Express**，纯静态前端（单文件 HTML），开箱即用。适用于年会、活动现场、门店活动等场景。

## 功能特性

- 🎡 **跑马灯奖品展示**：奖品图片横向匀速滚动，后台改动配置后前台 3 秒内自动同步
- 🎯 **概率抽奖**：按后台配置的概率加权随机抽奖，先落盘（WAL）再返回结果，绝不超发
- 👤 **每人限抽一次**：浏览器身份 + 服务端强校验，刷新/重开浏览器仍锁定
- 🔓 **工作人员测试模式**：前台输入管理密码可解锁多次抽奖（测试抽奖单独标记，不占名额）
- 🖼️ **中奖弹窗**：5 款精美边框随机展示，左文右图布局，含物品图与动态光效
- 🛠️ **后台管理**（`/admin.html`）：奖品增删改、概率/库存配置、图片上传、中奖记录、一键重置
- ☁️ **图片直存阿里云 OSS**：经服务器内存中转直传，本机不落盘，前台加载 OSS 实时缩略图（webp）
- 💾 **数据安全**：内存态 + WAL 同步追加日志 + 防抖原子快照，进程被杀/断电后自动恢复，500 人并发压测零超发
- 📱 **响应式**：桌面端与手机端均可正常使用

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动
node server.js
# 默认端口 3000，可通过环境变量指定：PORT=8080 node server.js

# 3. 访问
# 前台抽奖页  http://localhost:3000/
# 后台管理页  http://localhost:3000/admin.html
```

## 配置

### 管理密码

后台管理与前台「工作人员解锁」共用同一密码，定义在 `server.js` 顶部的 `ADMIN_PASSWORD`，请部署前修改为自己的密码。

### 阿里云 OSS（可选，用于图片上传）

复制一份 `oss-config.json` 放到项目根目录（已被 `.gitignore` 排除，不会提交）：

```json
{
  "region": "oss-cn-beijing",
  "accessKeyId": "你的AccessKey ID",
  "accessKeySecret": "你的AccessKey Secret",
  "bucket": "你的Bucket名称",
  "dir": "lottery"
}
```

| 字段 | 说明 |
|---|---|
| region | Bucket 所在地域，如 `oss-cn-beijing`（华北2·北京） |
| accessKeyId / accessKeySecret | RAM 子账号的 AccessKey（建议仅授予目标 Bucket 权限） |
| bucket | Bucket 名称，读写权限需为「公共读」 |
| dir | 存档目录前缀，默认 `lottery`，按 `dir/年月/随机文件名` 归档 |

未配置 OSS 时系统其余功能不受影响，仅图片上传不可用（可在后台手动粘贴图片地址）。

## 生产部署建议

- 用 [PM2](https://pm2.keymetrics.io/) 守护进程：`pm2 start server.js --name lottery && pm2 save`
- 建议置于 Nginx 反向代理之后（服务端已启用 `trust proxy`，限流按真实访客 IP 生效）
- 同 IP 防连点限流默认 1.5 秒/次，可用环境变量 `DRAW_RATE_MS` 调整（设为 `0` 关闭）

## 项目结构

```
├── server.js          # 后端服务（抽奖逻辑 / WAL 持久化 / OSS 上传 / 鉴权限流）
├── package.json
├── public/
│   ├── index.html     # 前台抽奖页（单文件，含样式与脚本）
│   ├── admin.html     # 后台管理页
│   └── frames/        # 中奖弹窗边框图（frame1~5）
├── data/              # 运行时生成：data.json 快照 + wal.log 日志（不入库）
└── oss-config.json    # OSS 密钥配置（自行创建，不入库）
```

## 安全说明

- `oss-config.json` 与 `data/` 已在 `.gitignore` 中排除，请勿将密钥提交到任何仓库
- 建议使用 RAM 子账号密钥并遵循最小权限原则
- 管理密码为前端弹窗 + 服务端校验的轻量方案，适合活动场景，请勿用于高安全需求场景

## License

[MIT](LICENSE)
