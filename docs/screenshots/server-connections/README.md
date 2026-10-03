# 服务器连接与主备标识

截图使用本地 Vite 页面、虚构服务器记录和拦截的测试响应，不连接线上服务。浏览器视口为 390 × 844。

- [后台连接失败](01-background-failure.png)：缓存 token 已用于页面请求，后台连接失败显示红色「服务器连接失败」，保留底部 tab。
- [主备服务器列表](02-server-roles.png)：已知身份显示 primary 蓝色「主」和 secondary 灰色「备」；点击失败提示进入此页面。
- [连接中的取消操作](03-cancel-connection.png)：连接中仍可取消或返回服务器列表，两个操作都会中止连接。
- [备服务器设置](04-replica-settings.png)：服务器名称后的「备」标签，缓存的只读能力在后台验证前即生效。

Chromium 验证：缓存 token 在 health 响应前发出请求；后台失败后可切换图包、上传、设置 tab；点击提示才进入服务器列表；取消登录和返回列表后，迟到的响应不会保存 token 或跳转；主备标签和只读能力恢复；成功的后台登录更新缓存 token。测试期间无页面 JavaScript 异常。

自动回归：`server/test/client-connection.test.ts` 覆盖凭据恢复、后台重认证、401 重试、失败保留页面、请求取消和服务器隔离；`server/test/replica-readiness.test.ts` 暂停第二个图包下载，验证首个图包可先完成处理并开放访问。

参考 PWA PR #4 的底部连接提示布局；本分支不引入 Service Worker、离线缓存或模块离线限制。
