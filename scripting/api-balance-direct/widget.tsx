import { Widget, VStack, HStack, Text, Spacer, Script, fetch, Button, modifiers } from 'scripting'
import { RefreshAPIBalanceIntent } from './app_intents'

type StationConfig = {
  id: string
  name: string
  url: string
  userId?: string
  currency?: string
  quotaRatio?: number
}

type Config = {
  stations: StationConfig[]
}

type StationState = {
  id: string
  name: string
  url: string
  provider: string
  balance: number | null
  currency: 'CNY' | 'USD'
  balanceRmb: number | null
  todayTokens: number | null
  todaySpendRmb: number | null
  updatedAt: number
  error?: string | null
}

type WidgetState = {
  stations: StationState[]
  totalRmb: number | null
  todayTokens: number | null
  todaySpendRmb: number | null
  updatedAt: number
  error?: string | null
}

const CONFIG_KEY = 'api_balance.local.v1.config'
const STATE_KEY = 'api_balance.local.v1.widget.state'
const KEY_PREFIX = 'api_balance.local.v1.station.'
const FX_CACHE_KEY = 'api_balance.local.v1.fx.cache'
const REQUEST_TIMEOUT_MS = 12000
const DEFAULT_FX = 7.2
const FRESH_CACHE_MS = 60 * 1000
const AUTO_REFRESH_MS = 15 * 60 * 1000
const FORCE_REFRESH_KEY = 'api_balance.local.v1.force_refresh'

function defaultConfig(): Config {
  return {
    stations: [
      { id: '1', name: '', url: '', userId: '', currency: 'USD', quotaRatio: 500000 },
      { id: '2', name: '', url: '', userId: '', currency: 'USD', quotaRatio: 500000 },
    ],
  }
}

function loadConfig(): Config {
  const saved = Storage.get<any>(CONFIG_KEY, { shared: true })
  const base = defaultConfig()
  if (!saved || typeof saved !== 'object') return base
  const stations = Array.isArray(saved.stations) ? saved.stations.slice(0, 2) : []
  while (stations.length < 2) stations.push(base.stations[stations.length])
  return {
    stations: stations.map((x: any, i: number) => ({
      id: String(x?.id || i + 1),
      name: String(x?.name || ''),
      url: String(x?.url || ''),
      userId: String(x?.userId || ''),
      currency: String(x?.currency || 'USD').toUpperCase() === 'CNY' ? 'CNY' : 'USD',
      quotaRatio: Number(x?.quotaRatio) > 0 ? Number(x.quotaRatio) : 500000,
    })),
  }
}

function normalizeUrl(value: string): string {
  let input = String(value || '').trim()
  if (!input) return ''
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`
  return input.replace(/\/+$/, '')
}

function num(value: any): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(String(value).replace(/[,\s$¥￥]/g, ''))
  return Number.isFinite(n) ? n : null
}

function getPath(obj: any, path: string): any {
  return path.split('.').reduce((o: any, key: string) => {
    if (o === null || o === undefined) return undefined
    return o[/^\d+$/.test(key) ? Number(key) : key]
  }, obj)
}

function firstNumber(obj: any, paths: string[]): number | null {
  for (const path of paths) {
    const value = num(getPath(obj, path))
    if (value !== null) return value
  }
  return null
}

function providerOf(url: string): 'sole' | 'derouter' | 'newapi' {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host === 'soleapi.com' || host === 'www.soleapi.com') return 'sole'
    if (host === 'cf-api.derouter.ai' || host.endsWith('.derouter.ai')) return 'derouter'
  } catch {}
  return 'newapi'
}

async function fetchJson(url: string, token: string, extraHeaders: Record<string, string> = {}): Promise<any> {
  const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders }
  if (token) headers.Authorization = `Bearer ${token}`
  const response: any = await Promise.race([
    fetch(url, { headers }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), REQUEST_TIMEOUT_MS)),
  ])
  const text = await response.text()
  let json: any = null
  if (text) {
    try { json = JSON.parse(text) }
    catch { throw new Error(`返回内容不是 JSON（HTTP ${response.status}）`) }
  }
  if (!response.ok) throw new Error(String(json?.error?.message || json?.error || json?.message || `HTTP ${response.status}`))
  return json
}

async function currentFxRate(): Promise<number> {
  const cached = Storage.get<any>(FX_CACHE_KEY, { shared: true }) || null
  const sources = [
    { url: 'https://open.er-api.com/v6/latest/USD', name: 'open.er-api.com' },
    { url: 'https://api.exchangerate-api.com/v4/latest/USD', name: 'exchangerate-api.com' },
  ]

  for (const source of sources) {
    try {
      const json = await fetchJson(source.url, '')
      const rate = num(json?.rates?.CNY)
      if (rate !== null && rate > 0.5 && rate < 50) {
        Storage.set(FX_CACHE_KEY, { rate, updatedAt: Date.now(), source: source.name }, { shared: true })
        return rate
      }
    } catch {}
  }

  const cachedRate = num(cached?.rate)
  if (cachedRate !== null && cachedRate > 0.5 && cachedRate < 50) return cachedRate
  return DEFAULT_FX
}

function shanghaiDayKey(value: any): string {
  const date = new Date(value || 0)
  if (!Number.isFinite(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const p = (type: string) => parts.find((x: any) => x.type === type)?.value || ''
  return `${p('year')}-${p('month')}-${p('day')}`
}

function periodCost(period: any): number | null {
  if (!period || typeof period !== 'object' || Array.isArray(period)) return null
  const direct = firstNumber(period, [
    'cost', 'costUsd', 'cost_usd', 'costCNY', 'cost_cny', 'costRmb', 'cost_rmb',
    'amount', 'spent', 'spend', 'totalCost', 'total_cost', 'totalSpent', 'total_spent',
    'fee', 'credits', 'credit', 'billed', 'charge', 'charges', 'usedCredits', 'used_credits',
  ])
  if (direct !== null) return direct
  for (const value of Object.values(period)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const nested = firstNumber(value, [
      'cost', 'costUsd', 'cost_usd', 'costCNY', 'cost_cny', 'amount', 'spent', 'spend', 'fee', 'credits',
    ])
    if (nested !== null) return nested
  }
  return null
}

function todayCostFromUsage(json: any): number | null {
  const direct = firstNumber(json, [
    'periods.today.cost', 'periods.today.costUsd', 'periods.today.cost_usd',
    'periods.today.amount', 'periods.today.spent', 'periods.today.spend',
    'today.cost', 'today.costUsd', 'today.amount', 'today.spent',
    'usage.today.cost', 'usage.today.costUsd', 'usage.today.amount',
    'stats.todaySpend', 'stats.today_spend', 'summary.today.cost',
  ])
  if (direct !== null) return direct
  return periodCost(getPath(json, 'periods.today'))
    ?? periodCost(getPath(json, 'today'))
    ?? periodCost(getPath(json, 'usage.today'))
}

function shanghaiDayStartUnix(): number {
  const [year, month, day] = shanghaiDayKey(Date.now()).split('-').map(Number)
  return Math.floor(Date.UTC(year, month - 1, day, -8, 0, 0) / 1000)
}

function soleEndpoint(base: string): string {
  const u = new URL(base)
  return u.pathname.replace(/\/+$/, '') === '/v1/usage' ? u.toString() : `${u.origin}/v1/usage`
}

async function querySole(st: StationConfig, token: string, fxRate: number): Promise<StationState> {
  const json = await fetchJson(soleEndpoint(st.url), token)
  const balance = firstNumber(json, [
    'remaining', 'available', 'balance', 'credits',
    'summary.remaining', 'summary.available', 'data.remaining', 'data.available',
  ])
  const todayTokens = firstNumber(json, [
    'periods.today.totalTokens', 'periods.today.total_tokens',
    'today.totalTokens', 'today.total_tokens',
  ]) ?? (() => {
    const a = firstNumber(json, ['periods.today.promptTokens', 'periods.today.inputTokens'])
    const b = firstNumber(json, ['periods.today.completionTokens', 'periods.today.outputTokens'])
    return a !== null || b !== null ? (a || 0) + (b || 0) : null
  })()
  const todaySpend = todayCostFromUsage(json)
  return {
    id: st.id, name: st.name || 'Sole', url: st.url, provider: 'SoleAPI',
    balance, currency: 'CNY', balanceRmb: balance, todayTokens, todaySpendRmb: todaySpend,
    updatedAt: Date.now(), error: null,
  }
}

function derouterBase(base: string): { origin: string; subKey: boolean } {
  const u = new URL(base)
  const path = u.pathname.replace(/\/+$/, '')
  return { origin: u.origin, subKey: path === '/sub-key/balance' || path.startsWith('/sub-key/') }
}

function tokensFromPeriod(period: any): number | null {
  if (!period || typeof period !== 'object') return null
  const total = firstNumber(period, ['totalTokens', 'total_tokens'])
  if (total !== null) return total
  const input = firstNumber(period, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'])
  const output = firstNumber(period, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'])
  return input !== null || output !== null ? (input || 0) + (output || 0) : null
}

async function queryDerouterBalance(base: string, token: string): Promise<{ balance: number | null, todayTokens: number | null, todayCost: number | null }> {
  const info = derouterBase(base)
  const candidates = info.subKey
    ? [`${info.origin}/sub-key/balance`, `${info.origin}/balance`]
    : [`${info.origin}/balance`, `${info.origin}/sub-key/balance`]
  let lastError: any = null
  for (const url of candidates) {
    try {
      const json = await fetchJson(url, token)
      const balance = firstNumber(json, ['available', 'remaining', 'balance', 'data.available', 'data.remaining', 'data.balance'])
      const today = json?.usage?.today || json?.data?.usage?.today
      if (balance !== null || today) return { balance, todayTokens: tokensFromPeriod(today), todayCost: periodCost(today) }
    } catch (e) { lastError = e }
  }
  if (lastError) throw lastError
  return { balance: null, todayTokens: null, todayCost: null }
}

function tokensOfLog(row: any): number {
  const total = firstNumber(row, ['total_tokens', 'totalTokens'])
  if (total !== null) return total
  const input = firstNumber(row, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']) || 0
  const output = firstNumber(row, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']) || 0
  const cacheRead = firstNumber(row, ['cache_read_tokens', 'cacheReadTokens']) || 0
  const cacheWrite = firstNumber(row, ['cache_write_tokens', 'cacheWriteTokens']) || 0
  return input + output + cacheRead + cacheWrite
}

function costOfLog(row: any): number | null {
  return firstNumber(row, ['cost_usdc', 'costUsdc', 'cost_usd', 'costUsd', 'cost', 'amount', 'fee', 'spent'])
}

async function queryDerouterTodayFromLogs(base: string, token: string): Promise<{ tokens: number | null, cost: number | null }> {
  const info = derouterBase(base)
  const paths = info.subKey
    ? ['/sub-key/usage-logs?page=1&limit=100', '/usage-logs?page=1&limit=100']
    : ['/usage-logs?page=1&limit=100', '/sub-key/usage-logs?page=1&limit=100']

  let firstPath = ''
  let json: any = null
  let lastError: any = null
  for (const path of paths) {
    try {
      const candidate = await fetchJson(info.origin + path, token)
      if (Array.isArray(candidate?.data)) { firstPath = path; json = candidate; break }
    } catch (e) { lastError = e }
  }
  if (!json) {
    if (lastError) throw lastError
    return { tokens: null, cost: null }
  }

  const today = shanghaiDayKey(Date.now())
  let tokens = 0
  let cost = 0
  let seenToday = false
  let seenCost = false
  let calls = 0
  let cursor: any = undefined
  let page = Number(json?.pagination?.page) || 1
  let current = json

  while (current && calls < 8) {
    calls += 1
    const rows = Array.isArray(current.data) ? current.data : []
    let foundOlder = false
    for (const row of rows) {
      const key = shanghaiDayKey(row.created_at || row.createdAt || row.time || row.timestamp)
      if (!key) continue
      if (key === today) {
        seenToday = true
        tokens += tokensOfLog(row)
        const rowCost = costOfLog(row)
        if (rowCost !== null) { seenCost = true; cost += rowCost }
      } else if (key < today) foundOlder = true
    }
    if (foundOlder || !rows.length) break
    const pagination = current.pagination || {}
    if (pagination.hasMore === true && pagination.nextCursor !== null && pagination.nextCursor !== undefined && pagination.nextCursor !== cursor) {
      cursor = pagination.nextCursor
      const separator = firstPath.includes('?') ? '&' : '?'
      current = await fetchJson(`${info.origin}${firstPath}${separator}cursor=${encodeURIComponent(String(cursor))}`, token)
      continue
    }
    const pages = Number(pagination.pages || pagination.totalPages || pagination.total_pages || 0)
    const curPage = Number(pagination.page || page)
    if ((pages && curPage >= pages) || (!pages && rows.length < 100)) break
    page = curPage + 1
    if (page > 8) break
    const separator = firstPath.includes('?') ? '&' : '?'
    current = await fetchJson(`${info.origin}${firstPath}${separator}page=${page}`, token)
  }
  return { tokens: seenToday ? tokens : 0, cost: seenCost ? cost : (seenToday ? null : 0) }
}

async function queryDerouter(st: StationConfig, token: string, fxRate: number): Promise<StationState> {
  let snap = { balance: null as number | null, todayTokens: null as number | null, todayCost: null as number | null }
  let balanceError: any = null
  try { snap = await queryDerouterBalance(st.url, token) } catch (e) { balanceError = e }
  let logs = { tokens: null as number | null, cost: null as number | null }
  let logError: any = null
  if (snap.todayTokens === null || snap.todayCost === null) {
    try { logs = await queryDerouterTodayFromLogs(st.url, token) } catch (e) { logError = e }
  }
  const balance = snap.balance
  const todayTokens = snap.todayTokens !== null ? snap.todayTokens : logs.tokens
  const todayCost = snap.todayCost !== null ? snap.todayCost : logs.cost
  if (balance === null && todayTokens === null && todayCost === null) throw balanceError || logError || new Error('无法读取数据')
  return {
    id: st.id, name: st.name || 'derouter', url: st.url, provider: 'derouter',
    balance, currency: 'USD', balanceRmb: balance === null ? null : balance * fxRate,
    todayTokens, todaySpendRmb: todayCost === null ? null : todayCost * fxRate,
    updatedAt: Date.now(), error: null,
  }
}

async function queryNewApiTodaySpend(st: StationConfig, token: string, headers: Record<string, string>, ratio: number): Promise<number | null> {
  const start = shanghaiDayStartUnix()
  const end = Math.floor(Date.now() / 1000) + 120
  const attempts = [
    `${st.url}/api/log/self/stat?type=2&start_timestamp=${start}&end_timestamp=${end}`,
    `${st.url}/api/log/stat?type=2&start_timestamp=${start}&end_timestamp=${end}`,
  ]
  for (const url of attempts) {
    try {
      const json = await fetchJson(url, token, headers)
      if (json?.success === false) continue
      const quota = firstNumber(json, ['data.quota', 'quota'])
      if (quota !== null) return quota / ratio
    } catch {}
  }
  try {
    const json = await fetchJson(`${st.url}/api/data/self?start_timestamp=${start}&end_timestamp=${end}`, token, headers)
    const rows = Array.isArray(json?.data) ? json.data : []
    const todayKey = shanghaiDayKey(Date.now())
    let quota = 0
    let found = false
    for (const row of rows) {
      const raw = row?.date || row?.day || row?.created_at || row?.createdAt || row?.timestamp
      let key = ''
      if (typeof raw === 'number' || /^\d+$/.test(String(raw || ''))) {
        const n = Number(raw)
        key = shanghaiDayKey(n > 100000000000 ? n : n * 1000)
      } else {
        key = String(raw || '').slice(0, 10)
        if (/^\d{8}$/.test(key)) key = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`
      }
      if (key !== todayKey) continue
      const value = firstNumber(row, ['quota', 'used_quota', 'usedQuota'])
      if (value !== null) { found = true; quota += value }
    }
    if (found) return quota / ratio
  } catch {}
  return null
}

async function queryNewApi(st: StationConfig, token: string, fxRate: number): Promise<StationState> {
  const headers: Record<string, string> = {}
  if (st.userId?.trim()) headers['New-Api-User'] = st.userId.trim()
  const json = await fetchJson(`${st.url}/api/user/self`, token, headers)
  const quota = firstNumber(json, ['data.quota', 'quota'])
  if (quota === null) throw new Error('无法识别余额字段 data.quota')
  const ratio = Number(st.quotaRatio) > 0 ? Number(st.quotaRatio) : 500000
  const balance = quota / ratio
  const currency: 'CNY' | 'USD' = String(st.currency).toUpperCase() === 'CNY' ? 'CNY' : 'USD'
  let todaySpend: number | null = null
  try { todaySpend = await queryNewApiTodaySpend(st, token, headers, ratio) } catch { todaySpend = null }
  return {
    id: st.id, name: st.name || 'API 站点', url: st.url, provider: 'New-API / One-API',
    balance, currency, balanceRmb: currency === 'CNY' ? balance : balance * fxRate,
    todayTokens: null, todaySpendRmb: todaySpend === null ? null : (currency === 'CNY' ? todaySpend : todaySpend * fxRate),
    updatedAt: Date.now(), error: null,
  }
}

async function queryStation(st: StationConfig, fxRate: number): Promise<StationState> {
  const url = normalizeUrl(st.url)
  if (!url) throw new Error('未填写 API URL')
  const token = Keychain.get(`${KEY_PREFIX}${st.id}.key`) || ''
  if (!token.trim()) throw new Error('未填写 API Key')
  const normalized = { ...st, url }
  const provider = providerOf(url)
  if (provider === 'sole') return querySole(normalized, token.trim(), fxRate)
  if (provider === 'derouter') return queryDerouter(normalized, token.trim(), fxRate)
  return queryNewApi(normalized, token.trim(), fxRate)
}

async function syncAll(): Promise<WidgetState> {
  const config = loadConfig()
  const previous = Storage.get<WidgetState>(STATE_KEY, { shared: true }) || null
  const enabled = config.stations.filter(st => normalizeUrl(st.url))
  if (!enabled.length) throw new Error('未配置站点')
  const fxRate = await currentFxRate()
  const settled = await Promise.allSettled(enabled.map(st => queryStation(st, fxRate)))
  const rows: StationState[] = settled.map((result, index) => {
    const st = enabled[index]
    if (result.status === 'fulfilled') return result.value
    const old = previous?.stations?.find(x => x.id === st.id)
    if (old) return { ...old, name: st.name || old.name, url: st.url, error: result.reason?.message || String(result.reason) }
    return {
      id: st.id, name: st.name || `站点 ${st.id}`, url: st.url,
      provider: providerOf(normalizeUrl(st.url)), balance: null, currency: 'USD', balanceRmb: null,
      todayTokens: null, todaySpendRmb: null, updatedAt: Date.now(), error: result.reason?.message || String(result.reason),
    }
  })
  const knownBalances = rows.map(x => x.balanceRmb).filter((x): x is number => x !== null)
  const knownTokens = rows.map(x => x.todayTokens).filter((x): x is number => x !== null)
  const spendValues = rows.map(x => x.todaySpendRmb)
  const errors = rows.filter(x => x.error).map(x => `${x.name}: ${x.error}`)
  const next: WidgetState = {
    stations: rows,
    totalRmb: knownBalances.length ? knownBalances.reduce((a, b) => a + b, 0) : null,
    todayTokens: knownTokens.length ? knownTokens.reduce((a, b) => a + b, 0) : null,
    todaySpendRmb: spendValues.length && spendValues.every(x => x !== null && x !== undefined)
      ? spendValues.reduce((sum, value) => sum + (value || 0), 0)
      : null,
    updatedAt: Date.now(),
    error: errors.length ? errors.join('；') : null,
  }
  Storage.set(STATE_KEY, next, { shared: true })
  return next
}

async function load(): Promise<WidgetState | null> {
  const cached = Storage.get<WidgetState>(STATE_KEY, { shared: true }) || null
  const forceRefresh = Boolean(Storage.get<any>(FORCE_REFRESH_KEY, { shared: true }))
  if (forceRefresh) Storage.set(FORCE_REFRESH_KEY, false, { shared: true })
  if (!forceRefresh && cached?.updatedAt && Date.now() - cached.updatedAt < FRESH_CACHE_MS) return cached
  try { return await syncAll() }
  catch { return cached }
}

function one(v: any): string {
  const n = num(v)
  return n === null ? '未知' : n.toFixed(1)
}

function compact(v: any): string {
  const n = num(v)
  if (n === null) return '未知'
  if (Math.abs(n) >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`
  return n.toFixed(1)
}

function money(v: any): string {
  const n = num(v)
  if (n === null) return '未知'
  return n.toFixed(1)
}

function StationColumn({ station }: { station: StationState }) {
  return (
    <VStack alignment="center" spacing={0}>
      <Text font="caption2" fontWeight="semibold">{station.name || '未命名'}</Text>
      <Text font="caption" fontWeight="bold">¥{one(station.balanceRmb)}</Text>
      <Text font="caption2" foregroundStyle="secondaryLabel">{compact(station.todayTokens)}</Text>
    </VStack>
  )
}

function MetricColumn({ value, label, accent }: { value: string, label: string, accent: boolean }) {
  return (
    <VStack alignment="center" spacing={0}>
      <Text font="headline" fontWeight="bold" foregroundStyle={accent ? 'systemGreen' : 'primary'}>{value}</Text>
      <Text font="caption2" foregroundStyle="secondaryLabel">{label}</Text>
    </VStack>
  )
}

function View({ state }: { state: WidgetState | null }) {
  const stations = (state?.stations || []).slice(0, 2)
  const updated = state?.updatedAt
    ? new Date(state.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '--:--'
  const empty: StationState = {
    id: '0', name: '未配置', url: '', provider: '', balance: null, currency: 'USD',
    balanceRmb: null, todayTokens: null, todaySpendRmb: null, updatedAt: 0,
  }
  const left = stations[0] || empty
  const right = stations[1] || empty

  return (
    <Button
      intent={RefreshAPIBalanceIntent(undefined)}
      buttonStyle="plain"
      modifiers={modifiers().frame({ maxWidth: 'infinity', maxHeight: 'infinity' })}
    >
      <VStack spacing={0} padding={{ top: 10, bottom: 16, leading: 0, trailing: 0 }} frame={{ maxWidth: 'infinity', maxHeight: 'infinity' }}>
        <Text font="subheadline" fontWeight="bold" frame={{ maxWidth: 'infinity', alignment: 'center' }}>API 总览</Text>
        <Spacer />
        <HStack alignment="center" spacing={0}>
          <Spacer />
          <VStack alignment="center" frame={{ width: 74, alignment: 'center' }}>
            <MetricColumn
              value={`¥${one(state?.totalRmb)}`}
              label="总余额"
              accent={state?.totalRmb !== null && state?.totalRmb !== undefined}
            />
          </VStack>
          <Spacer />
          <VStack alignment="center" frame={{ width: 74, alignment: 'center' }}>
            <MetricColumn
              value={`¥${money(state?.todaySpendRmb)}`}
              label="今日消耗"
              accent={false}
            />
          </VStack>
          <Spacer />
        </HStack>
        <Spacer />
        <HStack alignment="center" spacing={0}>
          <Spacer />
          <VStack alignment="center" frame={{ width: 74, alignment: 'center' }}>
            <StationColumn station={left} />
          </VStack>
          <Spacer />
          <VStack alignment="center" frame={{ width: 74, alignment: 'center' }}>
            {stations[1] ? <StationColumn station={right} /> : <Text> </Text>}
          </VStack>
          <Spacer />
        </HStack>
        <Spacer />
        <Text font="caption2" foregroundStyle="secondaryLabel" frame={{ maxWidth: 'infinity', alignment: 'center' }}>
          更新 {updated}
        </Text>
      </VStack>
    </Button>
  )
}

async function main() {
  const state = await load()
  Widget.present(<View state={state} />, {
    family: 'systemSmall',
    supportedFamilies: ['systemSmall'],
    reloadPolicy: { policy: 'after', date: new Date(Date.now() + AUTO_REFRESH_MS) },
  })
  Script.exit()
}

main()
