import { Context, h, Logger, Schema } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import * as path from 'path'
import * as fs from 'fs'

const logger = new Logger('awmc-maimaidx-status')

export const name = 'awmc-maimaidx-status'

export const inject = ['puppeteer']

export interface Config {
  /**
   * Status / Uptime Kuma 反代根地址
   * 例如：
   * - https://status.awmc.cc
   * - https://miku.milkawa.xyz
   */
  baseUrl: string

  /**
   * 连续多少个 heartbeat 为掉线(0)时显示为「离线」
   */
  continuousDown: number

  /**
   * 近多少分钟内的心跳用来判断「近期状态」
   */
  recentMinutes: number

  /**
   * 发送消息模式
   * - text: 消息（纯文本）
   * - forward: 消息（聊天记录）
   * - image: 图片
   */
  outputMode: 'text' | 'forward' | 'image'

  /**
   * 图片缓存时间 (分钟)
   */
  cacheTime: number

  /**
   * 截图页面的 URL
   */
  screenshotUrl: string
}

export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string()
    .default('https://miku.milkawa.xyz')
    .description('Status / Uptime Kuma 反代根地址（推荐使用全球加速节点 miku.milkawa.xyz，也可填写 https://status.awmc.cc 等）。'),
  continuousDown: Schema.number()
    .default(3)
    .description('连续多少个 heartbeat 为掉线(0)时显示为「离线」。'),
  recentMinutes: Schema.number()
    .default(15)
    .description('用于统计「近多少分钟状态」的时间窗口。'),
  outputMode: Schema.union([
    Schema.const('text').description('消息（纯文本）'),
    Schema.const('forward').description('消息（聊天记录/合并转发）'),
    Schema.const('image').description('图片'),
  ]).default('text').description('发送状态消息的模式。'),
  cacheTime: Schema.number()
    .default(5)
    .description('图片缓存时间 (分钟)'),
  screenshotUrl: Schema.string()
    .default('https://status.awmc.cc/status/maimai-lite')
    .description('截图页面的 URL 地址。')
})

/** /api/status-page/maimai 返回的结构 */
interface StatusPageApiResponse {
  config?: { title?: string }
  incidents?: StatusIncident[]
  publicGroupList?: StatusGroup[]
  maintenanceList?: StatusMaintenance[]
}

interface StatusIncident {
  id: number
  title: string
  content?: string
  active?: boolean
}

interface StatusMaintenance {
  id: number
  title: string
  description?: string
  status?: string
  active?: boolean
  dateRange?: [string, string]
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

/**
 * API 返回的单项：time 可能是时间戳(ms) 或 "YYYY-MM-DD HH:mm:ss.SSS" 字符串
 * status: 0 掉线 | 1 在线 | 2 不稳定 | 3 维护中
 */
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
  uptimeList?: Record<string, number>
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

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim()
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

  // 0 掉线 1 在线 2 不稳定。单次查询中用 🟨 表示不稳定；总结中只把 0 当作异常，忽略 2
  let statusEmoji = '⬜'
  let statusText = '未知'

  if (!list.length || !last) {
    statusEmoji = '⬜'
    statusText = '未知'
  } else {
    const n = config.continuousDown
    const lastN = list.slice(-n)
    const isOffline = lastN.length >= n && lastN.every((e) => e.status === 0)

    if (isOffline) {
      statusEmoji = '🟥'
      statusText = '离线'
    } else if (last.status === 0) {
      statusEmoji = '🟨'
      statusText = '不稳定'
    } else if (last.status === 2) {
      statusEmoji = '🟨'
      statusText = '不稳定'
    } else if (last.status === 3) {
      statusEmoji = '🟦'
      statusText = '维护中'
    } else {
      statusEmoji = '🟩'
      statusText = '在线'
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
    // 总结中仅把 0（掉线）计为异常，忽略 2（不稳定）
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

// 进程内缓存，设置分钟内复用截图
let lastScreenshot: Buffer | null = null
let lastFetchedAt: number | null = null

export function apply(ctx: Context, config: Config) {
  // 插件启动时初始化缓存目录
  const cacheDir = path.resolve(ctx.baseDir, 'cache/maimai-status')
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true })
    ctx.logger.info(`Created cache directory: ${cacheDir}`)
  }
  const base = config.baseUrl.replace(/\/$/, '')
  const statusPageUrl = `${base}/api/status-page/maimai`
  const heartbeatUrl = `${base}/api/status-page/heartbeat/maimai`

  async function getScreenshot(session: any) {
    if (!session) return
    // 使用缓存
    const cacheFile = path.resolve(ctx.baseDir, 'cache/maimai-status/maimai-status.png')
    if (lastScreenshot && lastFetchedAt && Date.now() - lastFetchedAt < config.cacheTime * 60 * 1000) {
      ctx.logger.info(`在缓存时间内，发送缓存图片`)
      return h.image(lastScreenshot, 'image/png')
    }
    const url = config.screenshotUrl

    let page
    try {
      await session.send('获取数据中，请稍后喵~')
      page = await ctx.puppeteer.page();
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'language', { get: () => 'zh-CN' });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
        (window as any).chrome = { runtime: {} };
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters: any) => (
          parameters.name === 'notifications'
            ? Promise.resolve({ state: 'denied' } as PermissionStatus)
            : originalQuery(parameters)
        );
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5]
        });
        Object.defineProperty(navigator, 'languages', {
          get: () => ['zh-CN', 'zh', 'en']
        });
      })

      await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 })

      const PAGE_LOAD_TIMEOUT_MS = 30000

      await page.setDefaultNavigationTimeout(PAGE_LOAD_TIMEOUT_MS)
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: PAGE_LOAD_TIMEOUT_MS,
      })

      await new Promise(resolve => setTimeout(resolve, 500))

      const buffer = await page.screenshot({
        fullPage: true,
      })

      // 更新缓存
      lastScreenshot = buffer as Buffer
      lastFetchedAt = Date.now()
      try {
        fs.writeFileSync(cacheFile, buffer)
      } catch (writeErr) {
        ctx.logger.warn(`Failed to write cache file: ${writeErr}`)
      }

      // 返回图片
      return h.image(buffer, 'image/png')
    } catch (err) {
      ctx.logger.error(err)
      return '截图失败，详见后台日志'
    } finally {
      if (page) await page.close()
    }
  }

  ctx.command('maidx.status', '查询舞萌DX服务器当前状态（AWMC / Uptime Kuma）')
    .alias('maimai.status')
    .alias('舞萌状态')
    .action(async ({ session }) => {
      if (!session) return
      if (config.outputMode === 'image') {
        return getScreenshot(session)
      }
      try {
        const [pageJson, heartbeatJson] = await Promise.all([
          ctx.http.get<StatusPageApiResponse>(statusPageUrl),
          ctx.http.get<UptimeKumaHeartbeatResponse>(heartbeatUrl),
        ])

        const groups = pageJson?.publicGroupList ?? []
        const heartbeatMapRaw = heartbeatJson?.heartbeatList ?? {}
        const title = pageJson?.config?.title ?? 'maimaiDX Server Status Regen'

        const groupBlocks: string[] = []
        groupBlocks.push(title)

        const incidents = pageJson?.incidents ?? []
        const activeIncidents = incidents.filter((i) => i.active !== false)
        if (activeIncidents.length > 0) {
          const incidentLines: string[] = ['【公告】']
          for (const inc of activeIncidents) {
            incidentLines.push(`${inc.title}`)
            if (inc.content) incidentLines.push(stripHtml(inc.content))
          }
          groupBlocks.push(incidentLines.join('\n'))
        }

        const maintenanceList = pageJson?.maintenanceList ?? []
        const activeMaintenance = maintenanceList.filter(
          (m) => m.status === 'under-maintenance' || m.active === true,
        )
        if (activeMaintenance.length > 0) {
          const maintLines: string[] = ['【维护】']
          for (const m of activeMaintenance) {
            maintLines.push(`${m.title}`)
            if (m.description) maintLines.push(stripHtml(m.description))
            if (m.dateRange?.length === 2) {
              maintLines.push(`时间：${m.dateRange[0]} ～ ${m.dateRange[1]}`)
            }
          }
          groupBlocks.push(maintLines.join('\n'))
        }

        const uptimeList = heartbeatJson?.uptimeList ?? {}
        for (const group of groups.sort((a, b) => a.weight - b.weight)) {
          const blockLines: string[] = [group.name]
          for (const monitor of group.monitorList) {
            const key = String(monitor.id)
            const rawList = heartbeatMapRaw[key]
            const list = normalizeHeartbeatList(rawList)
            const ratio24 = uptimeList[`${monitor.id}_24`]
            const ratio =
              typeof ratio24 === 'number' && Number.isFinite(ratio24) ? ratio24 : undefined
            blockLines.push(...formatStatus(monitor, list, config, ratio))
          }
          groupBlocks.push(blockLines.join('\n'))
        }

        const fullText = groupBlocks.join('\n')
        if (config.outputMode === 'forward' && groupBlocks.length > 0) {
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
      } catch (error) {
        logger.error(error)
        return '舞萌DX 状态查询失败，请稍后重试或联系管理员检查 Status 服务。'
      }
    })

  ctx.command('maidx.screenshot', '获取舞萌DX服务器状态截图')
    .alias('有网吗')
    .action(async ({ session }) => {
      return getScreenshot(session)
    })
}

export default { name, apply, Config, inject }

