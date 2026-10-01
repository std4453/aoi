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
- 图像/视频数量及字节数由清单计算，备机状态统一为 extracted（内容可用）。

排除原上传 archive、generated ZIP、预设、任务、上传会话、密码、校验过程与匹配缓存，
以及未来未声明的表/字段。不能直接复制 extracted：其中的 thumbnails、_staging、
_temp_extract 等均不在允许的两个根目录中。源文件只能是普通文件，不接受符号链接。

备机独立维护数据库，只有同步内容及内部版本指针被更新；浏览历史等本机数据不被替换。
HTTP 写 API 统一返回 403 READ_ONLY_REPLICA，内部同步与缓存生成允许写。
备机不提供生成 ZIP 下载、上传、压缩、预设编辑或自动切主。

缩略图、封面和 BlurHash 在备机本地生成，按 contentHash 和 cache-v1 算法版本隔离。
图包安装后后台预热，访问时按需补齐；全局最多 2 个图片处理任务。缓存失败回退原图，
不阻止内容安装。图片列表依据原图清单，不依赖缩略图是否已经存在。
视频接口与原图接口支持单文件读取；视频支持 Range。前端显示文件浏览入口，隐藏整包
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

有序迁移建立 snapshot_state、snapshot_manifests、replica_packs；初次部署且显式关闭时状态表为空；后续关闭保留旧索引但不再更新或提供接口。
主机持久化 datasetId UUID、当前 manifest 和文件 stat 签名。没有备机也维护清单。
后台每秒检查业务变更栅栏及数据库 total_changes；未变直接返回。首次/重启后台核验
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

按图包串行处理，文件最多并行 2 个；同 hash 合并为一次下载。目录为：

- replica/blobs/<sha256>：已校验不可变文件。
- replica/blobs/<sha256>.part：可续传部分文件。
- replica/versions/<packId>/<contentHash>/：图包文件硬链接、manifest 与本地缓存。
- replica_packs：数据库中的已提交图包 manifest 和文件根目录指针。

失败的图包留待重试，不阻塞其他图包。索引返回 304 也继续处理本地待完成任务。
Range 续传必须校验 Content-Range，服务器返回完整 200 时从头覆盖；无论是否续传，
完成后必须核验全部 SHA-256 和大小。失败不改变已有可见版本。

文件、manifest 及目录 fsync 后，事务更新图包内容字段、标签与版本指针，最后切换进程内
读取上下文。每个图包请求固定元数据和文件版本。不同图包可处在不同同步时刻，不承诺
整个库一起切换。崩溃在事务前继续旧版，事务后可重开新版；重启检查已提交文件完整性。

后台任务、活动读取和当前图包版本都会固定文件根目录。无引用版本才回收；存在未完成
任务时保留下载缓存，恢复后清理不再需要的 blob/part。清理仅作用于同步自有目录。
SQLite 提交失败、缺文件、checksum 错误和 ENOSPC 都不切换版本。首次尚无内容返回 503；
至少一个图包安装成功即可浏览该图包；确认源库为空则正常返回空列表。

## 开发与验收

npm run check 覆盖默认/禁用模式、范围、鉴权、ETag、精确版本、pending、离线、删除、
304 重试、坏 hash、断流续传及重启、提交失败恢复、数据集变更和只读上游拒绝。
发布后用同一 GHCR 镜像启动隔离主备，验证实际上传/预览、图片/视频读取和浏览器只读行为。
临时脚本/截图不提交，测试数据在 /data；不使用 sudo，不改变线上 Kubernetes 资源。
旧 S3 测试数据不会自动迁移或删除，新备机从独立空目录开始。
