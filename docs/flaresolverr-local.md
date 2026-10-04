# FANBOX 可选 FlareSolverr

默认不启用。配置 `AOI_FLARESOLVERR_URL` 后，FANBOX 元数据请求遇到 Cloudflare challenge 或 HTML 拦截响应时尝试一次 FlareSolverr；普通 JSON 权限错误、限流、网络错误不触发。不开启、服务不可用或仍未通过验证都会明确报错，不循环重试。浏览器登录与这个选项独立，Cookie 仍通过原有设置提供。

## 本地启动

要求 Docker Desktop / Docker 和 Node.js 22。镜像基于固定 digest 的官方 FlareSolverr 3.5.2，自动匹配 Docker 的 CPU 架构。仓库提供的最小补充保留 Chromium 沙箱、TLS 校验与本地网络检查，并为固定 FANBOX `post.info` 端点设置 Origin、Referer、Accept。原镜像忽略自定义请求头，单独启动它可能得到 FANBOX API 错误。

```bash
# 如 Docker / Node 未在 PATH 中，先加入本机安装路径。
AOI_PROXY_URL=http://127.0.0.1:8888 node scripts/flaresolverr/dev.mjs up
node scripts/flaresolverr/dev.mjs status
```

启动器只创建 `aoi-flaresolverr-dev` 容器和本地构建时的 `aoi-flaresolverr:local` 镜像。端口 `127.0.0.1:43132` 必须空闲；已有同名容器不会被覆盖。镜像拉取遵循 Docker 自身网络配置。启动器复用仓库中的 Docker 默认 seccomp 补充规则，只额外允许 Chromium 沙箱需要的 clone/unshare/setns；不使用 privileged、SYS_ADMIN 或 seccomp=unconfined。

官方镜像已在本地以其他名称导入时，可通过 `AOI_FLARESOLVERR_BASE_IMAGE` 指定该镜像；补充脚本会在预期代码不匹配时终止构建。这个选项仅用于本地镜像准备，不是 AoI 的运行配置。

CI 总是构建并测试 amd64 / arm64 镜像，受信任事件自动发布 `ghcr.io/std4453/aoi-flaresolverr`，标签规则见[浏览器服务文档](browser-login-local.md#ci-镜像)。测试已发布产物时无需重新构建：

```sh
docker pull ghcr.io/std4453/aoi-flaresolverr:pr-<编号>
node scripts/flaresolverr/dev.mjs down
AOI_FLARESOLVERR_IMAGE=ghcr.io/std4453/aoi-flaresolverr@sha256:<digest> \
  node scripts/flaresolverr/dev.mjs up
AOI_FLARESOLVERR_IMAGE=ghcr.io/std4453/aoi-flaresolverr@sha256:<digest> \
  node scripts/flaresolverr/smoke.mjs
```

离线 smoke 使用无外网容器中的合成 JSON 服务，检查真实浏览器请求和临时进程清理，不访问 FANBOX 或用户数据。

启动或重启本地 AoI 时设置：

```bash
export AOI_FLARESOLVERR_URL=http://127.0.0.1:43132
export AOI_FLARESOLVERR_PROXY_URL=http://host.docker.internal:8888
export AOI_PROXY_URL=http://127.0.0.1:8888
# 按现有方式启动使用独立 DATA_DIR 的本地 AoI。
# 已运行 scripts/browser-login/dev.mjs 的联调实例可保持原 LAN 配置后执行：
node scripts/browser-login/dev.mjs restart
```

`AOI_FLARESOLVERR_PROXY_URL` 是容器能访问的出站代理地址；未设置时继承 `AOI_PROXY_URL`。容器里的 127.0.0.1 不是宿主机，Docker Desktop 使用 `host.docker.internal`。当前临时 request.get 模式不支持带账号密码的代理 URL；配置时会明确拒绝，不悄悄直连。AoI 到 solver 的控制请求直接发送，不经过出站代理。

| 配置 | 默认 | 用途 |
| --- | --- | --- |
| `AOI_FLARESOLVERR_URL` | 未启用 | 受信任的 HTTP(S) 服务 origin，不带 `/v1`、账号密码、查询参数 |
| `AOI_FLARESOLVERR_PROXY_URL` | 继承 `AOI_PROXY_URL` | solver 浏览器使用的出站代理 |

控制接口没有独立身份验证，本地启动器只绑定回环，不提供网页入口。服务会收到 FANBOX 会话和请求的元数据，必须受信任；远程部署需要单独规划私网/认证和加密边界。

## 请求、凭据与清理

同一 AoI 进程最多一个求解请求，其他请求明确提示稍后重试。每次创建临时浏览器，不保留 solver session、Cookie 缓存或浏览器配置；求解阶段上限 60 秒，AoI 请求上限 65 秒。用户取消时 AoI 停止等待，并在原 65 秒期限内保持占用；FlareSolverr 没有单请求取消 API，其临时浏览器由服务端超时清理。上游浏览器启动和销毁不包含在求解超时内，如果进程异常卡住，需要停止独立容器进行清理。

只传递 FANBOXSESSID，不发送 Pixiv Cookie、token 或其他凭据。只接受目标 URL 未变化且包含 FANBOX JSON 的响应，再执行现有帖子结构与权限检查。不会把 FlareSolverr 的 HTTP 200 或 `status: ok` 当作授权成功。合法的新 FANBOX 会话沿用原有比较后保存逻辑，不覆盖用户并发修改，也不写入外部 Cookie 文件。服务错误不会回显上游原文或凭据。

容器禁用 Docker 日志及 HTML 日志，不截图，禁用媒体资源并屏蔽 FANBOX 资源域名；临时目录和 `/config` 使用内存文件系统。成功请求后销毁浏览器；容器退出后删除可写层和临时状态，不创建持久卷。2 CPU、1.5 GiB 内存上限，256 MiB 共享内存，不需要 GPU。

```bash
# 先从 AoI 启动环境中移除这两个变量并重启，恢复默认明确报错行为：
unset AOI_FLARESOLVERR_URL AOI_FLARESOLVERR_PROXY_URL
# 再清理独立 solver；不会清除 AoI 测试数据、登录设置或其他容器：
node scripts/flaresolverr/dev.mjs down
# 可选：不再使用时删除本次派生镜像。
docker image rm aoi-flaresolverr:local
```

## 验证范围

FlareSolverr 返回成功后仍须验证目标 URL、JSON 结构及帖子访问状态；不能保证所有 IP、challenge 或 CAPTCHA 都能通过。仅元数据走 FlareSolverr，资源下载继续使用普通客户端；资源请求被拦截时明确报错，不将二进制数据转交 solver。Pixiv OAuth、登录自动续期和后台保活不属于此选项。

离线回归覆盖启用/停用、真实权限错误、HTML 200/403/503、错误或被重定向的 solver 返回、Cookie 范围、取消和并发；测试使用合成数据并禁止真实网络。

上游参考：[FlareSolverr](https://github.com/FlareSolverr/FlareSolverr)、[Docker seccomp profiles](https://github.com/moby/profiles)。
