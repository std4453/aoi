# FANBOX 导入与登录态

## 使用范围

上传页的「导入自 → FANBOX」接受单个帖子网址，支持 `www.fanbox.cc/@创作者/posts/帖子编号` 和 `创作者.fanbox.cc/posts/帖子编号` 两种形式。自动使用标题和作者标签，手动填写后不会被自动识别覆盖。任务在服务器执行，支持下载进度、重试、取消、重启恢复、内容去重确认和预览生成；详情页可返回导入进度。

下载帖子正文关联的原始图片和直接上传的视频附件，按项目 `file-classifier.ts` 中的图片/视频扩展名白名单筛选，按文章中出现的顺序编号。文字、普通附件、压缩包、封面、未引用的资源和 YouTube/Vimeo 等外部嵌入链接不导入。`.ugoira` 是 AoI 的归档容器，不作为 FANBOX 图片下载。不会扫描正文中的网盘地址，也不会绕过赞助权限。

只请求固定的 FANBOX API 和资源域名，不跟随重定向。每帖最多 1000 个资源，单张图片最多 100 MiB，总下载量同时受 `MAX_UPLOAD_SIZE` 和 `MAX_EXTRACTED_SIZE` 限制，图片像素受 `MAX_IMAGE_PIXELS` 限制。下载中断后从头重新获取当前清单和文件，完整文件才替换 `.part`；成功后清理上次尝试的多余文件。不会将原始帖子 JSON、正文、资源地址查询参数或凭据写入任务记录。

导入使用 `originalFormat: fanbox` 的文件夹图包和 `fanbox` 下载任务；凭据保存在图包数据库之外。没有新增数据库结构或 npm 依赖，无需迁移。FANBOX 使用 `AOI_PROXY_URL` 的 HTTP / HTTPS / SOCKS5 代理，独立于 Pixiv 的代理配置。

Cloudflare 返回 HTML 拦截页时，默认明确报错，不认定为登录失效。可配置独立的 FlareSolverr 容器，在元数据请求被拦截时尝试一次；配置、依赖、代理与已验证的范围见 [FlareSolverr 本地联调](flaresolverr-local.md)。它不替代 FANBOX 登录，也不用于下载资源。

## 提供凭据

可选的「官方浏览器登录 → 自动保存」方案见 [本地浏览器登录联调](browser-login-local.md)。未启用时继续使用下面的手动方式。

1. 在自己的浏览器中登录 FANBOX，并确认账号能打开要导入的帖子。
2. 打开开发者工具 → Application（Firefox 为存储）→ Cookies，找到 FANBOX 域下的 `FANBOXSESSID`，只复制它的值。
3. 在 AoI「设置 → 外部来源 → FANBOX」打开配置弹窗并粘贴保存。上传表单识别失败、导入任务失败时的「配置登录」也打开同一弹窗，入口与 Pixiv 一致；保存后重新识别或重试任务。

无需提供账号密码。保存不验证帖子权限；只有实际读取帖子才能确认访问能力。Session ID 不是用一次就作废的凭据，但可能因过期、退出登录或服务端策略失效。付费帖子需要账号拥有对应权限。

配置文件位于 `DATA_DIR/fanbox-settings.json`，通过权限 `0600` 的临时文件原子替换。状态查询默认不返回值，配置弹窗通过显式 `reveal=1` 请求回填，响应均为 `Cache-Control: no-store`；表单允许查看/修改已保存值，不保留在浏览器本地存储。文件不进入图包、副本快照或数据库备份。清除登录态会保存空值，覆盖环境变量，不会重新启用旧凭据。

通过配置弹窗或仓库外权限为 `0600` 的 Cookie 文件提供凭据，不要将真实值写入命令参数、日志、测试夹具或提交。

## 持续更新

按以下优先级读取：

| 配置 | 行为 |
| --- | --- |
| `FANBOX_COOKIES_FILE` | 服务器可读的 Netscape `cookies.txt` 文件路径；每次 FANBOX 请求重新读取，可由外部同步程序原子替换，无需重启；AoI 不修改此文件，界面不能覆盖 |
| 设置页保存的 `sessionId` | 覆盖环境变量；若 FANBOX API 的响应实际返回新的有效 `FANBOXSESSID`，保存轮换值；不会用旧请求覆盖用户刚更新或清除的凭据 |
| `FANBOX_SESSION_ID` | 可选初始凭据；优先使用设置页或文件，避免把值写进命令行 |
| 未配置 | 匿名尝试公开帖子；访问受限时提示配置登录 |

Cookie 文件只选择有效、适用于 FANBOX API 的 `FANBOXSESSID`，忽略其他 Cookie，拒绝过期或相互冲突的会话。外部同步时应只导出 FANBOX 域。容器部署时挂载该文件；不要挂载整个浏览器配置目录。文件损坏或已过期会明确报错，不会悄悄回退旧登录态。

服务器接收 `Set-Cookie` 是被动接受轮换，**不能保证 FANBOX 每次都会续期**。浏览器 Cookie 文件持续更新需要外部导出/同步流程，本项目未内置 CookieCloud 客户端、定时登录或验证码处理。可选的临时浏览器只在用户确认后提取一次会话，不读取日常浏览器配置、不自动续期。浏览器登录失效后仍需用户重新登录。

## 登录方案与限制

Pixiv App refresh token 与 Pixiv 网页会话是不同的凭据。本项目不支持用 refresh token 兑换 FANBOX 会话；可选浏览器登录保留有限的 Pixiv 网页 Cookie，供用户在后续 FANBOX 官方授权时复用。网页登录失效时仍需重新登录，没有后台自动授权或保活。

开源方案参考：

- [gallery-dl](https://github.com/mikf/gallery-dl)：FANBOX Cookie 导入及 Pixiv OAuth 登录。
- [fanbox-dl](https://github.com/hareku/fanbox-dl)：FANBOX Cookie 会话与帖子解析。
- [CookieCloud](https://github.com/easychen/CookieCloud)：可作为外部 Cookie 同步方案；本项目未集成其客户端。

## 验证

运行 `npm run check`。回归测试使用禁用真实网络的 MockAgent 和独立临时 DATA_DIR，覆盖解析、资源筛选、图片/视频下载、凭据轮换与热更新、错误、取消和任务持久化。官方登录及实际网络可达性需在目标环境分别验证，不应把登录成功视为所有帖子均可访问。
