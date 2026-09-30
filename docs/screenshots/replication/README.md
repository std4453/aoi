# 只读备服务器界面

截图由 `scripts/test-replication.mjs` 配合 Playwright，在隔离的本地主备和 MinIO 上生成。
`replica-detail.png` 为同源部署，`standalone-replica-detail.png` 为独立前端连接备机。
两者均显示只读提示，上传、标签修改、重命名、删除、重新生成置灰，下载可用。

复现：先启动隔离的 primary、replica、frontend-only 和 S3 服务，然后执行：

```sh
AOI_TEST_PRIMARY=http://127.0.0.1:19301 \
AOI_TEST_REPLICA=http://127.0.0.1:19302 \
AOI_TEST_FRONTEND=http://127.0.0.1:19303 \
AOI_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
AOI_SCREENSHOT_DIR=docs/screenshots/replication \
node scripts/test-replication.mjs
```

测试会创建图包并修改名称，**只能对测试环境执行**。S3 凭据和测试数据不得提交到仓库。
