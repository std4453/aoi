# AoI 主备与对象存储复制协议 v1

## 目标与部署矩阵

主服务正常读写；备服务只读、使用完全独立的本地存储。双方不需要同时在线，
也不需要互相连接，只需各自访问同一个 S3-compatible bucket/prefix。
复制不暂停主服务，也不因对象存储故障阻塞业务。它是最终一致的内容副本，
不提供自动切主、同步提交、上传会话恢复或零数据丢失保证。

`AOI_REPLICATION_ROLE` 为 `off`（默认）、`primary` 或 `replica`：

- off：不创建复制目录、不实例化 S3 客户端、不导出/上传同步快照。原有启动/退出
  SQLite 安全备份仍保留，它不是主备复制；不会新增整库/文件备份工作。
- primary：正常读写，定时发布。
- replica：业务数据库只读，不迁移、不补默认预设、不恢复任务、不启动任务队列，
  不注册 TUS。复制进程可写本地副本，但业务请求不可写。
- `FRONTEND_ONLY=true`：完全不初始化后端或复制，主备配置不产生工作。
  `SERVER_SELECTION_ENABLED` 仅控制前端服务器选择，与主备角色独立。
- 前端从实际连接的 `/api/health` 获取 `writable`，同源和独立部署一致。上传入口、
  图包删除/重命名/标签/校验/压缩、预设写入、标签写入置灰。浏览、下载、服务器切换
  和本地设置仍可用。只读标记仅显示在设置页服务器名称后，以及切换服务器列表别名后；
  不显示常驻横幅。列表异步探测能力，离线时沿用上次成功连接记录。API 客户端也拒绝发送业务写操作；服务器是最终权限边界。

## 数据边界：明确选择，默认不复制

scope 固定为 `aoi-content-v1`。数据库使用表和列双重白名单，代码位于
`server/src/replication/protocol.ts` 的 `columns`。新表、新字段不会自动复制其值。
未来浏览历史、用户会话、节点偏好应放独立本机数据库；不要放进可被整体替换的内容库。
若必须共用主数据库，新表仍默认排除；备机的本地历史不能写在副本 catalog 中。

同步内容：

- 状态为 `extracted` / `generated` 的已发布图包及公开内容元数据。
- 标签、图包标签关系、压缩预设、已发布图包的校验数据和迁移版本记录。
- 这些图包的 `archives/`、`extracted/`、`generated/`、`thumbnails/` 文件。
- 数据库 schema 保留读取 API 所需的空 `jobs` / `uploads` / `pack_files` 表，
  但不复制其行。历史任务和上传会话不属于内容同步。

排除内容：上传中/失败/处理中的未发布图包、压缩包密码、校验结果里的匹配缓存、
上传文件与会话、`_staging` / `temp` / `.tmp` 工作文件、实例锁、鉴权密钥、日志、
已有备份、复制控制状态，以及所有未列入白名单的表和字段。

因此这是内容副本，不是完整进程灾备。不要将备机目录直接改成 primary 继续跑任务。
未来新增数据域应新增显式 scope/导出器，并定义表、列、文件依赖和恢复策略；未知 scope
必须拒绝，不允许“尽量导入”。当前 API 暂不暴露任意表名过滤配置，避免破坏引用完整性。

## 对象布局与兼容性

```text
<prefix>/publisher.json                         # 唯一发布者 UUID
<prefix>/blobs/sha256/<前两位>/<完整 SHA-256>     # 不可变文件内容
<prefix>/snapshots/<UUID>/catalog.sqlite        # 选择性导出的数据库
<prefix>/snapshots/<UUID>/manifest.json
<prefix>/snapshots/<UUID>/COMMITTED
<prefix>/latest.json
```

manifest 示例：

```json
{
  "protocol": 1,
  "scope": "aoi-content-v1",
  "build": "<完整构建 commit>",
  "generation": "<UUID>",
  "createdAt": "2026-10-01T00:00:00.000Z",
  "catalog": { "hash": "<sha256>", "size": 12345 },
  "files": [
    { "path": "generated/<pack-id>/compressed.zip", "hash": "<sha256>", "size": 123 }
  ]
}
```

`latest.json` 和 `COMMITTED` 包含相同的 `generation`、单调递增 `sequence`、
`manifestHash`、`owner`。哈希使用 canonical JSON：递归按对象键的字典序排序、数组保持顺序，再用
JSON.stringify 无空白序列化成 UTF-8（不转义 Unicode）。传输对象的键顺序不影响校验。

主备必须同时满足 **protocol、scope、build 完全一致**。GitHub Actions 的两个 Docker
构建步骤把 `github.sha` 写入镜像内 `build-revision.txt`。PR 镜像使用 checkout 的
合并 commit，正式镜像使用对应构建 commit；同一个 PR 的不同构建不能混用。
生产请固定同一镜像 digest，而不是依赖可变 tag。独立 protocol 版本描述协议；commit
额外防止数据库/API 实现不兼容。非 Docker 部署需明确设置相同 `AOI_BUILD_REVISION`，
不能使用默认 `development` 启用复制。镜像内的构建标识优先于环境变量，不能覆盖。

升级主备需部署同一新镜像。旧备机拒绝新主快照但继续服务旧本地版本；升级后的备机
不打开不兼容旧数据库，等待新版本同步（此时读 API 返回 503）。这是严格同版本的代价。
独立前端无需拥有 S3 凭据；保持前后端同版本是推荐部署方式。

## 不停服的一致性导出

第一版保留主机现有工作文件布局，不侵入全部解压/压缩处理链。**不可变 blob 位于
复制层**，而不是把业务所有读写立即改为 CAS。导出使用乐观写入栅栏：

1. 业务写请求（包括 TUS）和后台任务记录开始/结束 revision 及活跃写入数。
2. 有活跃写入或 pending/running job 时，本轮延期，不阻塞写方。
3. 取得 revision 和 SQLite `total_changes()`，在线 backup 到临时本机数据库。
4. 从该快照向全新 catalog 按白名单复制数据；不上传原始全库 backup。
5. 把所选图包文件流式复制到本轮私有目录，计算 SHA-256 并形成不可变 blob。
6. 再检查 revision、活跃写入和 total_changes；有变化则丢弃候选，下轮重试。
7. 检查通过后，catalog、文件和 manifest 都已与主机工作目录分离。此后主机修改或
   删除数据不会影响待上传版本；网络上传不需要保持无写入。

这不是仅比较 mtime，也不是边扫描活跃目录边直接发布。所有新业务写入口/后台任务
必须纳入栅栏；外部程序直接修改 DATA_DIR 不受支持（本来就违反单实例数据所有权）。
同一进程数据库变更有附加检查，外部数据库连接修改不属于支持场景。

代价：持续写入、持续长任务可能让快照一直延期；一次本地扫描/复制期间需要没有写入，
但服务始终在线且随时接受写请求。状态接口暴露延期原因，不承诺固定 RPO。该取舍针对
低更新频率场景；若日后要求持续写入下也及时发布，应改为业务文件不可变版本+事务引用
或使用一致性文件系统快照，而不能去掉栅栏。

第一版每次在本地重新读取/散列/复制文件，网络按文件哈希增量；catalog 每轮全量。
重新生成的大 ZIP 若哈希不同会整文件上传，不提供块级去重。主机需额外容纳一次完整
候选副本的空间。写入结束时间和开始/结束状态检查间没有异步业务操作插入窗口。

## 发布与下载

主机 DATA_DIR 中持久化 publisher UUID。首次通过 `If-None-Match: *` 抢占 prefix；
不同 UUID 的主机不能继续向该 prefix 发布。保留该文件才能恢复原发布者身份。
这不是选主租约，不支持自动抢占，禁止复制 publisher 身份同时运行两个主机。

单主串行发布：

1. 读取 latest/ETag。
2. 上传缺失 blob；HEAD 比较大小和 SHA-256 元数据，已有内容复用。
3. 上传 catalog 和 manifest。
4. 最后写 COMMITTED。
5. 用 `If-Match`（首次为 `If-None-Match`）更新 latest；冲突时失败，不能覆盖新指针。

使用 AWS SDK v3、path-style S3、流式传输和 multipart 上传大对象，校验与上传失败
不会更新 latest。SDK 有限重试，调度器下轮继续；已完成对象复用。进程重启不恢复
半个 multipart 或半个下载对象：该对象重新传输。不是字节级断点续传。

备机读取 latest，检查发布标记、manifest 哈希、协议/scope/build、发布者和递增序号；
下载 catalog 和本地缺失 blob，检查每个大小/SHA-256、路径及数据库完整性。目录穿越、
重复路径、符号链接、未知根目录被拒绝。所有内容从暂存区形成独立 generation，文件
通过硬链接共享本机 blob，不允许原地覆盖。已有本地 blob 损坏会报错，不修改正在服务
的历史版本；需要运维修复或用新的 DATA_DIR 重新拉取。

完整校验并 fsync 文件/目录后才持久化 current 指针并切换进程内上下文。每个读请求
通过 AsyncLocalStorage 固定 database+root；旧请求/下载结束后释放旧连接。新请求
使用新版本，整个过程无需停服。下载提供 ETag/If-Range，避免续传错误拼接新旧成品。

## 保留、删除、故障

v1 **不自动删除远端版本/blob或本地已安装 generation/blob**。删除图包通过新 catalog
传播，但旧内容保留以支持离线备机和回退取证。空间会增长，需监控磁盘与 bucket。
失败的主机候选下次重建；备机同一失败候选下次重建，已校验 blob 可复用。旧失败 UUID
目录也可能留下，v1 不在服务中清理它们。

不可给 blobs 设置简单的“创建 N 天后删除”规则：最新快照可能仍引用非常旧的内容。
未来 GC 必须以所有保留 manifest 引用为标记集，考虑进行中发布和离线节点；不能把
latest 目录以外全部当作垃圾。可单独设置中止未完成 multipart 的生命周期规则。

- 主机离线：已发布版本仍可获取，无法发布未上传数据。
- 备机离线：主机照常发布；恢复后可直接跳到最新版本。
- S3 故障：两端本地服务继续；旧版继续可读，新版暂不传播。
- 同步失败/磁盘不足/缺 blob/校验失败：不切换当前版本。
- 备机首次启动无快照：health/login/status 可用，业务读 API 503，业务写 API 403。
- 备机本地版本有效、S3 离线：重启后验证并打开本地版本，继续读。
- 备机严格拒绝回退 sequence 或更换 owner；切换数据集须使用新 DATA_DIR/prefix。
- 健康接口表明进程可用，不表示数据最新；监控复制状态的 snapshotAt/lastError。

当前实现不做自动主备提升，不保证未发布内容灾备。异步 RPO 是最后成功发布快照以来
的变化量，不等于定时器间隔。

## 配置、权限和网络

| 环境变量 | 默认值 / 用途 |
| --- | --- |
| AOI_REPLICATION_ROLE | off / primary / replica |
| AOI_REPLICATION_INTERVAL | 300，秒，最小 5；启动时也尝试一次 |
| AOI_S3_ENDPOINT | 可选；MinIO 等填写 http(s) URL，AWS 可省略 |
| AOI_S3_REGION | us-east-1 |
| AOI_S3_BUCKET | 启用时必填；需预先创建 |
| AOI_S3_PREFIX | aoi；每个独立数据集一个 prefix |
| AOI_S3_ACCESS_KEY | 启用时必填 |
| AOI_S3_SECRET_KEY | 启用时必填；不要提交仓库 |
| AOI_BUILD_REVISION | 仅非镜像部署需要；两端相同构建标识 |

主机需要 prefix 下 GetObject/HeadObject、PutObject、multipart 上传/中止权限；备机
仅需 GetObject（不需要 ListBucket/PutObject/DeleteObject）。主机 HEAD 判断对象不存在
通常需要 prefix 对应的 ListBucket 权限，否则 S3 可能返回 403 而不是 404。服务不自动
建 bucket、不修改权限，不需要 DeleteObject。对象存储必须支持原子对象 PUT、条件 PUT
及一致的读写语义。TLS 生产必须启用；不提供跳过证书验证的开关。

两端仅需出站访问 S3 HTTPS（通常 TCP 443；私有 MinIO 按实际端口），无需开放同步入站
端口、无需 SSH、数据库端口或共享盘。用户访问备机的业务入口是独立网络需求。

状态：`GET /api/system/replication`，沿用现有 AUTH_KEY 鉴权。包含 role、ready、running、
generation、snapshotAt、lastSuccess、lastError、最近上传/下载 blob 数、build/protocol/scope。
它是节点运行状态，不属于备份。lastSuccess 为本轮成功检查时间，snapshotAt 才是内容时间。

## 验证

`npm run check`：包含选择性导出、并发写栅栏、路径和版本拒绝、真实 SDK 对接测试 S3
wire server 的主备跨进程同步、元数据修改零新增 blob、只读/TUS 防护、删除传播、
缺失 blob 恢复、S3 离线重启、本地下载及 Range 一致性。发布后还需用同一 GHCR digest
和独立 MinIO 实测上传、预览、生成、下载以及独立前端连接只读备机。
