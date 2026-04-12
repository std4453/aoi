# AoI - 你的本地图片管家

> 本项目由 妄想天使 AoD 独家赞助，关注妄想天使谢谢喵~

AoI（Angel of Images），你的本地图片管家。

下载了很多图包太占地？图片太大内存爆炸？AoI 让你一个平台管理所有图片，本地轻装上阵，需要时在线浏览 / 下载到本地，样样齐全。

## 功能

- **上传** — 支持 ZIP / RAR / 7z 格式，基于 tus 协议的可恢复上传
- **解压** — 自动解压并检测目录结构（扁平 / 嵌套）
- **缩略图** — 自动生成缩略图 + Blurhash 占位图
- **压缩** — 可配置 JPEG 质量、最大尺寸、是否保留视频
- **预设** — 保存常用压缩参数，一键应用
- **标签** — 为图包添加标签，支持搜索过滤
- **文件树** — 嵌套结构的图包可浏览和选择性压缩

## 技术栈

- **Runtime**: Node.js 22 (ESM)
- **Server**: Fastify 5 + TypeScript
- **Database**: sql.js (WASM SQLite，内存运行，定时落盘)
- **Client**: React 19 + TypeScript + Vite 6 + Tailwind CSS 4
- **图片处理**: Sharp (缩略图、压缩、Blurhash)
- **压缩包**: yauzl / 7z-bin / unrar (解压) + Archiver (打包)

## 环境要求

- Node.js >= 22
- 系统需安装 `p7zip-full` 和 `unrar`（用于 RAR/7z 解压和 ZIP fallback）

```bash
# Debian/Ubuntu
sudo apt-get install -y p7zip-full unrar

# macOS
brew install p7zip unrar
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

### 数据目录结构

```
data/
├── archives/      # 原始上传的压缩包
├── extracted/     # 解压后的文件 (images/, thumbnails/, videos/)
├── generated/     # 压缩结果
├── thumbnails/    # 缩略图
├── uploads/       # tus 上传临时文件
└── db/            # SQLite 数据库文件
```

## 使用 pm2 部署

项目包含 `ecosystem.config.cjs`，可直接用 pm2 管理：

```bash
# 构建
npm run build

# 启动
pm2 start ecosystem.config.cjs

# 常用命令
pm2 status
pm2 logs aoi
pm2 restart aoi
pm2 save
```

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
# 构建
npm run build
docker build -t aoi .

# 运行
docker run -d \
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
│       ├── db/               # 数据库 (sql.js)
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

## License

MIT
