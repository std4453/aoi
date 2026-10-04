# 本地浏览器登录联调

这是 Pixiv / FANBOX 的可选登录入口：LinuxServer Chromium 提供 Selkies 网页串流，用户手动完成官方登录。Pixiv 使用 PKCE 授权码换取 refresh token 并原样保存；FANBOX 提取并保存会话。默认未启用，继续使用手动输入；启用后弹窗优先显示浏览器登录卡片，也可切回手动输入。此版本没有自动续期、后台保活或多用户调度。

## 启动与访问

需要 Node.js 22、运行中的 Docker，以及已安装的项目依赖。macOS Docker Desktop 的 CLI 若不在 PATH，可先执行 `export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"`。Docker 使用当前 context；不修改其他容器或卷。

```sh
npm run build
docker pull lscr.io/linuxserver/chromium@sha256:2d32e1b2b28aa92973aa0f58c433c0b045db6e1224d7001eeaa9cde1a474ce13
AOI_PROXY_URL=http://127.0.0.1:8888 node scripts/browser-login/dev.mjs up
node scripts/browser-login/dev.mjs status
```

示例中的代理端口 `8888` 需按实际配置修改；无需代理时省略 `AOI_PROXY_URL`。FANBOX 使用 `AOI_PROXY_URL`；Pixiv 优先使用 `PIXIV_PROXY_URL`，未配置则使用 `AOI_PROXY_URL`。浏览器通过容器内回环代理连接适配服务，再复用相同上游代理；支持 HTTP、HTTPS、SOCKS5，代理凭据不进入浏览器。官方 HTTPS 连接保持端到端加密，没有安装根证书或关闭证书验证。

固定 digest 对应 `d759a0f5-ls56`，由 Docker 选择匹配架构。使用前需确认目标架构受镜像支持。仅在创建登录会话时启动容器。

打开 <http://127.0.0.1:43127/settings>，点击「Pixiv / FANBOX → 浏览器登录」，准备完成后自动打开窗口；如浏览器拦截弹窗，点击「打开浏览器」。手动完成官方登录、验证码和二次验证。Pixiv 和 FANBOX 完成官方登录后均自动检测、保存并关闭窗口；「我已经登录」可作为手动重试入口。成功后关闭弹窗和登录窗口，以顶部通知显示结果。若外层浏览器不允许自动关闭，页面会显示会话已结束，可以手动关闭。无需打开 xdg-open 或本机 Pixiv 客户端。

固定分辨率模式在首次连接前启用，Chromium 在桌面就绪后再次最大化，串流按窗口等比缩放。移动端使用 390 × 844 的固定容器桌面和移动端浏览器页面（390 × 760）；桌面使用 1280 × 800。配置弹窗跟随 AoI 页面宽度，登录会话内可取消或重新打开窗口。手动输入会按需回填已保存凭据，包括浏览器取得的凭据；普通状态查询和登录完成响应只返回配置状态。清除登录态在手动输入界面操作。不要在对话中发送账号或凭据。

登录入口指定返回 FANBOX 的 `/user/settings`，也兼容官方授权返回首页；允许从首页或设置页读取 `meta#metadata` 中的登录布尔结果（当前结构为 `context.user` 存在有效 userId；不返回账号字段）。同时要求存在适用于 FANBOX API 的唯一有效会话 Cookie，才能保存。不会读取页面正文、访问帖子、下载资源或检查图片；没有验证赞助权限。若用户自行进入其他页面，需要回到首页或设置页再确认。

串流按键会发送给容器中的 Linux Chromium。macOS 上操作远程地址栏使用 **Ctrl+L / Ctrl+A**。手机继续使用 Selkies 自带的虚拟键盘和剪贴板，本适配不添加自定义粘贴入口、不改变剪贴板配置；手机剪贴板兼容性尚未验证。外层页面监听 `visualViewport` 的尺寸和偏移，将串流缩放到软键盘之外的可视区域；不会改变容器的固定分辨率。不同手机浏览器是否正确报告软键盘区域，仍需真机验证。

容器通过独立的 Chromium `PasswordManagerEnabled: false` 管理策略禁用密码保存提示；策略只读挂载到专用容器，不修改宿主 Chrome 或账号设置。此策略不控制手机自身的密码管理器提示。

## 隔离和清理

- 默认 AoI 监听 `127.0.0.1:43127`，适配服务控制接口监听 `127.0.0.1:43129`；显式局域网测试模式见后文。占用时启动失败，不结束现有服务。
- 容器名为 `aoi-browser-login-dev`；已存在时拒绝接管。容器 HTTP 端口随机映射到回环地址，并使用随机 Basic Auth；CDP 9222 仅在容器内部回环监听，通过 `docker exec` 调用，不发布端口、不挂载 Docker socket。
- AoI 使用独立随机 `DATA_DIR`，由启动命令输出；不继承已有 AoI/Pixiv/FANBOX 凭据，仅传入显式配置的 `AOI_PROXY_URL` / `PIXIV_PROXY_URL`。默认运行目录 `/tmp/aoi-browser-login-dev`，权限 `0700`。服务认证 key 和保存的 FANBOX 配置为 `0600`；key 不发送给前端。
- 为允许后续 FANBOX 官方授权复用 Pixiv 网页会话，仅将 Pixiv 域的 `PHPSESSID` 白名单保存到本次 `DATA_DIR/pixiv-browser-cookies.json`（0600），下次登录注入临时浏览器。它独立于 App refresh token；不保存完整 profile、其他网站 Cookie 或账号资料。清除 Pixiv 登录态时同时删除该文件；FANBOX 清除仅清除 FANBOX 会话。
- 浏览器 `/config` 是大小受限的 tmpfs，未挂载宿主浏览器目录或持久卷。容器上限为 2 CPU、3 GiB 内存和 1 GiB `/dev/shm`；使用软件渲染，不请求 GPU。
- 取消、成功或默认 15 分钟超时后删除容器。容器内部还有独立截止计时，即使适配进程意外退出，也会停止容器并由 `--rm` 清除临时状态。Docker 引擎不可用时不能承诺立即清理；恢复后应执行下述清理并核对容器已消失。
- AoI 的控制入口要求本机 Host、回环来源、同源访问及专用请求头。适配服务控制 API 要求独立 Bearer key；串流入口用短期 fragment 令牌换取 HttpOnly / SameSite=Strict Cookie。它们用于本地开发，不防御已控制本机用户会话的其他进程。

```sh
node scripts/browser-login/dev.mjs down
docker ps -a --filter name=aoi-browser-login-dev
```

运行中的本地服务使用启动时登记的构建文件。重新执行构建会改变带 hash 的 JS 文件名；构建完成后执行 `node scripts/browser-login/dev.mjs restart` 保留专用 DATA_DIR 并重启，再刷新页面。重新启动时继续传入所需代理配置。未完成的登录会话会关闭。

`down` 核对记录的进程归属，只结束本次 AoI/适配服务，删除本次测试 DATA_DIR、其中的凭据、适配 key 和日志。保留 Docker Desktop 和镜像缓存。若进程被强制杀死，先等会话超时；清理不完整时命令报错并保留专用目录以便排查，不递归清理其他目录。无需 `docker system prune`。

`AOI_BROWSER_RUNTIME` 可改为其他专用临时目录；启动和清理必须使用同一值。`AOI_BROWSER_TIMEOUT_SECONDS` 可设 30–1800 秒（用于超时测试）。`AOI_BROWSER_IMAGE` 可覆盖镜像，但更换版本/架构后需重新验证。

## 沙箱兼容

该镜像原有 Chromium 包装器使用 `--no-sandbox`；本适配用独立启动脚本替换它，保留证书检查、Chromium sandbox、容器 seccomp 和非 root 浏览器用户。未使用 privileged、SYS_ADMIN 或 seccomp=unconfined。

`scripts/browser-login/seccomp.json` 基于 [Moby profiles](https://github.com/moby/profiles/blob/2ceae35d351c156cb5a8efc0fdc4a08cf94569d8/seccomp/default.json)，仅增加 `clone/setns/unshare`，允许 Chromium 建立自己的 user namespace sandbox，其余默认系统调用限制保留。原许可证见同目录 `SECCOMP-LICENSE`。这扩大了本容器的 namespace 调用权限，需随镜像升级复核。

## 可选配置与后续部署边界

AoI 只有同时配置以下三项才显示浏览器登录入口；全部不配置则继续手动输入方案：

| 环境变量 | 用途 |
| --- | --- |
| `AOI_BROWSER_LOGIN_URL` | AoI 后端访问适配服务的 origin |
| `AOI_BROWSER_LOGIN_PUBLIC_URL` | 用户浏览器访问串流入口的 origin |
| `AOI_BROWSER_LOGIN_KEY_FILE` | AoI 可读的独立适配服务密钥文件 |

地址分开配置，允许未来 AoI 和浏览器适配服务分机。配置校验接受 HTTPS，HTTP 只接受回环地址。本地脚本有意固定回环 Host/Origin；它不是可直接对公网部署的服务。可信网络、HTTPS、反向代理、远程访问认证、密钥分发和远端容器管理需单独设计和验证。

Pixiv 登录采用与 gallery-dl 相同的移动端 PKCE 流程，临时 verifier 只在服务端内存保存。适配服务只处理本次官方回调，以完成页面替代唤起原生 App；AoI 及时交换短效授权码，并通过原有设置逻辑保存返回的 refresh token。FANBOX 复用的是保留的 Pixiv 网页会话，让用户在官方页面确认授权；没有使用 App refresh token 兑换 FANBOX Cookie。

FANBOX API 正常响应中的有效 `Set-Cookie` 会被动保存，且不会覆盖用户后来修改或清除的值；这不是主动续期。网页登录失效、官方验证或授权失败仍需用户处理。后台导入先读取元数据，认证失败时停止，不继续下载资源；任务显示「需要登录」及登录入口，保存新凭据后重试。权限不足也可能触发相同提示，重新登录不能补足赞助权限。

## 验证

仓库检查使用 `npm run check`。服务测试用独立 DATA_DIR 和禁止外网的 MockAgent 覆盖 PKCE 交换、网页会话保留/清除、按需回显、并发、未登录、过期、清理失败及访问边界；本地代理测试覆盖 HTTP CONNECT 和 SOCKS5 域名转发。登录状态表达式验证当前 metadata 格式和匿名状态。

手动联调必须分别记录：真实镜像启动、GUI 点击/输入、未登录拒绝、取消删除、超时删除，以及用户官方登录后的提取/保存/关闭结果。Mock 测试成功不能代替最后一项。运行时检查仅输出状态和资源用量；不要记录 Cookie、token、账号、HAR、profile 或登录后的截图。

网页登录成功不等于后端导入请求一定可用。Cloudflare 的 HTML 拦截响应不会判为登录失效，可选处理方式见 [FlareSolverr 本地联调](flaresolverr-local.md)。API 返回的 JSON 401/403 或受限帖子仍显示不可访问提示。

## 可选局域网手机联调

默认仍仅监听回环地址。显式设置 `AOI_BROWSER_LAN_IP` 为本机私有 IPv4 后，启动或 restart 会让 AoI 监听 `0.0.0.0:43127`，浏览器串流监听 `0.0.0.0:43130`（HTTPS）；控制接口继续只在 `127.0.0.1:43129`，局域网 HTTPS 入口拒绝 `/sessions` 控制请求，不提供 CONNECT 代理。

```sh
AOI_BROWSER_LAN_IP=192.168.1.10 AOI_PROXY_URL=http://127.0.0.1:8888 node scripts/browser-login/dev.mjs restart
```

示例 IP 必须替换成本机实际地址，首次启动使用 `up`。手机与电脑处于同一可信局域网，在 `http://本机地址:43127/settings` 填写本次专用 `lan-access.txt` 中的 Key。Key 为 0600 文件，不写入命令行或启动日志。状态 API 和凭据读取继续要求认证；AoI 的 HTTP 入口只适用于可信测试网络，不能作为公网部署方式。

串流需要浏览器安全上下文，因此启动器生成一天有效的独立自签名叶证书（非根证书，不自动安装信任），首次打开 HTTPS 串流地址需手动确认证书提示。各移动浏览器对自签名页面的安全 API 支持可能不同，应实测；没有关闭浏览器证书检查或修改 Selkies 安全上下文判断。证书和局域网 Key 都由 `down` 清理。取消局域网模式时显式使用 `AOI_BROWSER_LAN_IP=''` 执行 restart。

FANBOX 自动检测仅在用户发起的登录会话内每两秒读取容器里的既有页面状态与 Cookie，不刷新网页、不额外请求官方 API，不轮询帖子。取得有效登录状态后保存并销毁容器；无登录/网络故障/权限验证时保留人工操作入口，到期仍清理。
