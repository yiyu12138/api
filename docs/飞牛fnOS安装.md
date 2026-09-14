# 飞牛 fnOS 安装与打包

API Balance 的飞牛版是 Native FPK 应用。它由飞牛应用中心直接管理 Node 服务进程，使用系统提供的 `nodejs_v22` 运行时，不创建 Docker 容器，也不需要用户克隆仓库或编写 Compose。

## 安装

1. 在 [GitHub Releases](https://github.com/yiyu12138/api/releases) 下载 `api-balance-vX.Y.Z.fpk`，不要解压。
2. 打开飞牛应用中心，选择手动安装并上传 FPK。
3. 在安装向导中填写访问端口，默认 `19999`。端口必须在 `1024` 到 `65535` 之间且未被占用。
4. 应用中心会按依赖声明处理 `nodejs_v22`。安装脚本还会再次检查；未检测到运行时时会停止安装，并提示先在应用中心安装并启用 Node.js 22。
5. 从飞牛桌面打开 API Balance，或访问 `http://飞牛地址:所选端口`。

安装包不携带特定架构二进制，声明支持 x86 与 ARM；实际兼容范围取决于飞牛 `nodejs_v22` 运行时。安装后可在系统设置的应用配置入口修改端口，保存后服务会自动重启。

如果设备上已经运行 Docker 版，可以为原生版选择另一个端口并行测试。两个版本的数据目录和加密密钥相互独立，不会自动迁移或覆盖。

## 数据与升级

配置、站点密钥、推送凭据、余额历史和程序生成的加密密钥都保存在飞牛分配的应用数据目录中。直接安装同一应用包名的更高版本 FPK 会走覆盖升级并继续使用原目录，不需要重新填写站点；不要先卸载旧版，卸载时选择删除应用数据会清空这些文件。

从 `v1.13.3` 或更早的 Docker 型 FPK 升级时，新包会清理旧 FPK 创建的 `api-balance-fnos` 容器，然后改由飞牛直接启动 Node 服务；原应用数据目录继续保留。用户自行部署、名称为 `api` 的普通 Docker 版不会被删除。

升级前建议在“通用设置”中导出一次配置。导出文件包含站点密钥和推送凭据，应按密码文件保管。卸载应用前也必须先导出；是否保留应用数据取决于卸载时的飞牛选项。

飞牛版不接受 Docker 版的 Git 代码更新或 `.bundle` 更新包。程序更新页会从 GitHub Release 检查最新版本、显示更新说明并提供对应 `.fpk` 的直接下载。升级方式有两种：

- 飞牛应用中心提供新版本时直接升级。
- 从程序更新页下载官方 `.fpk`，应用会尝试调用飞牛安装命令；若系统不支持命令行覆盖升级，点击“保存 FPK 安装包”，然后在飞牛应用中心选择“手动安装”完成覆盖升级。

应用内更新只接受官方 GitHub Release 中与最新版本名称完全匹配的 FPK。部分飞牛版本的 `appcenter-cli install-fpk` 遇到已安装应用会直接跳过，即使退出码为 0 也不代表升级完成。面板只有运行版本达到目标版本才显示成功；未完成安装时保留已下载文件，显示“待覆盖安装”，无需反复从 GitHub 下载。覆盖安装后服务会短暂重启。

`.fpk` 是飞牛安装包，`.apk` 是 Android 安装包，`.bundle` 是普通 Docker/Git 部署的离线更新包，三者不能混用。

## 端口与网络

- 网页端口由安装向导设置，默认 `19999`；安装后也可以从应用设置修改。
- 首次安装需要应用中心能够取得 `nodejs_v22` 依赖。
- 查询余额、用量、汇率和发送推送时，飞牛主机需要能访问相应服务。
- 面板没有内置登录，不应把所选端口直接暴露到公网。远程访问应使用 VPN、反向代理认证或防火墙白名单。

## 本地构建 FPK

先安装 Node.js 20 或更高版本，再从[飞牛开发者文档](https://developer.fnnas.com/docs/cli/fnpack/)下载与构建电脑匹配的 `fnpack`。Windows 可把 `fnpack.exe` 放入 PATH，Linux/macOS 可把 `fnpack` 放入 PATH 并授予执行权限。

~~~bash
git clone https://github.com/yiyu12138/api.git
cd api
npm run build:fpk
~~~

构建脚本会把 `fnos/` 模板与当前 `server/`、`public/` 和 `package.json` 合并到原生服务目录，再调用官方 `fnpack build`。成品位于：

~~~text
dist/api-balance-vX.Y.Z.fpk
~~~

若 `fnpack` 不在 PATH，可指定完整路径：

~~~powershell
$env:FNPACK_BIN = "C:\tools\fnpack.exe"
npm run build:fpk
~~~

Linux/macOS：

~~~bash
FNPACK_BIN=/opt/fnpack npm run build:fpk
~~~

只想检查打包源目录而不生成 FPK 时运行 `npm run prepare:fpk`，生成内容位于 `dist/fpk-source/`。不要直接修改该临时目录；应修改 `fnos/` 或项目源文件后重新生成。

## 包内结构

~~~text
fnos/
├── manifest
├── ICON.PNG
├── ICON_256.PNG
├── app/
│   ├── service/
│   │   ├── package.json
│   │   ├── public/
│   │   └── server/
│   └── ui/config
├── cmd/main
├── wizard/
│   ├── install
│   ├── upgrade
│   └── config
└── config/
    ├── privilege
    └── resource
~~~

发布标签触发 GitHub Actions 后，Release 会同时包含 FPK、Android APK 和 Git Bundle。正式发布前应在目标架构的飞牛设备上完成安装、启动、升级和卸载测试。

## 排错

### 安装时提示端口冲突

返回安装向导并选择其他空闲端口。如果已有 Docker 版使用 `19999`，原生版可以改用 `20000` 等其他端口。

### 应用安装后无法启动

先确认应用中心已经安装并启用 `nodejs_v22`。应用日志保存在飞牛分配给 API Balance 的应用数据目录中；运行时或应用文件缺失时，停止应用后重新安装 FPK。

如果 v1.16.0 升级后日志提示 `EACCES: permission denied`，且指向数据目录内的 `secret`，请下载 v1.16.1 或更新的 FPK，在应用中心覆盖升级。启动脚本会迁移旧数据文件的归属权限，保留站点配置、历史、安装编号与激活码。不要先卸载，也不要删除或重新生成 `secret`，否则原有站点密钥无法解密。

### 页面可以打开但查询失败

这通常不是 FPK 启动问题。检查站点地址、密钥、认证方式、飞牛 DNS 和出站网络；在站点管理中使用“测试查询”查看具体错误。
