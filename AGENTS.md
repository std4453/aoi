# Repository Guidelines

## 项目结构与模块划分

AoI 是基于 Node.js 22 的 TypeScript 项目，主要分为三部分：

- `client/src/`：React/Vite 前端。页面放在 `pages/`，通用组件放在 `components/`，接口封装放在 `api/`，自定义 Hook 放在 `hooks/`。
- `server/src/`：Fastify 服务端。接口路由放在 `routes/`，文件处理与队列放在 `services/`，better-sqlite3 连接、仓储和迁移放在 `db/`。
- `server/test/`：Node test runner + tsx 回归测试，覆盖数据库持久性、单实例锁、仓储事务与安全路径。
- `shared/types.ts`：前后端共用的数据类型与接口契约。
- `scripts/`：离线维护工具；恢复脚本必须保持默认只读源数据、输出到新目录。

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

遵循现有 TypeScript 风格：严格类型、两空格缩进、单引号、分号，多行结构保留尾逗号。React 组件使用 `PascalCase`，Hook 使用 `useCamelCase`，变量和函数使用 `camelCase`，服务端模块文件使用 kebab-case。服务端采用 ESM；TypeScript 源码中的相对模块导入省略扩展名，目录中的 `index.ts` 可直接用目录路径导入。构建使用 `tsc` 后运行 `tsc-alias`，为产物补全 `.js` 或 `/index.js`；通过 `npm run build:server` 或服务端的 `npm run build` 执行完整构建。前后端共用类型统一维护在 `shared/types.ts`。

数据库变更必须新增有序、幂等的迁移文件，例如 `server/src/db/migrations/006_add_field.ts`，并在 `server/src/db/migrations/index.ts` 中注册。

服务端的 `~/` 指向 `server/src/`。同目录或子目录使用简短的 `./…` 导入；跨目录引用服务端模块时优先使用 `~/…`，例如 `~/db/connection`。共享类型统一通过 `~/types` 导入，由 `server/src/types.ts` 转出；别名不用于文件系统路径或 `new URL()`。开发与测试使用服务端的 tsconfig，编译产物中的别名由 `tsc-alias` 转为相对路径。

共享任务错误类与工具通过 `~/task-errors` 导入，由 `server/src/task-errors.ts` 转出；操作系统、压缩包等服务端错误的转换逻辑保留在 `services/task-errors.ts`。

## 测试要求

测试使用 Node 内置 test runner，由 tsx 执行。文件命名为 `server/test/**/*.test.ts`；涉及持久化时必须使用独立临时 `DATA_DIR` 并在测试后清理。数据库、迁移、任务恢复或文件路径变更应补充回归用例。提交前运行 `npm run check`；压缩流程还应手动验证上传、预览、生成和下载。

## 分支、提交与合并请求规范

完整规范与示例见 [CONTRIBUTING.md](CONTRIBUTING.md)。新工作分支使用 `<type>/<description>`，例如 `feat/pack-tags`、`fix/storage-size-units`；描述使用小写英文和连字符，可选加 Issue 编号。人工开发与自动化代理统一使用此格式，不再为新分支添加 `codex/` 前缀。已有分支与历史提交无需改名或改写。

新提交与 PR 标题采用 Conventional Commits：`<type>[optional scope][!]: <description>`，例如 `feat: add pack tags`、`fix(client): restore file tree scrolling`。类型使用 `feat`、`fix`、`docs`、`refactor`、`perf`、`test`、`build`、`ci`、`style`、`chore` 或 `revert`；scope 可选，优先使用 `client`、`server`、`shared`、`db`、`scripts`。描述使用简短的英文祈使句，以小写动词开头，不加句号，标题建议不超过 72 个字符。每个提交只处理一个逻辑变更。不兼容变更添加 `!` 和说明迁移方式的 `BREAKING CHANGE:` 页脚。平台自动生成的 merge commit 可保留默认标题。

合并请求应说明用户可见变化、实现风险和验证方式，并关联相关 Issue。界面改动需附截图；新增环境变量、依赖或数据库迁移时必须明确标注。

## 安全与配置

开发、测试、问题排查和复现过程中，除非用户明确要求，禁止访问线上服务数据，包括线上服务 API 和线上服务所部署的文件位置，只允许在本地启动开发用服务。

部署通过环境变量配置；`DATA_DIR` 必须指向持久卷且同一时间只能由一个实例使用。禁止提交 `.env`、数据库、压缩包及 `data/` 内容。新增文件接口必须复用 `safe-path.ts`，数据库结构变更必须走迁移。PM2 保持 fork/单实例并使用 restart；Docker 必须挂载 `/app/data`。
