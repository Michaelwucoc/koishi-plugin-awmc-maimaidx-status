import { Context, h, Logger, Schema } from 'koishi'

const logger = new Logger('awmc-maimaidx-status')

declare module 'koishi' {
  interface Tables {
    // 目前不需要持久化存储，预留扩展点
  }
}

export const name = 'awmc-maimaidx-status'

export interface Config {
  /**
   * Status / Uptime Kuma 反代根地址
   * 例如：
   * - https://status.awmc.cc
   * - https://miku.milkawa.xyz
   */
  baseUrl: string

  /**
   * 视为「不稳定」的 24 小时在线率阈值（百分比）
   */
  unstableThreshold: number

  /**
   * 视为「严重不稳定 / 基本不可用」的 24 小时在线率阈值（百分比）
   */
  badThreshold: number

  /**
   * 近多少分钟内的心跳用来判断「近期状态」
   */
  recentMinutes: number

  /**
   * 是否以合并转发形式发送状态（仅部分平台如 QQ 支持合并转发）
   */
  useForward: boolean
}

export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string()
    .default('https://miku.milkawa.xyz')
    .description('Status / Uptime Kuma 反代根地址（推荐使用全球加速节点 miku.milkawa.xyz，也可填写 https://status.awmc.cc 等）。'),
  unstableThreshold: Schema.number()
    .default(95)
    .description('24 小时在线率低于该值时视为「不稳定」（单位：%）。'),
  badThreshold: Schema.number()
    .default(85)
    .description('24 小时在线率低于该值时视为「严重不稳定 / 基本不可用」（单位：%）。'),
  recentMinutes: Schema.number()
    .default(15)
    .description('用于统计「近多少分钟状态」的时间窗口。'),
  useForward: Schema.boolean()
    .default(false)
    .description('是否以合并转发形式发送状态（仅部分平台如 QQ 支持；不支持时会回退为普通消息）。')
})

interface StatusPagePreloadData {
  publicGroupList: StatusGroup[]
}

interface StatusGroup {
  id: number
  name: string
  weight: number
  monitorList: StatusMonitor[]
}

interface StatusMonitor {
  id: number
  name: string
  sendUrl: number
  type: string
  tags: string[]
}

/** API 返回的单项：time 可能是时间戳(ms) 或 "YYYY-MM-DD HH:mm:ss.SSS" 字符串 */
interface UptimeKumaHeartbeatEntryRaw {
  time: number | string
  status: number
  msg?: string
  ping?: number | null
}

/** 标准化后的心跳项（time 统一为 ms 时间戳） */
interface UptimeKumaHeartbeatEntry {
  time: number
  status: number
  msg?: string
  ping?: number | null
}

interface UptimeKumaHeartbeatResponse {
  heartbeatList: Record<string, UptimeKumaHeartbeatEntryRaw[]>
  /** 24 小时可用率，键为 "1_24"、"4_24" 等，值为 0～1 的小数（如 0.256 表示 25.6%） */
  [key: string]: unknown
}

/** 解析 heartbeat 的 time：API 返回为 GMT，按 UTC 解析得到正确时间戳 */
function parseHeartbeatTime(t: number | string): number {
  if (typeof t === 'number') return t
  const s = String(t).trim().replace(' ', 'T')
  const ms = Date.parse(s.endsWith('Z') ? s : s + 'Z')
  return Number.isNaN(ms) ? 0 : ms
}

function normalizeHeartbeatList(
  rawList: UptimeKumaHeartbeatEntryRaw[] | undefined,
): UptimeKumaHeartbeatEntry[] {
  if (!rawList || !Array.isArray(rawList)) return []
  return rawList.map((e) => ({
    ...e,
    time: parseHeartbeatTime(e.time),
    ping: e.ping ?? undefined,
  }))
}

function parsePreloadData(html: string): StatusPagePreloadData {
  const regex = /window\.preloadData\s*=\s*(\{[\s\S]*?});/
  const match = regex.exec(html)

  if (!match) {
    throw new Error('未能在页面中找到 window.preloadData。')
  }

  const code = match[1]

  try {
    // 这里数据完全由受信任的 AWMC Status 页面提供
    // 使用 Function 包裹为对象字面量进行安全求值
    // eslint-disable-next-line no-new-func
    const data = new Function(`"use strict"; return (${code});`)() as StatusPagePreloadData
    if (!data || !Array.isArray(data.publicGroupList)) {
      throw new Error('window.preloadData 结构异常。')
    }
    return data
  } catch (error) {
    logger.error(error)
    throw new Error('解析 window.preloadData 失败。')
  }
}

/** 仅根据 heartbeat 的 time（已按 GMT 解析）筛选近期数据 */
function getRecentHeartbeats(
  entries: UptimeKumaHeartbeatEntry[],
  recentMs: number,
): UptimeKumaHeartbeatEntry[] {
  const cutoff = Date.now() - recentMs
  return entries.filter((e) => e.time >= cutoff)
}

function formatStatus(
  monitor: StatusMonitor,
  entries: UptimeKumaHeartbeatEntry[] | undefined,
  config: Config,
  /** API 返回的 24 小时可用率，0～1（如 0.256 表示 25.6%） */
  uptime24Ratio?: number,
): string[] {
  const lines: string[] = []

  const list = entries ?? []
  const last = list[list.length - 1]
  const recentMs = config.recentMinutes * 60 * 1000
  const recent = getRecentHeartbeats(list, recentMs)
  const uptime24h = uptime24Ratio != null ? uptime24Ratio * 100 : null

  let statusEmoji = '⬜'
  let statusText = '未知'

  if (!list.length || !last) {
    statusEmoji = '⬜'
    statusText = '未知'
  } else {
    const recentTotal = recent.length
    const recentDown = recent.filter((e) => e.status === 0).length
    const recentDownRatio = recentTotal ? recentDown / recentTotal : 0

    const isDownNow = last.status === 0

    if (isDownNow) {
      if (recentDownRatio > 0.8) {
        statusEmoji = '🟥'
        statusText = '离线'
      } else {
        statusEmoji = '🟥'
        statusText = '不稳定'
      }
    } else {
      if (uptime24h != null) {
        if (uptime24h < config.badThreshold) {
          statusEmoji = '🟥'
          statusText = '不稳定'
        } else if (uptime24h < config.unstableThreshold || recentDownRatio > 0) {
          statusEmoji = '🟨'
          statusText = '不稳定'
        } else {
          statusEmoji = '🟩'
          statusText = '在线'
        }
      } else {
        if (recentDownRatio > 0) {
          statusEmoji = '🟨'
          statusText = '不稳定'
        } else {
          statusEmoji = '🟩'
          statusText = '在线'
        }
      }
    }
  }

  lines.push(`  ${monitor.name}`)
  lines.push(`    状态：${statusEmoji}${statusText}`)

  if (uptime24h != null) {
    lines.push(`    24小时可用率：${Math.round(uptime24h)}%`)
  } else {
    lines.push('    24小时可用率：暂无数据')
  }

  const recentMins = config.recentMinutes
  if (recent.length) {
    const recentTotal = recent.length
    const recentDown = recent.filter((e) => e.status === 0).length
    const recentDownRatio = recentDown / recentTotal

    let recentSummary: string
    if (recentDownRatio === 0) {
      recentSummary = `近${recentMins}分钟全部正常`
    } else if (recentDownRatio < 0.3) {
      recentSummary = `近${recentMins}分钟偶发波动`
    } else if (recentDownRatio < 0.8) {
      recentSummary = `近${recentMins}分钟较多异常`
    } else {
      recentSummary = `近${recentMins}分钟持续异常`
    }

    lines.push(`    ${recentSummary}`)
    const recentPings = recent.filter((e) => e.status !== 0 && e.ping != null && e.ping > 0).map((e) => e.ping!)
    if (recentPings.length) {
      const avgPing = Math.round(recentPings.reduce((a, b) => a + b, 0) / recentPings.length)
      lines.push(`    近${recentMins}分钟平均 Ping：${avgPing} ms`)
    }
  } else {
    lines.push(`    近${recentMins}分钟：暂无心跳数据`)
  }

  if (last && last.status !== 0 && last.ping != null && last.ping > 0) {
    lines.push(`    当前 Ping：${last.ping} ms`)
  }

  return lines
}

export function apply(ctx: Context, config: Config) {
  const base = config.baseUrl.replace(/\/$/, '')
  const statusUrl = `${base}/status/maimai`
  const heartbeatUrl = `${base}/api/status-page/heartbeat/maimai`

  ctx.command('maidx.status', '查询舞萌DX服务器当前状态（AWMC / Uptime Kuma）')
    .alias('maimai.status')
    .alias('舞萌状态')
    .action(async ({ session }) => {
      try {
        const [html, heartbeatJson] = await Promise.all([
          ctx.http.get<string>(statusUrl),
          ctx.http.get<UptimeKumaHeartbeatResponse>(heartbeatUrl),
        ])

        const preload = parsePreloadData(html)
        const groups = preload.publicGroupList ?? []
        const heartbeatMapRaw = heartbeatJson?.heartbeatList ?? {}

        const groupBlocks: string[] = []
        groupBlocks.push('maimaiDX Server Status Regen')

        const ratio24Map = heartbeatJson as UptimeKumaHeartbeatResponse
        for (const group of groups.sort((a, b) => a.weight - b.weight)) {
          const blockLines: string[] = [group.name]
          for (const monitor of group.monitorList) {
            const key = String(monitor.id)
            const rawList = heartbeatMapRaw[key]
            const list = normalizeHeartbeatList(rawList)
            const ratio24 = ratio24Map[`${monitor.id}_24`]
            const ratio =
              typeof ratio24 === 'number' && Number.isFinite(ratio24) ? ratio24 : undefined
            blockLines.push(...formatStatus(monitor, list, config, ratio))
          }
          groupBlocks.push(blockLines.join('\n'))
        }

        const fullText = groupBlocks.join('\n')
        if (session) {
          if (config.useForward && groupBlocks.length > 0) {
            const selfId = session.bot?.selfId ?? ''
            const forwardContent = h(
              'message',
              { forward: true },
              ...groupBlocks.map((block) =>
                h('message', h('author', { name: '舞萌DX状态', id: selfId }), block),
              )
            )
            await session.send(forwardContent)
          } else {
            await session.send(fullText)
          }
          return
        }
        return fullText
      } catch (error) {
        logger.error(error)
        return '舞萌DX 状态查询失败，请稍后重试或联系管理员检查 Status 服务。'
      }
    })
}

export default { name, apply, Config }

