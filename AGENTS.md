# Repository Guidelines

## 项目结构与模块划分

AoI 是基于 Node.js 22 的 TypeScript 项目，主要分为三部分：

- `client/src/`：React/Vite 前端。页面放在 `pages/`，通用组件放在 `components/`，接口封装放在 `api/`，自定义 Hook 放在 `hooks/`。
- `server/src/`：Fastify 服务端。接口路由放在 `routes/`，文件处理与队列放在 `services/`，better-sqlite3 连接、仓储和迁移放在 `db/`。
- `server/test/`：Node test runner + tsx 回归测试，覆盖数据库持久性、单实例锁、仓储事务与安全路径。
- `shared/types.ts`：前后端共用的数据类型与接口契约。

运行数据位于已忽略的 `data/`。不要提交构建产物 `server/public/`、`server/dist/` 或运行时数据。

## 构建、测试与开发命令

首次开发需分别安装三个包的依赖：

```bash
npm install
npm --prefix server install
npm --prefix client install
```

- `npm run dev`：同时启动 Fastify（3000 端口）和 Vite（5173 端口），支持热更新。
- `npm run build`：构建前端到 `server/public/`，随后编译服务端。
- `npm test`：串行运行服务端 `*.test.ts` 回归测试。
- `npm run check`：依次执行完整构建和测试，提交前必须通过。
- `npm run start`：启动已编译的生产服务。
- `npm run build:client`、`npm run build:server`：单独检查前端或服务端构建。

测试 RAR、7z 或加密压缩包前，系统需提供 `7z`；普通 ZIP 测试无需系统命令。

## 编码风格与命名规范

遵循现有 TypeScript 风格：严格类型、两空格缩进、单引号、分号，多行结构保留尾逗号。React 组件使用 `PascalCase`，Hook 使用 `useCamelCase`，变量和函数使用 `camelCase`，服务端模块文件使用 kebab-case。服务端采用 ESM；即使源文件是 TypeScript，本地导入也必须写 `.js` 扩展名。前后端共用类型统一维护在 `shared/types.ts`。

数据库变更必须新增有序、幂等的迁移文件，例如 `server/src/db/migrations/006_add_field.ts`，并在 `migrations.ts` 中注册。

## 测试要求

测试使用 Node 内置 test runner，由 tsx 执行。文件命名为 `server/test/**/*.test.ts`；涉及持久化时必须使用独立临时 `DATA_DIR` 并在测试后清理。数据库、迁移、任务恢复或文件路径变更应补充回归用例。提交前运行 `npm run check`；压缩流程还应手动验证上传、预览、生成和下载。

## 提交与合并请求规范

现有提交使用简短、祈使语气的英文句式，例如 `Fix file tree panel scroll behavior`。每个提交只处理一个逻辑变更。

合并请求应说明用户可见变化、实现风险和验证方式，并关联相关 Issue。界面改动需附截图；新增环境变量、依赖或数据库迁移时必须明确标注。

## 安全与配置

部署通过环境变量配置；`DATA_DIR` 必须指向持久卷且同一时间只能由一个实例使用。禁止提交 `.env`、数据库、压缩包及 `data/` 内容。新增文件接口必须复用 `safe-path.ts`，数据库结构变更必须走迁移。PM2 保持 fork/单实例并使用 restart；Docker 必须挂载 `/app/data`。
