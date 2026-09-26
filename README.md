# AoI - 你的本地图片管家

> 本项目由 妄想天使 AoD 独家赞助，关注妄想天使谢谢喵~

AoI（Angel of Images），你的本地图片管家。

下载了很多图包太占地？图片太大内存爆炸？AoI 让你一个平台管理所有图片，本地轻装上阵，需要时在线浏览 / 下载到本地，样样齐全。

## 功能

- **上传** — 支持 ZIP / RAR 格式，基于 tus 协议的可恢复上传
- **解压** — 自动解压并检测目录结构（扁平 / 嵌套）
- **缩略图** — 自动生成缩略图 + Blurhash 占位图
- **压缩** — 可配置 JPEG 质量、最大尺寸、是否保留视频
- **预设** — 保存常用压缩参数，一键应用
- **标签** — 为图包添加标签，支持搜索过滤
- **文件树** — 嵌套结构的图包可浏览和选择性压缩

## 技术栈

- **Runtime**: Node.js 22 (ESM)
- **Server**: Fastify 5 + TypeScript
- **Database**: better-sqlite3（原生 SQLite、WAL、事务与外键）
- **Client**: React 19 + TypeScript + Vite 6 + Tailwind CSS 4
- **图片处理**: Sharp (缩略图、压缩、Blurhash)
- **压缩包**: yauzl / 系统 `7z`（解压）+ Archiver（打包）

## 环境要求

- Node.js >= 22
- ZIP 可由 Node.js 直接处理；RAR、7z、加密压缩包及 ZIP fallback 需要系统提供 `7z`

```bash
# Debian/Ubuntu
sudo apt-get install -y p7zip-full

# macOS
brew install p7zip
```

## 快速开始

### 安装依赖

```bash
npm install
cd server && npm install && cd ..
cd client && npm install && cd ..
```

### 开发模式

```bash
npm run dev
```

前端运行在 `http://localhost:5173`，自动代理 API 请求到后端 `localhost:3000`。

### 生产构建

```bash
npm run build
npm test
```

前端构建到 `server/public`，后端编译到 `server/dist/`。

### 启动生产服务

```bash
npm run start
# 或直接
cd server && node dist/server/src/index.js
```

## 配置

通过环境变量配置，均设有默认值：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 服务监听地址 |
| `DATA_DIR` | `./data` | 数据存储目录 |
| `MAX_UPLOAD_SIZE` | `5368709120` | 单次上传上限（字节） |
| `MAX_API_BODY_SIZE` | `16777216` | JSON 等普通请求体上限（字节） |
| `MAX_EXTRACTED_SIZE` | `21474836480` | 单包最大解压体积（字节） |
| `MAX_ARCHIVE_ENTRIES` | `100000` | 单包最大条目数 |
| `MAX_COMPRESSION_RATIO` | `1000` | 允许的最大压缩比 |
| `MAX_IMAGE_PIXELS` | `100000000` | 单张图片允许的最大像素数 |
| `ARCHIVE_COMMAND_TIMEOUT` | `1800000` | 外部 7z 命令超时（毫秒） |
| `DATABASE_BUSY_TIMEOUT` | `5000` | SQLite 忙等待时间（毫秒） |
| `INSTANCE_LOCK_TIMEOUT` | `1000` | 第二实例等待 SQLite 排他锁的时间（毫秒） |
| `BACKUP_RETENTION` | `5` | 自动数据库备份保留数 |
| `SHUTDOWN_TIMEOUT` | `25000` | 优雅退出等待任务时间（毫秒） |

### 数据目录结构

```
data/
├── archives/      # 原始上传的压缩包
├── extracted/     # 解压后的文件 (images/, thumbnails/, videos/)
├── generated/     # 压缩结果
├── thumbnails/    # 图包封面
├── uploads/       # tus 上传临时文件
├── backups/       # 启动/退出时生成的 SQLite 在线备份
└── db/            # SQLite 数据库、WAL 与单实例锁库
```

同一 `DATA_DIR` 只允许一个 AoI 进程运行；第二个进程会因 SQLite 原生排他锁拒绝启动。服务收到 `SIGINT`/`SIGTERM` 后停止接收请求、等待当前任务、备份并关闭数据库。若数据库文件为空、损坏，或已初始化的数据目录中数据库意外消失，服务会拒绝创建空库，避免静默覆盖。恢复时先停止服务，将 `backups/` 中确认可用的备份复制为 `db/packdb.sqlite`，并保留原故障文件用于排查。

### 从留存文件重建目录

如果数据库已经丢失，但 `archives/`、`extracted/` 或 `generated/` 仍然存在，可使用独立恢复脚本重建部分目录：

```bash
cp scripts/recover-aoi-data.py /path/to/data/
cd /path/to/data
python3 recover-aoi-data.py
```

脚本仅依赖 Python 3 标准库，会从可读数据库/备份合并元数据，再以留存文件重算图包状态和文件统计。结果写入新的 `aoi-recovery-<时间>/` 目录，不会覆盖数据库或移动源文件。替换正式数据库前必须停止全部 AoI、PM2 或 Docker 实例，并先检查生成的 `recovery-report.json` 和 `README.txt`。

若只有加密原包、没有已解压文件，可启用交互式密码恢复：

```bash
python3 recover-aoi-data.py --ask-passwords
```

脚本只对必须重新解压的条目询问密码，直接回车可跳过。密码通过压缩包实际测试后才写入权限为 `0600` 的恢复库，报告不包含明文密码；已有 `extracted/` 或 `generated/` 数据的条目不会询问或保存密码。

传统加密 ZIP 可由 Python 直接校验；AES ZIP、RAR 和 7z 需要系统提供 `7z`、`7zz` 或 `7za`。这些命令只能通过命令参数接收密码，同机其他进程可能在极短时间内从进程列表看到参数，因此只应在可信的离线主机上执行。恢复库中的 `archive_password` 也是明文 SQLite 字段，仅用于下一次解压并会在成功后清除。

## 使用 pm2 部署

项目包含 `ecosystem.config.cjs`，可直接用 pm2 管理：

```bash
# 构建
npm run build

# 启动
pm2 start ecosystem.config.cjs

# 常用命令
pm2 status
pm2 logs pack-server
pm2 restart pack-server
pm2 save
```

SQLite 单实例策略不支持 PM2 cluster 或零停机 reload；请保持 `instances: 1`、`exec_mode: 'fork'`，使用 `pm2 restart pack-server`。

如需自定义数据目录和端口，修改 `ecosystem.config.cjs` 中的 `env` 配置：

```js
env: {
  PORT: 8555,
  HOST: '0.0.0.0',
  DATA_DIR: '/path/to/data',
  NODE_ENV: 'production',
}
```

## 使用 Docker 部署

项目包含 `Dockerfile`：

```bash
docker build -t aoi .

# 运行
# 绑定宿主目录时，先确保容器内 node 用户（uid 1000）可写该目录
docker run -d \
  --stop-timeout 45 \
  -p 3000:3000 \
  -v /path/to/data:/app/data \
  aoi
```

## 项目结构

```
├── shared/types.ts           # 前后端共享类型
├── server/
│   └── src/
│       ├── index.ts          # Fastify 入口
│       ├── config.ts         # 配置 (Zod 校验)
│       ├── db/               # 原生 SQLite、迁移与仓储
│       ├── plugins/tus.ts    # tus 上传插件
│       ├── routes/           # API 路由
│       └── services/         # 业务逻辑
├── client/
│   └── src/
│       ├── api/              # API 封装
│       ├── pages/            # 页面组件
│       ├── components/       # 通用组件
│       └── hooks/            # React Hooks
└── data/                     # 运行时数据 (gitignore)
```

## 验证

```bash
npm run check     # 前后端生产构建 + 服务端回归测试
npm audit         # 根开发工具依赖审计
npm --prefix server audit
npm --prefix client audit
```

服务端测试覆盖优雅退出、强制终止后的事务持久性、单实例锁、空库/丢库拒绝启动、外键级联和路径穿越校验。

当前 React Router 的 npm 公告包含仅适用于 RSC/server actions 的问题；AoI 是纯客户端 `BrowserRouter` SPA，不启用 RSC 或服务端 action。升级路由依赖时仍需重新审阅 `client` 的审计结果与应用模式。

## License

MIT
