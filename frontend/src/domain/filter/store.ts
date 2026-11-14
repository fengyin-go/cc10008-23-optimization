import { readJson, writeJson } from '@/data/local-store'
import { hashConfig } from './blocks'
import type {
  DatasetDefinition,
  DatasetValue,
  DrillResult,
  FilterRule,
  FilterRuleConfig,
  HitRecord,
  RuleRun,
  RuleVersion,
  ShardTask,
} from './types'

const STORAGE_KEY = 'interactive-analytics-lab:filter-engine'
/**
 * 分块缓存不落盘：它是可重建的派生数据。规则版本、命中溯源、下钻快照与分片任务
 * 才是需要跨刷新保留的部分。
 */
const ENGINE_VERSION = 3

export interface FilterState {
  engineVersion: number
  datasets: DatasetDefinition[]
  rules: FilterRule[]
  versions: RuleVersion[]
  runs: RuleRun[]
  hits: HitRecord[]
  drills: DrillResult[]
  shardTasks: ShardTask[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function dataset(
  id: string,
  name: string,
  sourceTable: string,
  fields: { name: string; type: DatasetDefinition['fields'][number]['type'] }[],
  rows: { id: number; values: Record<string, DatasetValue> }[],
): DatasetDefinition {
  return { id, name, sourceTable, schemaVersion: 1, revision: 1, fields, rows }
}

/** 示例数据集：字段类型有明确声明，行值严格按声明类型解释，不做隐式强转。 */
const SEED_DATASETS: DatasetDefinition[] = [
  dataset(
    'ds-orders',
    '订单明细',
    'ods_order_detail',
    [
      { name: '订单编号', type: 'string' },
      { name: '客户编号', type: 'string' },
      { name: '区域', type: 'string' },
      { name: '金额', type: 'number' },
      { name: '数量', type: 'number' },
      { name: '是否退款', type: 'boolean' },
      { name: '下单日期', type: 'date' },
      { name: '渠道', type: 'string' },
    ],
    [
      { id: 1, values: { 订单编号: 'ORD-0001', 客户编号: 'C-101', 区域: '华东', 金额: 1280, 数量: 4, 是否退款: false, 下单日期: '2026-03-02', 渠道: '小程序' } },
      { id: 2, values: { 订单编号: 'ORD-0002', 客户编号: 'C-102', 区域: '华南', 金额: 96.5, 数量: 1, 是否退款: true, 下单日期: '2026-03-05', 渠道: 'APP' } },
      { id: 3, values: { 订单编号: 'ORD-0003', 客户编号: 'C-103', 区域: '华北', 金额: 4300, 数量: 12, 是否退款: false, 下单日期: '2026-03-11', 渠道: '网页' } },
      { id: 4, values: { 订单编号: 'ORD-0004', 客户编号: 'C-101', 区域: '华东', 金额: 520, 数量: 2, 是否退款: false, 下单日期: '2026-04-01', 渠道: 'APP' } },
      { id: 5, values: { 订单编号: 'ORD-0005', 客户编号: 'C-104', 区域: '西南', 金额: 87, 数量: 1, 是否退款: true, 下单日期: '2026-04-08', 渠道: '小程序' } },
      { id: 6, values: { 订单编号: 'ORD-0006', 客户编号: 'C-105', 区域: '华东', 金额: 2650, 数量: 8, 是否退款: false, 下单日期: '2026-04-19', 渠道: '网页' } },
      { id: 7, values: { 订单编号: 'ORD-0007', 客户编号: 'C-102', 区域: '华南', 金额: 740, 数量: 3, 是否退款: false, 下单日期: '2026-05-03', 渠道: 'APP' } },
      { id: 8, values: { 订单编号: 'ORD-0008', 客户编号: 'C-106', 区域: '东北', 金额: 15800, 数量: 40, 是否退款: false, 下单日期: '2026-05-17', 渠道: '网页' } },
      { id: 9, values: { 订单编号: 'ORD-0009', 客户编号: 'C-107', 区域: '华北', 金额: 36, 数量: 1, 是否退款: true, 下单日期: '2026-06-02', 渠道: '小程序' } },
      { id: 10, values: { 订单编号: 'ORD-0010', 客户编号: 'C-108', 区域: '华东', 金额: 398, 数量: 2, 是否退款: false, 下单日期: '2026-06-15', 渠道: 'APP' } },
      { id: 11, values: { 订单编号: 'ORD-0011', 客户编号: 'C-109', 区域: '西北', 金额: 2150, 数量: 7, 是否退款: false, 下单日期: '2026-07-01', 渠道: '网页' } },
      { id: 12, values: { 订单编号: 'ORD-0012', 客户编号: 'C-105', 区域: '华东', 金额: 0, 数量: 0, 是否退款: true, 下单日期: '2026-07-09', 渠道: 'APP' } },
    ],
  ),
  dataset(
    'ds-members',
    '会员活跃',
    'dwd_member_active',
    [
      { name: '会员编号', type: 'string' },
      { name: '会员等级', type: 'string' },
      { name: '最近登录日期', type: 'date' },
      { name: '近30天活跃天数', type: 'number' },
      { name: '累计消费金额', type: 'number' },
      { name: '是否黑名单', type: 'boolean' },
    ],
    [
      { id: 1, values: { 会员编号: 'M-001', 会员等级: '金卡', 最近登录日期: '2026-09-01', 近30天活跃天数: 21, 累计消费金额: 8600, 是否黑名单: false } },
      { id: 2, values: { 会员编号: 'M-002', 会员等级: '银卡', 最近登录日期: '2026-08-12', 近30天活跃天数: 3, 累计消费金额: 940, 是否黑名单: false } },
      { id: 3, values: { 会员编号: 'M-003', 会员等级: '普通', 最近登录日期: '2026-05-20', 近30天活跃天数: 0, 累计消费金额: 120, 是否黑名单: true } },
      { id: 4, values: { 会员编号: 'M-004', 会员等级: '金卡', 最近登录日期: '2026-09-10', 近30天活跃天数: 28, 累计消费金额: 15200, 是否黑名单: false } },
      { id: 5, values: { 会员编号: 'M-005', 会员等级: '银卡', 最近登录日期: '2026-07-30', 近30天活跃天数: 9, 累计消费金额: 2100, 是否黑名单: false } },
      { id: 6, values: { 会员编号: 'M-006', 会员等级: '普通', 最近登录日期: '2026-08-25', 近30天活跃天数: 14, 累计消费金额: 460, 是否黑名单: false } },
      { id: 7, values: { 会员编号: 'M-007', 会员等级: '钻石', 最近登录日期: '2026-09-12', 近30天活跃天数: 30, 累计消费金额: 47800, 是否黑名单: false } },
      { id: 8, values: { 会员编号: 'M-008', 会员等级: '银卡', 最近登录日期: '2026-06-18', 近30天活跃天数: 2, 累计消费金额: 780, 是否黑名单: true } },
    ],
  ),
  dataset(
    'ds-events',
    '访问事件',
    'dwd_visit_event',
    [
      { name: '事件编号', type: 'string' },
      { name: '事件名称', type: 'string' },
      { name: '来源省份', type: 'string' },
      { name: '停留秒数', type: 'number' },
      { name: '是否转化', type: 'boolean' },
      { name: '事件时间', type: 'date' },
    ],
    [
      { id: 1, values: { 事件编号: 'EVT-0001', 事件名称: 'page_view', 来源省份: '浙江', 停留秒数: 12, 是否转化: false, 事件时间: '2026-09-01' } },
      { id: 2, values: { 事件编号: 'EVT-0002', 事件名称: 'add_cart', 来源省份: '江苏', 停留秒数: 45, 是否转化: true, 事件时间: '2026-09-02' } },
      { id: 3, values: { 事件编号: 'EVT-0003', 事件名称: 'page_view', 来源省份: '广东', 停留秒数: 3, 是否转化: false, 事件时间: '2026-09-02' } },
      { id: 4, values: { 事件编号: 'EVT-0004', 事件名称: 'checkout', 来源省份: '浙江', 停留秒数: 130, 是否转化: true, 事件时间: '2026-09-03' } },
      { id: 5, values: { 事件编号: 'EVT-0005', 事件名称: 'page_view', 来源省份: '四川', 停留秒数: 7, 是否转化: false, 事件时间: '2026-09-04' } },
      { id: 6, values: { 事件编号: 'EVT-0006', 事件名称: 'search', 来源省份: '湖北', 停留秒数: 21, 是否转化: false, 事件时间: '2026-09-05' } },
      { id: 7, values: { 事件编号: 'EVT-0007', 事件名称: 'add_cart', 来源省份: '浙江', 停留秒数: 88, 是否转化: true, 事件时间: '2026-09-06' } },
      { id: 8, values: { 事件编号: 'EVT-0008', 事件名称: 'checkout', 来源省份: '上海', 停留秒数: 300, 是否转化: true, 事件时间: '2026-09-07' } },
    ],
  ),
]

function seedRule(
  id: string,
  name: string,
  description: string,
  config: FilterRuleConfig,
  displayColumns: string[],
  status: FilterRule['status'],
  stamp: string,
): FilterRule {
  return {
    id,
    name,
    description,
    config,
    displayColumns,
    status,
    latestVersionId: '',
    needsRevalidation: false,
    createdAt: stamp,
    updatedAt: stamp,
  }
}

function seedState(): FilterState {
  const rules: FilterRule[] = [
    seedRule(
      'rule-seed-1',
      '华东大额订单',
      '华东区域且金额不低于 300 的订单，用于大客户跟进。',
      {
        datasetId: 'ds-orders',
        conditions: [
          { id: 'c1', field: '区域', operator: '=', value: '华东', combination: 'AND' },
          { id: 'c2', field: '金额', operator: '>=', value: '300', combination: 'AND' },
        ],
        sortField: '金额',
        sortDirection: 'desc',
        limit: 50,
      },
      ['订单编号', '区域', '金额', '下单日期'],
      'enabled',
      '2026-09-01T09:00:00.000Z',
    ),
    seedRule(
      'rule-seed-2',
      '高价值活跃会员',
      '金卡以上且近 30 天活跃的会员，用于会员运营触达。',
      {
        datasetId: 'ds-members',
        conditions: [
          { id: 'c1', field: '会员等级', operator: 'in', value: '金卡,钻石', combination: 'AND' },
          { id: 'c2', field: '近30天活跃天数', operator: '>=', value: '15', combination: 'AND' },
        ],
        sortField: '累计消费金额',
        sortDirection: 'desc',
        limit: 30,
      },
      ['会员编号', '会员等级', '近30天活跃天数', '累计消费金额'],
      'enabled',
      '2026-09-02T09:00:00.000Z',
    ),
    seedRule(
      'rule-seed-3',
      '疑似异常流量',
      '停留时间过短且未转化的访问事件，用于排查异常流量。',
      {
        datasetId: 'ds-events',
        conditions: [
          { id: 'c1', field: '停留秒数', operator: '<', value: '10', combination: 'AND' },
          { id: 'c2', field: '是否转化', operator: '=', value: 'false', combination: 'AND' },
        ],
        sortField: '停留秒数',
        sortDirection: 'asc',
        limit: 100,
      },
      ['事件编号', '事件名称', '来源省份', '停留秒数'],
      'disabled',
      '2026-09-03T09:00:00.000Z',
    ),
  ]

  const versions: RuleVersion[] = rules.map((rule, index) => {
    const id = `v-seed-${index + 1}`
    rule.latestVersionId = id
    return {
      id,
      ruleId: rule.id,
      versionNo: 1,
      datasetId: rule.config.datasetId,
      conditions: clone(rule.config.conditions),
      configHash: hashConfig(rule.config),
      datasetSchemaVersion: SEED_DATASETS.find((item) => item.id === rule.config.datasetId)?.schemaVersion ?? 1,
      createdAt: rule.createdAt,
    }
  })

  return {
    engineVersion: ENGINE_VERSION,
    datasets: clone(SEED_DATASETS),
    rules,
    versions,
    runs: [],
    hits: [],
    drills: [],
    shardTasks: [],
  }
}

let state: FilterState | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只接受结构完整的持久化数据：损坏或被旧版本写过头的状态回落到示例数据。 */
export function normalizeState(parsed: Partial<FilterState>): FilterState {
  const fallback = seedState()
  if (!isRecord(parsed)) {
    return fallback
  }
  const datasets = Array.isArray(parsed.datasets) ? parsed.datasets : fallback.datasets
  const rules = Array.isArray(parsed.rules) ? parsed.rules : fallback.rules
  const versions = Array.isArray(parsed.versions) ? parsed.versions : fallback.versions
  // 规则引用的版本必须真实存在，否则下钻与执行都会读到空版本。
  const rulesWithVersions = rules.filter((rule) =>
    rule.latestVersionId === '' || versions.some((version) => version.id === rule.latestVersionId),
  )
  return {
    engineVersion: ENGINE_VERSION,
    datasets,
    rules: rulesWithVersions,
    versions,
    runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    hits: Array.isArray(parsed.hits) ? parsed.hits : [],
    drills: Array.isArray(parsed.drills) ? parsed.drills : [],
    shardTasks: Array.isArray(parsed.shardTasks) ? parsed.shardTasks : [],
  }
}

export function loadFilterState(): FilterState {
  if (state !== null) {
    return state
  }
  const raw = readJson<Partial<FilterState> | null>(STORAGE_KEY, null)
  if (raw && raw.engineVersion === ENGINE_VERSION) {
    state = normalizeState(raw)
    return state
  }
  state = seedState()
  writeJson(STORAGE_KEY, state)
  return state
}

export function saveFilterState(next: FilterState): void {
  state = next
  writeJson(STORAGE_KEY, next)
}

export function seedFilterState(): FilterState {
  return seedState()
}

export function resetFilterState(): FilterState {
  state = seedState()
  writeJson(STORAGE_KEY, state)
  return state
}

export function filterStorageKey(): string {
  return STORAGE_KEY
}
