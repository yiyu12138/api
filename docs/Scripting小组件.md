# Scripting 小组件

iPhone 上的纯本地小组件。Scripting 直接请求各中转站，不经过 API Balance 服务器，也不需要 Docker、飞牛或 Android。

当前版本：`2.6.4`。源码目录：[scripting/api-balance-direct](../scripting/api-balance-direct)。

## 远程导入

在 Scripting 中选择「导入远程脚本」，粘贴下面这个**脚本目录**地址，不要粘贴仓库首页：

```text
https://github.com/yiyu12138/api/tree/main/scripting/api-balance-direct
```

该目录包含 `index.tsx`、`widget.tsx`、`app_intents.tsx` 和 `script.json`。仓库根目录还有服务器和 Android 代码，不能当作脚本地址导入。

导入后打开脚本，进入「站点与 API Key 设置」：

| 字段 | 填写内容 |
| --- | --- |
| 名称 | 桌面小组件上显示的名字，例如 Sole |
| API URL | 站点地址。Sole 可填 `https://soleapi.com`，derouter 填余额接口地址 |
| API Key | 只保存在当前脚本的 Keychain。留空表示不修改已保存的 Key |
| New-API User ID | 仅 New-API / One-API 需要时填写 |
| 其它站点币种 | 仅未自动识别的站点使用，填 `USD` 或 `CNY` |

最多配置 2 个站点。保存时会直连各站并刷新小组件。

## 小组件

桌面尺寸使用 `systemSmall`。

| 位置 | 内容 |
| --- | --- |
| 顶部居中 | API 总览 |
| 左列 | 总余额，以及第一个站点的余额和今日 Token |
| 右列 | 今日消耗，以及第二个站点的余额和今日 Token |
| 底部居中 | 更新时间 |

金额按上海时区的今天计算，只保留一位小数。美元站点按实时汇率换算成人民币，和余额同一套口径。读不到的金额或 Token 显示「未知」，不估算。

点小组件会触发刷新。Scripting 也会按约 15 分钟的间隔重新加载。

## 各站怎么取今日数据

| 站点 | 余额 | 今日消耗 | 今日 Token |
| --- | --- | --- | --- |
| SoleAPI | `/v1/usage` 的剩余额度，按人民币显示，不乘汇率 | 同一响应里的今日金额 | 同一响应里的今日 Token |
| derouter 客户密钥 | `/sub-key/balance` | `usage.today.cost`，按汇率换人民币 | `usage.today` 的 Token |
| derouter 账户密钥 | `/balance` | 今日 `usage-logs` 的 `cost_usdc` 加总后再换汇 | 同一批日志的 Token 加总 |
| New-API / One-API | `/api/user/self` 的 `data.quota`，默认除以 `500000` | 今日日志统计；站点不开放时显示未知 | 当前不提供，显示未知 |

地址里的主机名用于识别站点：`soleapi.com` 走 Sole，`derouter.ai` 走 derouter，其它地址按 New-API / One-API 查询。

## 更新

脚本有新版本时，在 Scripting 中再次导入同一个目录地址并选择替换。API Key 保存在 Keychain，替换脚本不会要求重新填写，除非清除了 Key 或导入成了另一个新脚本。
