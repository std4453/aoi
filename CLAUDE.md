# Pack Server — 开发指南

## 项目概览

个人图片包下载服务。用户上传 ZIP/RAR 压缩包，服务端解压、生成缩略图、按配置压缩后供下载。

## 技术栈

- **Runtime**: Node.js 22 (ESM, `.js` 扩展名导入)
- **Server**: Fastify 5 + TypeScript
- **Database**: sql.js (WASM SQLite，内存运行，定时落盘)
- **Upload**: tus 协议 (可恢复上传) + `@tus/file-store`
- **Client**: React 19 + TypeScript + Vite 6 + Tailwind CSS 4
- **HTTP Client**: 原生 fetch 封装 (`client/src/api/client.ts`)
- **图片处理**: Sharp (缩略图、压缩、blurhash 计算)
- **Blurhash**: `blurhash` npm 包 (编码服务端 + 解码客户端，图片加载占位)
- **压缩包处理**: Archiver (生成 ZIP)、7z-bin / unrar (解压)
- **图标**: Lucide React (统一 16px)
- **图片缩放**: react-zoom-pan-pinch v4 (双击/双指缩放、拖动平移)

## 开发流程

```bash
# 开发模式 (server:3000 + client:5173，热重载)
npm run dev

# 生产构建
npm run build        # client → server/public，server → server/dist/server/src
npm run start        # node server/dist/server/src/index.js
```

- Vite dev server 代理 `/api/*` 和 `/files/*` 到 `localhost:3000`
- Server 使用 `tsx watch`，修改后自动重启
- Client 使用 Vite HMR，修改后热更新

## 目录结构

```
pack-server/
├── shared/types.ts          # 前后端共享类型 (Pack, Tag, Preset, Job, ...)
├── server/
│   └── src/
│       ├── index.ts             # Fastify 入口，注册路由和插件
│       ├── config.ts            # Zod 校验的配置，默认端口 3000
│       ├── types.ts             # 重导出 shared/types.ts
│       ├── db/
│       │   ├── connection.ts    # sql.js 初始化，5s 定时落盘
│       │   ├── migrations.ts    # 迁移运行器（类型定义 + runMigrations + 导入列表）
│       │   ├── migrations/      # 独立迁移脚本（每个文件一个 migration）
│       │   │   ├── 001_add_compressed_size.ts
│       │   │   ├── 002_add_structure_type.ts
│       │   │   └── 003_add_blurhashes_and_backfill.ts
│       │   ├── repositories.ts  # 所有 CRUD 操作
│       │   └── schema.sql       # 初始建表 (packs, presets, jobs, uploads, tags, pack_tags)
│       ├── plugins/tus.ts       # tus 上传插件
│       ├── routes/
│       │   ├── packs.ts         # 图包 CRUD + 图片/缩略图/封面服务
│       │   ├── presets.ts       # 压缩预设 CRUD
│       │   ├── processing.ts    # 压缩任务提交 + SSE 进度推送
│       │   ├── download.ts      # 压缩包下载
│       │   └── system.ts        # 系统信息 (磁盘空间等)
│       └── services/
│           ├── job-queue.ts         # 串行任务队列 (extract → thumbnail → compress)
│           ├── archive-extractor.ts # ZIP/RAR 解压 + 目录结构检测
│           ├── thumbnail-generator.ts
│           ├── image-compressor.ts
│           ├── archive-generator.ts # 生成最终 ZIP
│           └── storage.ts           # 路径工具函数
├── client/
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                # 路由定义 (lazy load)
│       ├── api/
│       │   ├── client.ts          # fetch 封装 (get/post/put/patch/del)
│       │   ├── packs.ts           # 图包 API
│       │   ├── presets.ts         # 预设 API
│       │   └── jobs.ts            # 任务 API + SSE
│       ├── pages/
│       │   ├── HomePage.tsx        # 图包列表，多关键词搜索
│       │   ├── UploadPage.tsx      # 上传 (tus + 表单)
│       │   ├── PackDetailPage.tsx  # 图包详情 + 压缩配置
│       │   ├── PresetsPage.tsx     # 压缩预设管理
│       │   ├── TagManagerPage.tsx  # 标签管理
│       │   ├── SettingsPage.tsx    # 系统设置
│       │   └── DBNavigatorPage.tsx # DB 调试工具
│       ├── components/
│       │   ├── layout/AppShell.tsx # 侧边栏布局
│       │   ├── ImageViewer.tsx     # 全屏图片浏览 (ImagePool + Blurhash)
│       │   ├── ImagePool.ts       # 图片预加载对象池 (纯 TS 类)
│       │   ├── BlurhashPlaceholder.tsx # Blurhash 占位图组件
│       │   ├── FileTreePanel.tsx   # 文件结构浏览/选择 (底部面板)
│       │   ├── BottomPanel.tsx     # 底部面板通用组件 (slide-up 动画)
│       │   ├── Modal.tsx           # 居中弹窗通用组件 (opacity+scale 动画)
│       │   └── TagSelector.tsx     # 标签选择弹窗
│       ├── hooks/                  # usePacks, usePresets, useUpload, useJobProgress, useImagePool
│       ├── lib/utils.ts            # formatBytes, formatDate, statusLabels/Colors
│       └── styles/globals.css      # Tailwind 入口
└── data/                       # 运行时数据 (gitignore)
    ├── archives/               # 原始压缩包
    ├── extracted/              # 解压文件 (images/, thumbnails/, videos/)
    ├── generated/              # 压缩结果
    ├── uploads/                # tus 上传临时目录
    └── db/packdb.sqlite        # SQLite 数据库文件
```

## 数据模型

### Pack 状态机

```
uploading → extracting → thumbnailing → extracted → generating → generated
    ↓           ↓           ↓              ↓          ↓
  failed       failed      failed        failed     failed
```

### 关键表

- **packs**: 图包元数据 + 状态 + 统计 (图片数/视频数/大小)
- **tags**: 标签 (name UNIQUE)
- **pack_tags**: 多对多关联
- **presets**: 压缩预设 (options 为 JSON)
- **jobs**: 任务队列 (串行，状态: pending → running → completed/failed)
- **uploads**: tus 上传记录

## 开发注意事项

### 数据库
- sql.js 运行在内存中，每 5 秒 `saveDb()` 写入磁盘。**内存中的 DB 是权威来源，磁盘文件可能过期**。
- 不要直接修改磁盘上的 `.sqlite` 文件——必须先停止服务，否则定时保存会覆盖。
- 所有数据库结构变更和数据回填必须通过 migration 系统执行，不要在 `connection.ts` 或其他地方直接写 `ALTER TABLE`。

### Migration 系统

数据库结构变更通过 `server/src/db/migrations.ts` 管理，采用有序、幂等、有追踪的迁移机制。

**架构**：
- 每个迁移是 `server/src/db/migrations/` 下的独立 `.ts` 文件，命名格式 `NNN_描述.ts`（如 `004_add_new_column.ts`）
- 每个文件 export default 一个 `Migration` 对象（`name` + `up(db)`），使用 `satisfies Migration` 确保类型正确
- `migrations.ts` 是运行器：定义 `Migration` 类型 + 导入所有迁移文件 + `runMigrations(db)` 函数
- 新增迁移时需在 `migrations.ts` 的导入列表和数组中追加条目
- 数据库中的 `migrations` 表记录已执行的 migration（`name` + `executed_at`）
- 执行流程：创建 migrations 表（IF NOT EXISTS）→ 查询已执行记录 → 按顺序执行未运行的 migration → 逐条记录完成状态

**约束**：
- migration 必须幂等（`up()` 内部检查变更是否已存在，如 `columnExists()` 检查列是否存在）
- migration 按顺序执行，不可跳过
- 如果某个 migration 抛异常，停止执行且不记录为已完成，应用不启动
- `schema.sql` 仅负责初始建表（`CREATE TABLE IF NOT EXISTS`），增量变更一律走 migration

**新增 migration 流程**：
1. 在 `server/src/db/migrations/` 下创建新文件，如 `004_add_new_column.ts`
2. 导出 `Migration` 对象：`export default { name: '004_add_new_column', up(db) { ... } } satisfies Migration;`
3. `up()` 中实现结构变更（`ALTER TABLE`）和数据回填（`UPDATE`），内部做幂等检查
4. 在 `migrations.ts` 中添加导入和数组条目
5. 测试：启动应用观察 `[migration]` 日志，重启确认不重复执行

### 目录结构检测
- 解压后分析临时目录：无子目录 → flat；单个包裹目录且无散落文件 → flat（剥离包裹层）；其他 → structured（保留相对路径）。
- 缩略图、压缩图、ZIP 内路径都镜像原始目录结构。
- 所有文件服务路由使用 `*` 通配参数 + `path.resolve` 穿越校验。

### 任务队列
- 全局串行（同一时间只有一个 job 在运行）。
- 提取完成后自动入队缩略图任务。
- 服务启动时，状态为 `thumbnailing` 的 pack 会自动入队缩略图任务（`extracted` 不会重新入队）。
- 任务失败会更新 pack 状态为 `failed`。

### 前端路由

所有页面在 `AppShell` 布局内渲染，使用 `React.lazy()` 按需加载。

| 路径 | 页面 | 说明 |
|------|------|------|
| `/` | `HomePage` | 图包列表，多关键词搜索 |
| `/upload` | `UploadPage` | 上传 (tus + 表单) |
| `/packs/:id` | `PackDetailPage` | 图包详情 + 压缩配置 |
| `/packs/:id?image=N` | `PackDetailPage` | 图包详情 + ImageViewer 打开在第 N 张 |
| `/presets` | `PresetsPage` | 压缩预设管理 |
| `/settings` | `SettingsPage` | 系统设置 |
| `/settings/tags` | `TagManagerPage` | 标签管理 |

### 前端
- API 封装在 `api/client.ts`，`post()` 发送 JSON 时即使 body 为空也必须传 `{}`，否则 Fastify 返回 400 (FST_ERR_CTP_EMPTY_JSON_BODY)。
- 页面使用 `React.lazy()` 按需加载。
- `PackDetailPage` 中状态轮询：`extracting`/`thumbnailing` 期间每秒刷新元数据，`thumbnailing → extracted` 转换时加载缩略图。**注意 React effect 顺序**：检查状态转换的 effect 必须在更新 ref 的逻辑之前执行。
- `useRef` + `useEffect` 顺序陷阱：多个 effect 依赖同一状态时，按定义顺序执行。如果先更新 ref 再检查旧值，检查会失败。

### UI 约定
- 深色主题，使用 Tailwind CSS 4。
- 图标统一使用 Lucide React，默认 16px。
- 中文 UI 文案（状态标签、按钮文字、提示信息等）。
- 表单控件（checkbox 等）使用自定义样式，不用浏览器原生样式。

### 通用弹窗组件
- **BottomPanel** (`components/BottomPanel.tsx`)：底部滑出面板，用于 FileTreePanel、TagSelector 等。
  - `visible` 控制显隐，组件管理 enter/exit 动画状态（`hidden → entering → open → exiting → hidden`）
  - `keepMounted`：为 true 时关闭后用 `visibility:hidden` 保留 DOM（用于 FileTreePanel，保持滚动位置和展开状态），为 false 时退出动画后卸载
  - `onClose`：通知父组件关闭，`onEntered`：入场动画完成回调，`onClosed`：退出动画完成回调
  - 动画定义在 `globals.css`：`.bottom-panel-enter` / `.bottom-panel-exit`（slide-up/down + backdrop fade）
- **Modal** (`components/Modal.tsx`)：居中弹窗，用于重命名、删除确认、标签详情等。
  - 同样的 `visible` / `onClose` / `onClosed` 接口
  - `className` 可扩展（如 `max-h-[80vh] flex flex-col`）
  - 动画：opacity + scale + translateY（`.modal-enter` / `.modal-exit`）
- 使用模式：父组件用 `null | 'open' | 'closing'` 三态管理弹窗。`onClose` 设为 `'closing'` 触发退出动画，`onClosed` 设为 `null` 卸载组件。需要 `keepMounted` 时可简化为 `null | 'open'`，关闭时直接设 `null`。

### 长图处理
- **判定规则**：`height > width * 3`（ImageViewer 和 image-compressor 统一使用此阈值）
- **ImageViewer**：长图使用纵向滚动浏览（`overflow-auto`），非长图使用 `object-contain` 适配
- **压缩缩放**：长图只看宽度是否超过 `maxDimension`，忽略高度，避免长图被不当缩放。非长图正常按长边判断

### Blurhash 占位图

Blurhash 在图片加载前提供模糊色彩占位，提升 ImageViewer 和缩略图网格的视觉体验。

**服务端（计算 + 存储）**：
- 缩略图生成时同步计算 blurhash（`thumbnail-generator.ts` → `computeBlurhash()`）
- Sharp 管道：`.resize(64, 64, { fit: 'inside', withoutEnlargement: true }).toColorspace('srgb').raw().ensureAlpha()`
- 编码参数：`BLURHASH_COMPONENTS_X = 4, BLURHASH_COMPONENTS_Y = 3`
- 结果存入 DB `packs.blurhashes` 列（JSON: `{ "NR/scene.jpg": { hash, width, height } }`）
- 单图失败不阻断流程（try-catch 返回 null）
- DB 列通过 migration `003_add_blurhashes_and_backfill` 添加

**API 返回**：
- `GET /api/packs/:id/thumbnails` 每项包含 `blurhash`, `width`, `height`
- blurhash 数据从 DB 读取，不重复计算

**客户端（解码 + 渲染）**：
- `BlurhashPlaceholder` 组件：`<div>` + `background-image` + `background-size: contain/cover`
- 不使用 `<img>` + `object-fit`，因为容器尺寸依赖图片加载，未加载时为 0x0
- 解码分辨率：短边 32px，按比例计算长边（`BlurhashPlaceholder.tsx` → `blurhashToDataUrl()`）
- 缓存：`Map<string, string>`（hash → data URL），页面级持有（`PackDetailPage` 的 `blurhashCache` ref），组件卸载时释放
- 预计算：`PackDetailPage` 在 `useEffect` 中遍历 thumbnails 预填充缓存，避免 ImageViewer 切换时计算延迟

### ImagePool 预加载池

ImageViewer 切换图片时，从对象池直接取出已加载的 `HTMLImageElement` 挂载到 DOM，避免网络等待。详见 `ImagePool.ts`、`useImagePool.ts`。

**核心类 `ImagePool`**（纯 TypeScript，无 React 依赖）：
- **池**：`Map<number, PoolEntry>`，每个条目持有 `HTMLImageElement` + 加载状态 + 重试计数
- **加载队列**：`queue: number[]` + `activeLoads: Set<number>`（上限 3 并发）
- **预加载顺序**：`+1, +2, -1, +3, +4, -2, -3, +5, -4, -5`（跳过已加载/加载中/越界）
- **超时**：2s 不中断加载，只让出并发槽位
- **淘汰**：距离当前 > ±10 的条目释放 `img.src=''` 并移除
- **重试**：当前图片 failed 且 retryCount < 2 → 重新入队头部；预加载 failed 不重试

**切换 currentIndex 时**（`setCurrent()`）：
1. 淘汰远距离条目
2. 清空 queue（保留 activeLoads 中的进行中加载）
3. 当前图片未 loaded → 加入队列头部
4. 按预加载顺序追加
5. `processQueue()`

**React 集成 `useImagePool(images, currentIndex)`**：
- `useRef` 持有 ImagePool 实例，`imagesRef` 模式避免 images 变化导致 pool 重建
- currentIndex 变化时通过 `useEffect` 调用 `pool.setCurrent(index)`
- `onStateChange` 回调触发 `setRevision` 强制重渲染
- **同步检测 `wasAlreadyLoaded`**：在渲染函数体中（非 useEffect）检测 index 变化，读取 pool 状态，避免 useEffect 异步延迟
- 返回 `{ currentImg, imageLoaded, wasAlreadyLoaded }`

**DOM 挂载**：
- `<div ref={imgContainerRef}>` 替代 `<img>`
- `useLayoutEffect`（非 `useEffect`）挂载 pooled image：清空容器 → appendChild，在浏览器 paint 前同步执行，防止空白帧闪烁
- 图片未预加载完成时显示 BlurhashPlaceholder，加载完成后 150ms opacity 渐入（仅未预加载时；已预加载的直接显示，无动画）

### 文件结构浏览 (FileTreePanel)
- 仅 `structureType === 'structured'` 的图包显示文件结构相关 UI
- 两种模式：`view`（浏览，点击图片定位到 ImageViewer）和 `select`（多选，选择压缩范围）
- `expandedPaths` 由父组件持有（`Set<string> | null`），跨面板开闭保持展开状态
- `focusPath` 使用完整文件路径（如 `NR/scene.png`），通过 `data-tree-path` 属性 DOM 定位
- 滚动使用 `scrollIntoView({ block: 'center', container: 'nearest' })`，`container: 'nearest'` 允许在动画期间正确滚动
- `keepMounted` 模式下，面板隐藏时 `focusPath` 仍跟随当前图片变化，用 `behavior: 'instant'` 预滚动；面板可见时用 `behavior: 'smooth'`
- Sticky 文件夹头：`position: sticky` + `top: depth * 36 - 5`（-5 补偿容器 padding）

### 构建部署
- `npm run build` 将前端构建到 `server/public`，后端编译到 `server/dist/server/src/`。
- Fastify 在生产模式下直接 serve 静态文件，非 `/api` 路径回退到 `index.html`（SPA fallback）。
- 构建后需手动复制 `server/src/db/schema.sql` 到 `server/dist/server/src/db/schema.sql`（已包含在 build:server 脚本中）。
- 启动入口：`node server/dist/server/src/index.js`。

### 生产部署 (pm2)
- **进程管理**：pm2 守护，配置文件 `ecosystem.config.cjs`
- **数据目录**：`~/srv/pack-service/`（archives、extracted、generated、uploads、db）
- **端口**：Fastify 直接监听 `0.0.0.0:8555`，无需 nginx 反代
- **环境变量**：通过 ecosystem.config.cjs 中的 `env` 设置（PORT、HOST、DATA_DIR）

```bash
# 部署流程
npm run build                          # 构建前后端
pm2 start ecosystem.config.cjs         # 启动服务

# 常用命令
pm2 status                             # 查看进程状态
pm2 logs pack-server                   # 查看日志
pm2 restart pack-server                # 重启
pm2 stop pack-server                   # 停止
pm2 save                               # 保存进程列表（配合 pm2 startup 实现开机自启）
```
