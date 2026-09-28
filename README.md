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

## 使用 Docker 部署（推荐）

GitHub Actions 检查通过后，将 `linux/amd64` 镜像发布到 `ghcr.io/std4453/aoi`：

| 触发 | 检查与镜像标签 |
| --- | --- |
| Pull Request | `npm run check`、构建及容器冒烟检查，不发布 |
| `main` 更新 | `edge`、`sha-<完整提交哈希>` |
| `vX.Y.Z` 标签 | `X.Y.Z`、`latest`、提交 SHA 标签 |
| `vX.Y.Z-prerelease` 标签 | 预发布版本标签、提交 SHA，不更新 `latest` |
| 手动运行 | 当前提交 SHA；在默认分支运行时也更新 `edge` |

工作流使用 `GITHUB_TOKEN` 的 `packages: write` 权限，无需额外 PAT。首次发布后，在 GitHub Packages 设置中确认包可见性：若需要匿名拉取，应将包设置为 public；私有包需在部署机器登录 GHCR。工作流只发布镜像，不自动更新部署机器。发布前会检查完整服务和纯前端两种容器模式。

仓库提供 `compose.yaml`：

```bash
# 确保目录由容器内 node 用户（uid 1000）可写
mkdir -p data
# 首次发布正式版前使用 edge；正式部署建议 AOI_VERSION 指定已发布的版本号
AOI_VERSION=edge docker compose pull
AOI_VERSION=edge docker compose up -d

docker compose logs -f
```

可在部署目录的 `.env` 中配置 `AOI_VERSION`、`AOI_PORT` 和下表中的环境变量；不要提交 `.env`。升级时先拉取目标版本，再执行 `docker compose up -d`。数据始终挂载到 `/app/data`，保持单实例，不要让多个容器共用同一数据目录。纯前端模式不会使用数据卷。

本地构建仍可使用 `docker build --platform linux/amd64 -t aoi .`。

## 独立前端、服务器选择与鉴权

所有开关均为**运行时配置**，同一构建和镜像可重复使用；不需要为不同后端重新构建前端。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `FRONTEND_ONLY` | `false` | 仅提供前端、公开运行配置和 `/healthz`；不初始化数据库、上传目录或队列，不提供业务 API |
| `SERVER_SELECTION_ENABLED` | `false` | 显示服务器列表，允许连接不同后端；关闭时连接当前页面同源后端 |
| `AUTH_KEY` | 空 | 后端唯一登录 key；为空时无需输入 key |
| `TLS_CERT_FILE` | 空 | PEM 证书链文件路径 |
| `TLS_KEY_FILE` | 空 | PEM 私钥文件路径，必须与证书同时配置 |

布尔开关接受 `true`/`false` 或 `1`/`0`。纯前端通常同时开启两个开关。例如：

```bash
FRONTEND_ONLY=true SERVER_SELECTION_ENABLED=true docker compose up -d
```

完整服务默认仍提供前端和 API。服务器地址格式为 `https://example.com:8555`，支持域名、IPv4、方括号包围的 IPv6 和可选端口，不支持路径前缀。HTTPS 前端应搭配受信任的 HTTPS 后端；还需允许浏览器访问局域网。

浏览器 localStorage 保存每条服务器记录的别名、地址和 key。重新打开页面时自动验证最近的服务器；第三个「设置」tab 中的「切换服务器」进入服务器列表，点击记录直接连接，编辑和删除使用图标按钮。全宽「添加服务器」按钮进入独立表单，一次填写别名、地址和 key（可留空），可以返回列表；首次无记录时直接显示该表单。登录错误通过 toast 提示。切换不删除 key，记录之间不共享缓存。修改记录地址和删除记录会清除对应缓存。key 错误时留在登录流程修改。

`/api/health` 公开返回服务标识和是否需要 key；`/api/auth/login` 验证 key 并返回进程有效期内的临时凭证。普通 API 和 tus 使用 Bearer 头，图片、下载和 SSE 使用临时凭证，长期 key 不进入 URL。服务重启会使临时凭证失效；刷新或重新连接后使用保存的 key 登录。反向代理也应避免记录资源 URL 中的 `access_token`。

前端运行配置 `/runtime-config.json` 只暴露服务器选择开关，不暴露 key 或证书配置。业务接口允许跨域访问；CORS 不替代鉴权。

## HTTPS 与证书更新

服务启动时读取 `TLS_CERT_FILE` 和 `TLS_KEY_FILE`，在 `PORT` 指定的端口提供 HTTPS。配置不完整或证书无法加载时启动失败，不回退 HTTP。也可继续由外部反向代理提供 HTTPS。

证书申请和续期由外部工具负责。使用 Compose 时取消证书环境变量及 `./certs:/app/certs:ro` 的注释，挂载包含证书链及私钥的目录，并确保容器 uid 1000 可读取文件。若证书路径是符号链接，也必须挂载其目标文件。更新文件后运行 `docker compose restart aoi`；PM2 则执行 restart。

局域网可使用解析到内网 IP 的域名配合受信任证书。证书必须匹配访问地址并被设备信任；网页无法忽略证书错误。容器健康检查访问本机 `/healthz`，支持 HTTP/HTTPS，且不依赖业务 key 或数据库。

## iOS PWA 与离线浏览

生产构建包含 manifest、安装图标和 Service Worker；开发模式不注册 Service Worker。使用 HTTPS 访问后，可在 iOS Safari 中通过分享菜单「添加到主屏幕」。首次联网成功后才能缓存应用和业务内容。

- 缓存应用页面及实际请求过的图包列表、详情、封面、缩略图和只读配置；不预下载整个图包。
- 不缓存原图、压缩包、登录响应、实时进度或写操作。
- 各服务器记录独立缓存，业务缓存合计上限 200 MiB；达到上限时淘汰旧内容，浏览器配额不足时缓存失败不影响在线请求。
- 设置页显示业务缓存用量，可清空当前服务器缓存。浏览器可能回收缓存，因此它不能代替备份。
- 曾成功登录的服务器不可达时，可以选择只读查看已有缓存；未缓存内容显示缺失。服务端修改 key 无法远程撤销已经保存的离线内容；明确收到鉴权失败后要求重新登录。
- 离线时显示灰色常驻「离线浏览中」toast，点击打开说明、刷新和切换服务器弹窗，不占据顶部空间。恢复后显示「连接已恢复」，点击直接刷新；不自动更新当前页面、跳转服务器或重置阅读位置。写操作不会离线排队。
- 应用新版本安装完成后提示「更新并刷新」，用户主动点击才更新当前页面。

Safari/iOS 的证书信任、局域网授权、主屏幕安装和系统存储回收仍需在目标真机上验收。无法建立连接时，前端统一提示检查网络、地址、证书和局域网权限，因为浏览器通常不向网页暴露具体的 TLS/CORS 错误。

## 从 PM2 迁移到 Docker

`ecosystem.config.cjs` 继续保留，支持上述运行时开关、key 和证书配置。修改环境变量后使用 `pm2 restart ecosystem.config.cjs --update-env`；保持 fork/单实例，不能使用 cluster 或 reload。

迁移步骤：备份持久化数据，停止 PM2 实例，将原 `DATA_DIR` 挂载为容器的 `/app/data`，检查 uid 1000 的读写权限，再启动 Docker。不要同时启动两种部署方式访问同一数据目录。证书续期或配置调整后通过 restart 生效。

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
