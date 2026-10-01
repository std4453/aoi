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
| 同仓库且作者为 `OWNER` / `MEMBER` / `COLLABORATOR` 的真人 PR | 检查通过后发布 `pr-<编号>`、`pr-<编号>-sha-<完整哈希>` |
| 其他 Pull Request（包括 fork 和机器人作者） | `npm run check`、构建及容器冒烟检查，不发布 |
| `main` 更新 | `edge`、`sha-<完整提交哈希>` |
| `vX.Y.Z` 标签 | `X.Y.Z`、`latest`、提交 SHA 标签 |
| `vX.Y.Z-prerelease` 标签 | 预发布版本标签、提交 SHA，不更新 `latest` |
| 手动运行 | 当前提交 SHA；在默认分支运行时也更新 `edge` |

PR 发布根据作者的 `author_association` 判断，不要求查询用户权限 API；该字段表示与仓库的关系，不等同于具体写入权限。所有 PR 都执行检查，只有符合条件的同仓库 PR 才登录 GHCR 并发布；预览标签不会覆盖 `edge` 或 `latest`。PR 镜像使用 Actions 的 PR 合并提交构建，便于验证与目标分支合并后的结果。

工作流使用 `GITHUB_TOKEN` 的 `packages: write` 权限，无需额外 PAT。首次发布后，在 GitHub Packages 设置中确认包可见性：若需要匿名拉取，应将包设置为 public；私有包需在部署机器登录 GHCR。工作流只发布镜像，不自动更新部署机器。发布前会检查完整服务和纯前端两种容器模式。

### 单容器部署（前端和后端一起提供）

部署机器需要 Docker Engine 和 Docker Compose 插件，无需安装 Node.js 或 `7z`。将仓库的 `compose.yaml` 复制到一个独立部署目录，在该目录创建 `.env`：

```dotenv
# 测试本 PR 使用 pr-3；main 发布后可用 edge，正式部署建议固定已发布版本
AOI_VERSION=pr-3
AOI_PORT=8555
AUTH_KEY=replace-with-your-own-long-key
FRONTEND_ONLY=false
SERVER_SELECTION_ENABLED=false
```

将示例 key 替换为自己的 key；留空表示不鉴权。然后执行：

```bash
mkdir -p data
# 仅对这个专用数据目录设置容器 node 用户的权限
sudo chown 1000:1000 data
chmod 600 .env
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f
```

访问 `http://服务器地址:8555`，输入 key 后使用。`AOI_PORT` 是宿主机端口，容器内部仍监听 `3000`。数据挂载到 `/app/data`，不要让多个服务实例共用同一数据目录。

`.env` 用于 Compose 变量替换，不会自动把所有变量传入容器。仓库模板已传入两个功能开关及 `AUTH_KEY`；若要调整上传限制等其他配置，需要在 `compose.yaml` 的 `environment` 中增加对应项，例如 `MAX_UPLOAD_SIZE: "10737418240"`（10 GiB）。数据目录通过 `volumes` 的宿主机路径调整，容器内保持 `/app/data`。

### 前后端分开部署

两个实例使用同一个镜像和启动入口。下面是可直接保存为 `compose.yaml` 的示例（替换上面的单容器模板），在同一台机器分别通过 `8555`、`8556` 访问：

```yaml
services:
  frontend:
    image: ghcr.io/std4453/aoi:${AOI_VERSION:-pr-3}
    platform: linux/amd64
    restart: unless-stopped
    ports:
      - "8555:3000"
    environment:
      FRONTEND_ONLY: "true"
      SERVER_SELECTION_ENABLED: "true"
    volumes:
      - ./frontend-data:/app/data
    stop_grace_period: 45s

  backend:
    image: ghcr.io/std4453/aoi:${AOI_VERSION:-pr-3}
    platform: linux/amd64
    restart: unless-stopped
    ports:
      - "8556:3000"
    environment:
      DATA_DIR: /app/data
      FRONTEND_ONLY: "false"
      SERVER_SELECTION_ENABLED: "false"
      AUTH_KEY: ${AUTH_KEY:-}
    volumes:
      - ./backend-data:/app/data
    stop_grace_period: 45s
```

`.env` 保留 `AOI_VERSION` 和 `AUTH_KEY` 即可；这个示例的端口直接写在 YAML 中，不使用 `AOI_PORT`。启动：

```bash
mkdir -p frontend-data backend-data
sudo chown 1000:1000 frontend-data backend-data
chmod 600 .env
docker compose pull
docker compose up -d
```

打开 `http://服务器地址:8555`，填写别名、后端地址 `http://服务器地址:8556` 和 `.env` 中的 key。纯前端无需额外认证，也不会初始化数据库或写入业务数据；后端默认仍可提供自己的前端页面。

也可以把两个 service 分别放到两台机器的 Compose 文件中，各自启动。浏览器直接连接后端，因此填写的地址必须能从浏览器所在设备访问，不能填写 Docker 内部的 `backend:3000`；手机访问时也不能用指向手机自身的 `localhost`。前端和后端端口都需要可达。公网 HTTPS 前端应连接受信任的 HTTPS 后端，证书配置见下文。

Docker 的 `ports` 发布通常通过转发规则处理，不能仅依赖 UFW 的入站规则限制访问。如果需要由 UFW 直接管理端口，Linux 上可以改用 `network_mode: host`，删除 `ports`，并分别设置 `PORT: "8555"`、`PORT: "8556"`，再放行对应 TCP 端口。

### 更新、停止和本地构建

修改 `.env` 中的镜像版本或配置后运行：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

需要停止服务时执行 `docker compose down`，这会移除容器并保留上述绑定挂载的数据目录。

更新前备份数据；同一数据目录始终只运行一个后端。修改 `.env` 后用 `up -d` 重建受影响的容器，单独 `restart` 不会加载新的容器环境变量。不要提交 `.env` 或运行数据。

本地构建可使用 `docker build --platform linux/amd64 -t aoi .`，随后将 Compose 中的 `image` 改成 `aoi` 并运行 `docker compose up -d`。

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

浏览器 localStorage 保存每条服务器记录的别名、地址和 key。重新打开页面时自动验证最近的服务器；第三个「设置」tab 中的「服务器」项（右侧显示当前别名）进入服务器列表，点击记录直接连接，编辑和删除使用图标按钮。全宽「添加服务器」按钮进入独立表单，一次填写别名、地址和 key（可留空），可以返回列表；首次无记录时直接显示该表单。登录错误通过 toast 提示。切换不删除 key，key 错误时留在登录流程修改。

`/api/health` 公开返回服务标识和是否需要 key；`/api/auth/login` 验证 key 并返回进程有效期内的临时凭证。普通 API 和 tus 使用 Bearer 头，图片、下载和 SSE 使用临时凭证，长期 key 不进入 URL。服务重启会使临时凭证失效；刷新或重新连接后使用保存的 key 登录。反向代理也应避免记录资源 URL 中的 `access_token`。

前端运行配置 `/runtime-config.json` 只暴露服务器选择开关，不暴露 key 或证书配置。业务接口允许跨域访问；CORS 不替代鉴权。

## HTTPS 与证书更新

服务启动时读取 `TLS_CERT_FILE` 和 `TLS_KEY_FILE`，在 `PORT` 指定的端口提供 HTTPS。配置不完整或证书无法加载时启动失败，不回退 HTTP。也可继续由外部反向代理提供 HTTPS。

证书申请和续期由外部工具负责。使用 Compose 时取消证书环境变量及 `./certs:/app/certs:ro` 的注释，挂载包含证书链及私钥的目录，并确保容器 uid 1000 可读取文件。若证书路径是符号链接，也必须挂载其目标文件。更新文件后运行 `docker compose restart aoi`；PM2 则执行 restart。

局域网可使用解析到内网 IP 的域名配合受信任证书。证书必须匹配访问地址并被设备信任；网页无法忽略证书错误。容器健康检查访问本机 `/healthz`，支持 HTTP/HTTPS，且不依赖业务 key 或数据库。

## 从 PM2 迁移到 Docker

`ecosystem.config.cjs` 继续保留，支持上述运行时开关、key 和证书配置。修改环境变量后使用 `pm2 restart ecosystem.config.cjs --update-env`；保持 fork/单实例，不能使用 cluster 或 reload。

迁移步骤：备份持久化数据，停止 PM2 实例，将原 `DATA_DIR` 挂载为容器的 `/app/data`，检查 uid 1000 的读写权限，再启动 Docker。不要同时启动两种部署方式访问同一数据目录。证书续期后重启服务；Docker 环境变量调整后执行 `docker compose up -d`，PM2 则使用 `--update-env` 重启。

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

### 直连只读备机

普通后端默认提供图包快照，后台维护解压后图片/视频的 SHA-256 和展示元数据，不复制
原始压缩包或生成 ZIP。设置 `AOI_SNAPSHOT_ENABLED=false` 可关闭 hash/清单工作及接口。

备机配置 `AOI_REPLICA_SOURCE_URL=https://主机地址`、`AOI_REPLICA_SOURCE_KEY=主机的AUTH_KEY`，
挂载独立空 `DATA_DIR`。默认每 300 秒拉取一次，可用 `AOI_REPLICATION_INTERVAL` 调整（最小 5）。
备机自己的 `AUTH_KEY` 独立控制用户访问；上游 key 只存后端，绝不传给前端。

主备只要求备机能出站访问主机 HTTP(S)，不需要对象存储或反向连接。同步按文件 hash 增量，
下载时继续读取旧图包，安装和缩略图处理期间暂时不可浏览，完成后恢复；主机离线时
仍可浏览本地已处理内容。主备复用原有缩略图任务和目录，不提供整包
下载、压缩、业务写入、级联复制或自动切主。与独立前端部署及服务器选择开关正交。

协议为 `1.0.0`，要求完整版本一致（包括 patch），不依赖构建 commit。可读取的接口位于
`/api/packs/snapshot` 和 `/api/packs/:id/snapshot`。本 PR 仅新增数据库迁移 009，包含快照状态、
安装恢复日志和同步内容变更计数；早期 PR 镜像的测试目录请重新创建。边界、配置、故障与升级约定见
[主备设计文档](docs/replication-design.md)。
