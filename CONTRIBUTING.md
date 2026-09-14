# 贡献指南

## 开始开发

项目需要 Node.js 18 或更高版本。前端和服务端均不需要安装第三方运行时依赖。

```bash
npm test
DATA_DIR=./data PORT=8080 APP_SECRET="开发环境随机密钥" npm start
```

核心目录：

| 位置 | 职责 |
| --- | --- |
| `public/` | 响应式页面、表单、文档和更新界面 |
| `server/` | HTTP API、存储、站点查询和通知 |
| `android/` | Android 独立应用、本机存储和 APK 更新 |
| `fnos/` | 飞牛 FPK 清单、向导、桌面入口和生命周期脚本 |
| `scripts/` | 演示站与发布包构建脚本 |

修改数据结构、余额解析或凭据处理前，请先阅读[项目与数据说明](docs/项目与数据说明.md)和[后端接口契约](docs/接口契约.md)。

## 提交前检查

```bash
npm test
node --check public/app.js
node --check server/index.js
node --check server/probe.js
npm run prepare:fpk
npm run build:demo
```

界面改动还应按[前端验收标准](docs/前端验收标准.md)检查桌面、手机、亮色、暗色和跟随系统模式。

不要提交 `.env`、`data/`、真实 API Key、导出的配置、签名文件或本地构建产物。

## 发布

版本号来自 `package.json`。推送 `vX.Y.Z` 标签后，GitHub Actions 会运行测试并发布：

- `api-balance-vX.Y.Z.bundle`：Docker/Git 部署的离线更新包
- `api-balance-vX.Y.Z.fpk`：飞牛 fnOS 首次安装和底层启动配置升级包
- `api-balance.apk`：Android 安装包

正式发布前至少验证数据迁移、凭据不回显、Docker 健康检查、飞牛 FPK 打包源、飞牛代码更新与失败回滚，以及 Android 签名覆盖安装。
