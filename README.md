# koishi-plugin-awmc-maimaidx-status

舞萌DX Server Status / Uptime Kuma 数据接入插件。

本插件会从 `Status` 页面与 `Uptime Kuma` 心跳接口中抓取数据，自动计算 24 小时在线率、近 15 分钟状态，并生成类似「maiup」的文本输出，适合用于 QQ / 频道 / Telegram 等聊天平台展示。

## 功能特点

- **AWMC Status 集成**：抓取 `https://status.awmc.cc/status/maimai`（或你配置的反代地址）中的 `window.preloadData`，自动解析分组与监控项。
- **Uptime Kuma 心跳分析**：抓取 `https://status.awmc.cc/api/status-page/heartbeat/maimai`，按 Uptime Kuma 的心跳数据推算：
  - 各监控项的 **24 小时在线率**；
  - **近 15 分钟状态**（全部正常 / 偶发波动 / 较多异常 / 持续异常）。
- **服务状态判定**：根据 24 小时在线率与近 15 分钟心跳，自动判定：
  - 🟩 在线
  - 🟨 不稳定
  - 🟥 不稳定 / 离线
- **输出示例（格式接近 @迪拉熊 的 maiup）**：

```text
maimaiDX Server Status Regen
Overall / 总览
  舞萌DX状态
    状态：🟩在线
    24小时在线率：25.7143%
    近15分钟全部正常
舞萌DX - 基础网页展示服务 [不影响游戏]
  舞萌DX-NET服务器 [上海电信代理]
    状态：🟩在线
    24小时在线率：52.3756%
    近15分钟偶发波动
...
```

> 实际输出的分组与监控项依赖后台 Status 配置，插件只做「数据搬运 + 判定 + 美化」。

## 安装

在 Koishi 项目根目录执行：

```bash
npm install koishi-plugin-awmc-maimaidx-status
# or
pnpm add koishi-plugin-awmc-maimaidx-status
```

然后在 Koishi 控制台中启用插件 `awmc-maimaidx-status`。

## 配置项

- **baseUrl**（默认：`https://miku.milkawa.xyz`）
  - Status / Uptime Kuma 反代根地址。
  - 推荐使用全球加速节点 `https://miku.milkawa.xyz`，也可以改成 `https://status.awmc.cc` 或你自己的 Cloudflare 反代域名。
- **unstableThreshold**（默认：`95`）
  - 24 小时在线率低于该值时视为「不稳定」（🟨）。
- **badThreshold**（默认：`85`）
  - 24 小时在线率低于该值时视为「严重不稳定 / 基本不可用」（🟥）。
- **recentMinutes**（默认：`15`）
  - 用于分析「近 XX 分钟状态」的时间窗口，默认 15 分钟。

## 指令说明

- **`maidx.status`**
  - 别名：`maimai.status` / `舞萌状态`
  - 功能：抓取最新 Status 与心跳数据，输出舞萌DX服务器状态。

示例：

```text
> maidx.status
maimaiDX Server Status Regen
Overall / 总览
  舞萌DX状态
    状态：🟩在线
    24小时在线率：25.7143%
    近15分钟全部正常
...
```

## 备注

- 若你在海外服务器上部署 Koishi，可以优先使用 `https://miku.milkawa.xyz` 或挂 Cloudflare 的域名，以获得更稳定的访问。
- 若 Status / API 有结构变更，可能需要根据新的 `window.preloadData` / `heartbeatList` 结构微调解析逻辑。

