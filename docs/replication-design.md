# AoI 直连主备：图包快照协议 1.0.0

## 定位与部署

普通后端默认正常读写，并维护图包 hash 和快照读取接口。不需要开启 primary 角色，
不复制一份原始文件备份，也不主动向外发送内容。备机通过 HTTP(S) 定期拉取，只允许用户读取。
这是一份可浏览的内容副本，不是完整进程备份，不支持自动切主、级联复制或整包下载。

| 配置 | 默认值 / 用途 |
| --- | --- |
| AOI_SNAPSHOT_ENABLED | true；普通后端设 false 后不填充 hash、清单或数据集状态，不注册快照接口 |
| AOI_REPLICA_SOURCE_URL | 未配置时普通后端；配置为 http(s)://host:port 后成为备机，不支持 URL 内凭据、路径、查询参数 |
| AOI_REPLICA_SOURCE_KEY | 上游 AUTH_KEY，默认空；只保存在后端部署配置 |
| AOI_REPLICATION_INTERVAL | 300 秒，最小 5；备机启动立即拉取 |

备机的拉取不受 AOI_SNAPSHOT_ENABLED 影响。备机自己的 AUTH_KEY 控制用户访问，与上游 key
独立。复用现有 POST /api/auth/login 和 Bearer token，401 后重新登录一次；错误 key 下轮重试。
第一版不引入专用只读 key，上游 key 本身仍有写权限。上游响应体及 key 不写入状态或日志。
请求禁止跟随重定向，避免凭据发送到其他目标。

FRONTEND_ONLY=true 完全不初始化数据库、快照或拉取任务。服务器选择功能与主备配置正交。
两端 DATA_DIR 独立，每个目录只由一个实例使用。备机必须使用新的、专用的数据目录；
不要把可写实例的数据目录改作备机。

网络只要求备机出站访问主机 HTTP(S) 端口，主机无需反向访问备机。生产沿用 TLS 与正常证书
验证，不支持跳过验证。双方需要同时在线才能推进同步；主机离线时备机继续服务本地内容。

## 同步边界

scope 为 aoi-extracted-v1，显式允许：

- extracted/<packId>/images/ 和 videos/ 下的文件、相对目录结构。
- id、名称、来源文件名/大小/格式、来源类型、创建/更新时间、关联标签 id/name。
- 图像/视频数量及字节数由清单计算；备机不继承上游状态，而由本地安装和处理任务决定状态。

排除原上传 archive、generated ZIP、预设、任务、上传会话、密码、校验过程与匹配缓存，
以及未来未声明的表/字段。不能直接复制 extracted：其中的 thumbnails、_staging、
_temp_extract 等均不在允许的两个根目录中。源文件只能是普通文件，不接受符号链接。

备机独立维护数据库，只有同步内容及内部版本指针被更新；浏览历史等本机数据不被替换。
HTTP 写 API 统一返回 403 READ_ONLY_REPLICA，内部同步与缓存生成允许写。
备机不提供生成 ZIP 下载、上传、压缩、预设编辑或自动切主。

缩略图、封面和 BlurHash 不进入协议。主备复用同一个 thumbnail 任务、thumbnailGenerator
和数据库 BlurHash 字段，包括封面候选选择、单图失败处理及中断任务恢复。备机图片生成
并发限制为 2。完整安装后创建本地任务，生成完成才标记 extracted；任务失败标记 failed，
下一轮同步或重启重新排队。没有备机专用缓存、预热、按需生成或原图回退。
图片列表仍依据原图，日常读取使用图包 ID 和普通目录路径。
视频接口与原图接口支持单文件读取；视频支持 Range。只同步原视频，不转码、不抽帧、不做视频压缩或专用播放器；浏览器是否能播放取决于格式和编码。前端显示文件浏览入口，隐藏整包
下载/压缩预设入口。只读标记仅在设置页名称后、服务器列表地址后，不显示常驻横幅。

## API 与版本

普通后端注册下列接口，沿用现有业务鉴权。备机不作为同步源，拉取前校验 health 的
writable、snapshots 能力和协议号。禁用快照接口时返回 404。

| 接口 | 行为 |
| --- | --- |
| GET /api/packs/snapshot | 完整索引；ETag / If-None-Match，未变返回 304 |
| GET /api/packs/:id/snapshot?revision=… | 精确版本 manifest；过期或 pending 返回 409 SNAPSHOT_CHANGED |
| GET /api/packs/:id/snapshot/files/*?contentHash=… | 仅读取该清单中存在的文件；ETag 为文件 SHA-256，支持 Range/If-Range |
| GET /api/system/replication | 同步角色、协议、ready、运行状态、最近检查/成功时间、待处理/失败数、最近新增下载数及错误 |

health 暴露 writable、role=standalone/replica、replicationProtocol 和 capabilities：
generatedArchiveDownload、snapshots。它表示进程能力，不承诺备机数据是最新的。

索引包含 protocol、scope、datasetId 和完整 packs 数组。每个图包为
{id,state:"ready",revision} 或 {id,state:"pending"}。pending 仍存在，不能删除本地旧版；
仅从完整有效索引中消失才表示删除。数据读取错误绝不能转换成成功的空索引。
第一版不分页、不复用业务列表；响应超过元数据上限（64 MiB）则失败，不能截断后应用。

manifest 包含 protocol、scope、metadata、contentHash、revision、files。files 的每项是
{path,size,hash}，path 必须以 images/ 或 videos/ 开始，使用相对 POSIX 路径。
拒绝穿越、重复路径、文件/目录冲突、重复 ID，以及同 hash 不同大小。路径使用 safe-path
并逐层 lstat，文件响应从已经打开且检查过的文件描述符发送。

版本在 server/src/version.ts 中维护，当前为 1.0.0。主备 major/minor/patch 都须一致。
修改协议、数据范围或读取契约必须更新版本、文档和测试。不依赖 commit，也不注入构建号。
PR 尚未合并，已删除的 S3 开发协议不占用版本号，不保留兼容逻辑。

hash 规则：

1. 文件用原始字节 SHA-256，size 为字节数。
2. files 按路径的确定性字符串顺序排序。contentHash=SHA256(canonicalJson(files))。
3. revision=SHA256(canonicalJson({protocol,scope,metadata,contentHash,files}))。
4. tags 按 id 排序。canonicalJson 递归按键排序、数组保持顺序，无空白 JSON UTF-8 编码。
5. 索引按图包 id 排序，ETag 是整个 canonicalJson 索引的 SHA-256，不含请求时间。

## 普通后端索引

迁移 009 建立快照状态和清单表。迁移 010 增加安装日志 replica_installs、内容变更计数
snapshot_content_clock 和展示标签视图，移除 replica_packs 的多版本 root 字段。
初次显式关闭时不填充 hash、manifest 或数据集状态；变更计数仅有固定大小记录，
不扫描文件。后续关闭保留旧索引但不再更新或提供接口。
主机持久化 datasetId UUID、当前 manifest 和文件 stat 签名。没有备机也维护清单。
后台每秒检查业务变更栅栏及专用内容变更计数；未变直接返回。计数由白名单触发器维护，
仅关注图包展示元数据/状态/统计、标签关联和任务就绪状态，不关注浏览历史、同步状态、
manifest 缓存或任务进度本身。同步服务不操作 SQL：一致性读取、清单保存、安装提交和
删除接口都在 db/snapshot-repository.ts；事务不跨越文件与网络操作。首次/重启后台核验
已有图包，按图包串行计算 hash；之后复用 size/mtime/ctime/inode 均未变的文件 hash。
元数据/标签变化仅更新 manifest，不重读文件内容。请求内不做文件散列。

正在上传、处理、校验或有待执行任务的图包为 pending。扫描前后检查业务写入栅栏与
数据库变化，冲突时放弃候选、下轮重试，写方不等待。持久化新清单才标为 ready。
单个坏图包保持 pending，不阻止其他稳定图包建立清单。持续写入可能延迟快照发布。
运行目录只允许 AoI 修改，外部程序直接改动不受支持。

主机只维护当前清单，没有历史内容副本。文件请求版本失效或 stat 签名变化返回 409，
备机重取索引/manifest。传输期间的变化还会由备机完整大小和 hash 校验兜底。

## 备机安装与恢复

备机先确认上游能力，再条件读取索引。首次有效索引绑定 datasetId，同时持久化索引和
ETag。地址改变可以连接相同数据集，datasetId 改变拒绝同步，须使用新 DATA_DIR。
空索引只有在协议、身份、完整性均通过时才有效。401、超时、无效 JSON 等不会触发删除。

按图包串行处理，文件最多并行 2 个；同 hash 合并下载，直接从当前图包按旧 manifest
复用并再次校验同 hash 文件，支持重命名复用与元数据修改零文件下载。不维护全局 blob 仓库。

目录与持久化记录：

- extracted/<packId>/images、videos：当前原文件；extracted/<packId>/thumbnails：原有任务生成的缩略图。
- thumbnails/<packId>/_cover.jpg：原有封面目录；packs.blurhashes：本地生成的 BlurHash。
- replica/staging/<packId>/<revision>/downloads/<hash>[.part]：下载/续传文件，只属于本轮候选。
- 同一暂存目录内 content/：已校验的新图包；previous/：仅安装事务期间保留的旧目录。
- replica_installs：需要继续的安装日志（图包 ID、目标 manifest）；replica_packs：已安装 manifest。

安装步骤：

1. 下载阶段继续展示旧图包。Range 续传校验 Content-Range；收到完整 200 时从头覆盖，
   最终核验每个文件的完整 SHA-256 和长度。下载、校验或空间不足不触碰当前图包。
2. 在暂存 content 中组装新目录，全部文件及目录 fsync；数据库事务保存安装日志，
   将图包标为 extracting。没有日志就绝不切换文件。存在本地图包任务时推迟安装。
3. 将当前目录移至暂存 previous，然后将 content 移入普通 extracted/<packId>；每次
   rename 后同步父目录。清除旧封面。此窗口内图包显示处理中，内容接口返回 409 PACK_PROCESSING。
4. 再次确认当前文件完整，数据库事务同时提交 manifest、状态 thumbnailing、本地 thumbnail
   任务并移除安装日志。标签从已安装 manifest 的显式 tags 白名单通过数据库视图读取，
   容许不同图包暂时保留同一标签的不同名称；列表、搜索和详情复用普通仓储读取。
5. 使用原有任务队列生成缩略图、封面、BlurHash，完成后图包可读。清理候选暂存及 previous，
   不长期保留旧版本。若清理失败，后续轮次继续清理。

重启先读取安装日志。content 仍存在时继续上述两次移动；content 已移走时验证当前目录
是否匹配目标 manifest，然后继续提交。本地恢复不依赖主机在线。已提交但未完成的缩略图
任务由原有 recoverInterruptedJobs/任务恢复逻辑重新排队；失败任务在下次同步或重启重试。
恢复失败保留日志和处理状态，不把缺文件或半成品标成可用。每个图包独立安装，不承诺
全库同时切换。下载完成后发生的文件/数据库错误可能延长处理窗口，而非保证旧版持续可读。

访问保证明确放松：已打开页面后续请求在更新期间可能失败，需要刷新；不固定请求版本，
不保留读取引用计数，不承诺旧请求跨切换完成。安装及缩略图生成期间不提供图片、封面、
目录树或视频；列表/详情仍能返回处理状态。首次尚无可用内容时列表返回 503；确认源库
为空时正常返回空列表。曾经就绪的进程在更新窗口仍提供列表，图包状态显示处理中。

完整有效索引用于删除；pending、网络或认证故障、无效 JSON、协议不匹配不能触发误删除。
删除也先标记处理中、清理本地图包目录，再删除数据库行；失败保留状态待重试。304 仍会
继续候选下载、安装恢复和失败任务。暂存清理只在 replica/staging 内；只删除已不需要且
没有安装日志保护的候选。浏览历史等未声明的本地数据不替换。

## 开发与验收

npm run check 覆盖默认/禁用模式、范围、鉴权、ETag、精确版本、pending、离线、删除、
304 重试、坏 hash、断流续传及重启、提交失败恢复、数据集变更和只读上游拒绝。另覆盖无关写入不触发扫描、内容/标签变更栅栏、
安装各中断点离线恢复、处理中访问限制及原有缩略图任务失败/重启恢复。
发布后用同一 GHCR 镜像启动隔离主备，验证实际上传/预览、图片/视频读取和浏览器只读行为。
临时脚本/截图不提交，测试数据在 /data；不使用 sudo，不改变线上 Kubernetes 资源。
旧 S3 测试数据不会自动迁移或删除，新备机从独立空目录开始。

本 PR 未合并，协议仍为 1.0.0。之前多版本缓存原型的备机测试目录不做迁移，请使用新目录；
普通主机业务数据按有序迁移正常升级。
