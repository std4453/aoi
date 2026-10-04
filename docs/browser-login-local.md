# 可选浏览器登录服务

Pixiv / FANBOX 浏览器登录使用一个常驻服务镜像，基于 LinuxServer Chromium，包含 Selkies 网页串流和 AoI 会话管理。用户手动完成官方登录，AoI 自动取得并保存凭据。默认未启用，继续使用手动输入；启用后仍可切回手动输入。本版本只允许一个活动会话，没有后台保活、自动续期或多用户调度。

## 服务结构

AoI 通过 HTTP 创建、检查、结束登录会话。服务在同一容器内启停 Chromium 和串流进程，不执行 `docker run/exec/rm`，不访问 Docker socket 或 Kubernetes API。容器在空闲时继续运行，内部浏览器和串流进程停止。

- **43129 控制端口**：独立 Bearer key 认证，只有 AoI 后端可达；`GET /health` 不要求认证，供健康检查使用。
- **43130 串流端口**：用户通过短期 fragment 令牌交换 HttpOnly / SameSite=Strict Cookie，才能进入当前会话。该端口始终拒绝 `/sessions` 和 CONNECT 请求。
- Chromium CDP、原始 Selkies HTTP/WebSocket 和浏览器代理仅监听容器回环地址，不对外发布。
- 通过已配置的外部 HTTPS origin 校验串流 Host/Origin；TLS 在反向代理终止时，仍设置 Secure Cookie。不会依据 `X-Forwarded-*` 开放控制接口。

## 构建和本地启动

镜像默认固定 LinuxServer Chromium digest，由 Docker 选择支持的 CPU 架构。构建时安装 Node.js 22，用于容器内的管理服务。可用 `CHROMIUM_IMAGE` build arg 更新基础镜像；升级后应重新运行镜像测试。

```sh
docker build -t aoi-browser-login:local scripts/browser-login
```

本地完整联调需要 Node.js 22、Docker、已安装的项目依赖：

```sh
npm run build
node scripts/browser-login/dev.mjs up
node scripts/browser-login/dev.mjs status
```

打开 `http://127.0.0.1:43127/settings`，选择 Pixiv 或 FANBOX 的「浏览器登录」。官方账号密码、验证码和二次验证由用户手动完成。两种来源均自动检测成功、保存并关闭窗口；「我已登录」用于手动重试。外层浏览器不允许自动关闭时，会显示会话已结束，可以手动关闭。

本地脚本创建一个常驻的 `aoi-browser-service-dev` 容器，仅绑定宿主回环端口。AoI 使用独立随机 DATA_DIR，不读取其他 AoI 实例或日常浏览器配置。已有同名容器或占用端口会导致启动失败，不接管其他服务。`AOI_BROWSER_RUNTIME` 可指定专用目录，默认 `/tmp/aoi-browser-login-dev`。

需要代理时，给启动命令显式设置 `AOI_PROXY_URL`；Pixiv 可用 `PIXIV_PROXY_URL` 覆盖。本地启动器把宿主回环代理地址转换为容器可达的 `host.docker.internal` 地址，写入专用 0600 配置文件。代理密码不进入 Chromium 参数或日志。支持 HTTP、HTTPS、SOCKS5 上游；官方 HTTPS 保持端到端加密，不安装根证书、不关闭证书校验。

构建项目或浏览器镜像后，保留测试数据并重启：

```sh
node scripts/browser-login/dev.mjs restart
```

重启默认沿用本次专用测试配置，可通过环境变量覆盖；设置空字符串可清除相应代理。`restart` 保留本次 DATA_DIR、已保存凭据和控制密钥，关闭未完成的登录会话；兼容迁移之前的本地主机管理进程。清理本次完整测试环境：

```sh
node scripts/browser-login/dev.mjs down
```

`down` 只停止记录并核对归属的进程和容器，删除本次 DATA_DIR、凭据、密钥和日志。Docker、镜像缓存和其他容器保持不变。不使用 `docker system prune`。清理失败时保留专用目录并报错。

只启动浏览器服务可使用同目录的 Compose 文件。先创建专用密钥文件，供 AoI 和浏览器服务分别只读挂载：

```sh
umask 077
openssl rand -hex 32 > /secure/path/browser-key
AOI_BROWSER_KEY_FILE=/secure/path/browser-key \
  docker compose -f scripts/browser-login/compose.yaml up -d --build
# 停止并移除这个 Compose 项目的容器；密钥由操作者单独管理
AOI_BROWSER_KEY_FILE=/secure/path/browser-key \
  docker compose -f scripts/browser-login/compose.yaml down
```

上述路径需替换为实际专用目录。不要将密钥放进源码目录、Git、命令参数或文档。Compose 仅发布回环端口；它与完整联调启动器二选一。

## 配置

AoI 只有同时配置以下三项才启用浏览器入口：

| AoI 环境变量 | 用途 |
| --- | --- |
| `AOI_BROWSER_LOGIN_URL` | 后端访问控制服务的 origin |
| `AOI_BROWSER_LOGIN_PUBLIC_URL` | 用户访问串流的 origin |
| `AOI_BROWSER_LOGIN_KEY_FILE` | 64 位小写十六进制共享密钥文件 |
| `AOI_BROWSER_LOGIN_TRUSTED_HTTP` | 默认 false；明确使用可信内网或 K8s Service 的 HTTP 控制接口时设 true，仅放宽控制地址 |

默认接受 HTTPS 或回环 HTTP。公网串流始终需要 HTTPS。可信 HTTP 开关不取消 Bearer 认证，也不放宽公网串流 URL 要求；内网链路需要传输加密时，应在服务网格或内网代理配置 TLS/mTLS。

| 浏览器服务环境变量 | 用途 |
| --- | --- |
| `AOI_BROWSER_PUBLIC_ORIGIN` | 外部完整 origin，例如 `https://browser.example.com`；必须与 AoI 的 PUBLIC_URL 相同 |
| `AOI_BROWSER_KEY_FILE` | 默认 `/run/secrets/browser-key` |
| `AOI_BROWSER_PORT` / `AOI_BROWSER_VIEWER_PORT` | 默认 43129 / 43130 |
| `AOI_BROWSER_TIMEOUT_SECONDS` | 30–1800，默认 900；包括用户交互，启动另有 90 秒上限 |
| `AOI_BROWSER_PROXY_FILE` | 可选 JSON 文件，`fanbox` / `pixiv` 字段是浏览器所在网络可达的代理 URL；空字符串表示直连，缺省字段沿用 AoI 传入的代理 |
| `AOI_BROWSER_TLS_CERT_FILE` / `AOI_BROWSER_TLS_KEY_FILE` | 可选、同时配置，串流端口直接提供 TLS；外部反向代理终止 TLS 时不设置 |

AoI 与浏览器服务可以分机部署。AoI 使用的 `localhost` 代理地址对远端容器通常无效，应通过浏览器侧代理文件覆盖。密钥、TLS 私钥和含认证信息的代理配置通过只读 Secret/文件挂载，不放进镜像。

## K8s 部署约束

部署为 **一个常驻 Deployment、单副本、Recreate 更新策略**。每次登录不会创建 Pod、Job 或容器。无需 Docker daemon、宿主 socket、privileged 或用于创建 Pod 的 RBAC；建议关闭 service account token 自动挂载。AoI 只依赖稳定 Service 地址。

- 浏览器镜像以 root 启动 s6 管理服务，Chromium 使用独立非 root 用户和正常 sandbox。不能直接套用要求整个容器非 root 的策略。
- `/config` 使用 memory 型 emptyDir，建议上限 768 MiB；`/run/aoi` 使用 16 MiB memory 型 emptyDir；`/dev/shm` 使用 1 GiB memory 型 emptyDir。不挂载持久浏览器 profile。
- 资源限制建议从 2 CPU / 3 GiB 内存开始，使用 CPU 渲染，无 GPU 申请。临时内存卷也计入 Pod 内存；需按实际环境测量 requests。
- 只为 43129 和 43130 创建 Service 端口。控制端口用 NetworkPolicy 限制到 AoI，不能进入公网 Ingress/Gateway。公开 HTTPS 只转发 43130，保留外部 Host，支持 WebSocket Upgrade；连接超时至少覆盖最长会话。
- 镜像 `/health` 在启动清理完成后才就绪；建议 startup/readiness probe 使用控制端口 `/health`。cleanup 失败时返回 503 并拒绝新会话。terminationGracePeriodSeconds 至少 60，给进程和临时状态清理留出时间。
- Chromium sandbox 所需 seccomp 配置位于 `scripts/browser-login/seccomp.json`，基于 Moby 默认 profile，仅额外允许 `clone/setns/unshare`。Docker 使用 `security_opt`；K8s 需由节点管理员安装该 profile，再设置 `seccompProfile.type: Localhost` 和对应路径。不使用 Unconfined 或 SYS_ADMIN 代替。不同节点内核仍需实测。

以上为通用部署契约，仓库不包含特定集群、域名或本机调试现场配置。尚未在目标 K8s 集群部署验证。

## 会话、登录态和清理

浏览器使用临时 HOME/profile，成功、取消、超时后删除；同时停止浏览器、桌面和串流进程，清除上一会话的画面和剪贴板内存。管理进程持有会话子进程 stdin 管道作为租约，管理进程异常退出会使管道 EOF 触发清理；独立截止时间也由子进程执行。s6 重启管理服务时，会等待旧清理完成，重新清理后才开放接口。容器或 Pod 重建时不会恢复未完成授权，用户需重新发起登录。

为后续 FANBOX 官方授权复用 Pixiv 登录，仅保留 Pixiv 域 `PHPSESSID` 白名单到 AoI 的 `DATA_DIR/pixiv-browser-cookies.json`（0600），下次注入新的临时浏览器；不保存完整 profile。清除 Pixiv 登录态时同步删除它。

Pixiv 使用移动端 PKCE 授权码获取 refresh token 并原样保存，不唤起本机 App/xdg-open。FANBOX 登录只检查已打开的首页或设置页中的登录布尔状态和适用的会话 Cookie；不读取帖子或图片，不通过下载证明登录。自动检测只在当前用户发起的会话内进行，不刷新页面或额外请求官方 API。

FANBOX 复用的是 Pixiv 网页会话，由用户在官方页面确认授权；没有使用 Pixiv App refresh token 兑换 FANBOX Cookie。FANBOX API 响应中有效 `Set-Cookie` 会被动保存，这不是自动续期；失效后仍需用户重新登录。后台导入认证失败会停止并显示「需要登录」，保存新凭据后可重试。

## 交互与验证

移动会话使用 390 × 844 固定桌面和 390 × 760 移动页面；桌面会话使用 1280 × 800。外层页面按 visualViewport 缩放串流，以适应软键盘。手机仍使用 Selkies 官方虚拟键盘与剪贴板；不添加自定义粘贴机制。密码保存提示由专用 Chromium policy 关闭。

仓库验证：

```sh
npm run check
# 需要 Docker 和已构建的镜像；独立测试容器，拒绝所有官方站点网络请求
node scripts/browser-login/smoke.mjs
```

镜像 smoke 覆盖同一容器的多次会话、未登录拒绝、取消和超时清理、旧令牌失效、管理进程崩溃恢复、手机尺寸以及 TLS 终止代理后的访问边界。它不使用用户 DATA_DIR，不读取账号、Cookie、页面内容或图片。真实官方登录的授权码交换、会话保存和自动关闭仍需分别联调，不能由 smoke 代替。

## 局域网手机联调

显式设置 `AOI_BROWSER_LAN_IP` 为本机私有 IPv4，启动器会让 AoI 监听 `0.0.0.0:43127`，串流监听 `0.0.0.0:43130`（HTTPS）；控制接口仍只发布在宿主回环地址。

```sh
AOI_BROWSER_LAN_IP=192.168.1.10 node scripts/browser-login/dev.mjs restart
```

示例 IP 需替换。手机使用专用运行目录内 `lan-access.txt` 的 Key 访问 AoI。启动器生成独立自签名叶证书，不安装根证书，首次打开串流需用户手动确认证书提示。该 HTTP AoI 入口只用于可信本地测试网络。用 `AOI_BROWSER_LAN_IP=''` restart 恢复回环模式。

网页成功不保证 FANBOX API 请求不受 Cloudflare 拦截；可选处理见 [FlareSolverr 本地联调](flaresolverr-local.md)。
