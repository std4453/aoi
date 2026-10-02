# 贡献指南

本项目采用 Conventional Commits 提交格式，工作分支采用 `<type>/<description>` 格式，例如 `feat: add pack tags` 和 `feat/pack-tags`。以下约定适用于新提交和新分支；无需重命名已有分支或改写历史提交。

## 分支命名

从目标分支创建短期工作分支，一个分支集中处理一个任务，通过 Pull Request 合并。命名格式为：

```text
<type>/<description>
<type>/<issue-number>-<description>
```

- `type` 从下方类型表中选择，反映分支的主要目的。
- `description` 使用简短的小写英文，以连字符分词（kebab-case），不使用空格、下划线或额外的 `/`。
- Issue 编号可选，例如 `fix/123-preview-path`；不要为了命名创建 Issue。
- 人工开发与自动化代理使用相同格式，代理新建分支时也直接使用 `feat/xxx`、`fix/xxx` 等前缀。
- 长期维护分支（如 `main`）不适用此格式。

示例：

```text
feat/pack-tags
fix/storage-size-units
refactor/replica-installation
docs/git-conventions
```

## Commit 命名

```text
<type>[optional scope][!]: <description>

[optional body]

[optional footer(s)]
```

`type` 使用小写，冒号后保留一个空格。标题描述使用简短的英文祈使句，以小写动词开头，不加句号，建议整行不超过 72 个字符。每个提交只处理一个逻辑变更；需要说明动机、限制或验证方式时，在空行后的正文补充。

### 类型

同一套类型用于分支前缀和 Commit；单个提交的类型按实际内容选择，不要求与所在分支一致。

| 类型 | 适用变更 | Commit 示例 |
| --- | --- | --- |
| `feat` | 新增功能或能力 | `feat(client): add pack tag filters` |
| `fix` | 修复错误 | `fix(server): correct storage size units` |
| `docs` | 仅修改文档 | `docs: document branch naming conventions` |
| `refactor` | 不新增功能、不修复错误的代码重构 | `refactor(server): share replica installation logic` |
| `perf` | 性能优化 | `perf(server): cache storage size statistics` |
| `test` | 新增或调整测试 | `test(db): cover migration idempotency` |
| `build` | 构建流程、依赖或打包调整 | `build(server): include runtime assets` |
| `ci` | 持续集成工作流调整 | `ci: run checks on pull requests` |
| `style` | 不影响行为的格式调整 | `style(client): normalize import formatting` |
| `chore` | 不属于以上类型的其他维护工作 | `chore: update ignore patterns` |
| `revert` | 撤销已有变更 | `revert: undo storage size caching` |

界面样式的功能改动或错误修复使用 `feat` 或 `fix`；`style` 仅表示代码格式调整。依赖升级通常使用 `build`，若提交主要用于修复具体故障，可使用 `fix`。不要把可以明确归类的改动都写成 `chore`。

### Scope（可选）

简单提交可以直接写 `feat: ...`。范围有助于定位时，优先使用项目现有模块名：`client`、`server`、`shared`、`db`、`scripts`。只有在这些范围不够清晰时才增加其他简短的小写范围；跨模块的整体变更可以省略 scope。

```text
feat: add pack export
fix(client): restore file tree scrolling
fix(db): preserve transaction atomicity
docs: clarify local development setup
```

### 不兼容变更与关联 Issue

破坏已有 API、配置或使用方式的变更在冒号前加 `!`，并在正文之后使用 `BREAKING CHANGE:` 页脚说明影响和迁移方式。数据库新增迁移本身不必然代表不兼容变更。

```text
feat(server)!: require explicit replica configuration

Reject replica startup when the source URL is missing.

BREAKING CHANGE: Replica deployments must set REPLICA_SOURCE_URL before startup.
Closes #123
```

以上是格式示例，不代表项目新增了该配置要求。普通提交也可以通过 `Closes #123` 关联实际解决的 Issue。撤销提交使用 `revert`，并在正文注明被撤销的提交 SHA 和原因。

## Pull Request 与验证

- PR 标题采用相同的 Commit 格式，便于 squash 合并时直接作为提交标题；本约定不强制更改仓库合并策略。
- PR 说明用户可见变化、实现风险和验证方式，并关联相关 Issue。界面改动需附截图；新增环境变量、依赖或数据库迁移时必须明确标注。
- 提交前运行 `npm run check`；压缩流程还应手动验证上传、预览、生成和下载。其他开发、安全与测试要求见 [AGENTS.md](AGENTS.md)。
- Git 平台自动生成的 merge commit 标题可保留默认格式；手工编写的提交和 squash 提交遵守上述规范。

目前通过文档和代码审查执行约定，不引入 Git hooks、commitlint 或分支校验工作流。

## 选择依据

- [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) 定义了 `type(scope)!: description` 结构以及不兼容变更标记；其中 `feat` 和 `fix` 有明确含义，也允许其他类型。本项目在此基础上约定类型表、英文标题和可选 scope，暂不引入自动版本发布。
- [GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow) 推荐使用简短、描述明确的分支名，并通过 PR 审查和合并。`<type>/<description>` 是本项目结合提交类型选用的命名约定，并非 Conventional Commits 对分支的要求。
- [Git 分支引用规则](https://git-scm.com/docs/git-check-ref-format) 允许使用 `/` 分组；本项目进一步限制为小写英文与连字符，保持名称容易输入和辨认。
