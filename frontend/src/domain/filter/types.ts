/** 筛选引擎的领域类型：规则、版本、分块缓存、命中溯源与下钻/分片读取快照。 */

export type FieldType = 'string' | 'number' | 'date' | 'boolean'

export const FIELD_TYPES: FieldType[] = ['string', 'number', 'date', 'boolean']

export type ComparisonOperator =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'contains'
  | 'regex'
  | 'in'

export const COMPARISON_OPERATORS: ComparisonOperator[] = [
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'contains',
  'regex',
  'in',
]

/** 等值类比较：与区间类比较在同一 AND 分块内互斥。 */
export const EQUALITY_OPERATORS: ComparisonOperator[] = ['=', '!=', 'contains', 'regex', 'in']
/** 区间类比较。 */
export const RANGE_OPERATORS: ComparisonOperator[] = ['>', '>=', '<', '<=']

export const OPERATOR_LABELS: Record<ComparisonOperator, string> = {
  '=': '等于',
  '!=': '不等于',
  '>': '大于',
  '>=': '大于等于',
  '<': '小于',
  '<=': '小于等于',
  contains: '包含',
  regex: '正则匹配',
  in: '属于',
}

export type LogicalCombination = 'AND' | 'OR'
export const LOGICAL_COMBINATIONS: LogicalCombination[] = ['AND', 'OR']

export type RuleStatus = 'draft' | 'validated' | 'enabled' | 'disabled'
export type SortDirection = 'asc' | 'desc'

export const RULE_STATUS_LABELS: Record<RuleStatus, string> = {
  draft: '草稿',
  validated: '已校验',
  enabled: '已启用',
  disabled: '已停用',
}

export interface DatasetField {
  name: string
  type: FieldType
}

export type DatasetValue = string | number | boolean

export interface DatasetRow {
  id: number
  values: Record<string, DatasetValue>
}

export interface DatasetDefinition {
  id: string
  name: string
  sourceTable: string
  /** 字段结构版本：字段增删或类型变化时递增。 */
  schemaVersion: number
  /** 数据内容版本：行数据变化时递增。 */
  revision: number
  fields: DatasetField[]
  rows: DatasetRow[]
}

export interface FilterCondition {
  id: string
  field: string
  operator: ComparisonOperator
  value: string
  combination: LogicalCombination
}

/** 一条规则的草稿配置：筛选条件 + 输出呈现参数。 */
export interface FilterRuleConfig {
  datasetId: string
  conditions: FilterCondition[]
  sortField: string
  sortDirection: SortDirection
  limit: number
}

export interface FilterRule {
  id: string
  name: string
  description: string
  config: FilterRuleConfig
  /** 展示列只影响呈现顺序，不参与命中计算，也不产生新版本。 */
  displayColumns: string[]
  status: RuleStatus
  latestVersionId: string
  /** 数据集结构变化后置为 true，重新启用前必须再次校验字段可用性。 */
  needsRevalidation: boolean
  createdAt: string
  updatedAt: string
}

/** 发布生成的不可变规则版本：只包含筛选语义，不含排序与展示列。 */
export interface RuleVersion {
  id: string
  ruleId: string
  versionNo: number
  datasetId: string
  conditions: FilterCondition[]
  configHash: string
  datasetSchemaVersion: number
  createdAt: string
}

export type ValidationIssueCode =
  | 'dataset-not-found'
  | 'field-not-found'
  | 'no-conditions'
  | 'missing-condition-value'
  | 'invalid-regex'
  | 'invalid-number'
  | 'invalid-date'
  | 'invalid-boolean'
  | 'unsupported-operator'
  | 'mutually-exclusive-comparison'
  | 'contradictory-range'
  | 'contradictory-equality'
  | 'invalid-sort-field'
  | 'invalid-sort-direction'
  | 'invalid-limit'
  | 'invalid-display-column'
  | 'empty-display-columns'
  | 'no-version'

export interface ValidationIssue {
  code: ValidationIssueCode
  message: string
  field?: string
  conditionId?: string
}

export interface FilterBlock {
  /** 展示用块键：筛选字段 + 逻辑组合。 */
  key: string
  field: string
  combination: LogicalCombination
  conditions: FilterCondition[]
  /** 只由块内谓词构成，不含规则/版本；用于跨规则复用。 */
  signature: string
}

export type BlockCacheStatus = 'reused' | 'refreshed' | 'skipped'

export interface BlockExecution {
  key: string
  field: string
  combination: LogicalCombination
  signature: string
  cacheKey: string
  status: BlockCacheStatus
  matchedCount: number
  incompatibleCount: number
  conditions: FilterCondition[]
}

export type RowMatchState = 'match' | 'no-match' | 'incompatible'

export interface BlockCacheEntry {
  cacheKey: string
  datasetId: string
  datasetSchemaVersion: number
  datasetRevision: number
  blockKey: string
  field: string
  combination: LogicalCombination
  signature: string
  stateByRow: Record<string, RowMatchState>
  matchedRowIds: number[]
  incompatibleRowIds: number[]
  computedAt: string
}

export type RunOutcome = 'matched' | 'no-match' | 'not-executed'

export type RunReason =
  | 'rule-not-found'
  | 'rule-disabled'
  | 'rule-not-enabled'
  | 'rule-not-published'
  | 'needs-revalidation'
  | 'validation-failed'
  | 'unpublished-changes'
  | 'dataset-schema-changed'
  | 'dataset-not-found'

export interface ProjectedRow {
  rowId: number
  /** 按 columns 顺序排列的展示值。 */
  values: DatasetValue[]
  /** 命中时的完整行快照，供历史结果与溯源读取。 */
  raw: Record<string, DatasetValue>
}

export interface RuleRun {
  id: string
  ruleId: string
  ruleName: string
  ruleVersionId: string
  versionNo: number
  datasetId: string
  datasetName: string
  datasetSchemaVersion: number
  datasetRevision: number
  outcome: RunOutcome
  reason: RunReason | null
  issues: ValidationIssue[]
  incompatibleCount: number
  /** 完整命中集合（不受输出行数上限影响）。 */
  rowIds: number[]
  /** 按排序与输出行数上限截断后的输出集合。 */
  outputRowIds: number[]
  outputRows: ProjectedRow[]
  columns: string[]
  blocks: BlockExecution[]
  hitIds: string[]
  createdAt: string
  runReused: boolean
  warning: string
}

export interface RuleRunView extends RuleRun {
  /** 当前规则展示列（仅呈现顺序，不改命中集合）。 */
  liveColumns: string[]
  liveRows: ProjectedRow[]
  ruleStatus: RuleStatus
}

export interface HitBlockSnapshot {
  key: string
  field: string
  combination: LogicalCombination
  conditions: FilterCondition[]
}

export interface HitRecord {
  id: string
  runId: string
  ruleId: string
  ruleName: string
  ruleVersionId: string
  versionNo: number
  datasetId: string
  datasetName: string
  datasetSchemaVersion: number
  datasetRevision: number
  rowId: number
  blockKeys: string[]
  blockSnapshot: HitBlockSnapshot[]
  rowSnapshot: ProjectedRow
  matchedAt: string
}

export interface HitExplanation {
  hit: HitRecord
  ruleStatus: RuleStatus
  version: RuleVersion | undefined
  blocks: HitBlockSnapshot[]
  /** 规则已停用或版本已过期时，旧命中行不再参与新输出。 */
  participatesInNewOutput: boolean
  disabledReason: string
}

export interface DrillResult {
  id: string
  ruleId: string
  ruleName: string
  ruleVersionId: string
  versionNo: number
  /** 首次引用后固定，后续发布/停用都不会改写。 */
  firstReferencedVersionId: string
  firstReferencedVersionNo: number
  datasetId: string
  datasetName: string
  datasetSchemaVersion: number
  datasetRevision: number
  runId: string
  hitIds: string[]
  columns: string[]
  rows: ProjectedRow[]
  createdAt: string
}

export type ShardTaskStatus = 'running' | 'completed' | 'stopped'

export type ShardStopReason =
  | 'rule-disabled'
  | 'rule-disabled-after-batch'
  | 'dataset-schema-changed'
  | 'dataset-updated'
  | 'version-missing'

export interface ShardTask {
  id: string
  ruleId: string
  ruleName: string
  /** 任务启动时捕获的规则版本，后续发布不影响本任务。 */
  versionUsed: string
  versionNo: number
  datasetId: string
  datasetName: string
  datasetSchemaVersion: number
  datasetRevision: number
  shardIndex: number
  shardTotal: number
  batchSize: number
  rowIds: number[]
  cursor: number
  batchesCompleted: number
  rowsScanned: number
  hitRowIds: number[]
  status: ShardTaskStatus
  /** 批次执行中观察到的停用/失效信号：等当前批次跑完再停止。 */
  pendingStopReason: ShardStopReason | null
  stopReason: ShardStopReason | null
  startedAt: string
  updatedAt: string
}

export interface FilterStats {
  ruleCount: number
  enabledRules: number
  versionCount: number
  cachedBlocks: number
  cacheHits: number
  cacheMisses: number
  hitCount: number
  drillCount: number
  runningShardTasks: number
  /** 规则已停用但仍被请求执行的次数：这些请求不会产出任何命中行。 */
  disabledRuns: number
}

export interface FilterStudioSnapshot {
  datasets: DatasetDefinition[]
  rules: FilterRule[]
  versions: RuleVersion[]
  runs: RuleRun[]
  hits: HitRecord[]
  drills: DrillResult[]
  shardTasks: ShardTask[]
  stats: FilterStats
}

export interface PublishResult {
  ok: boolean
  message: string
  issues: ValidationIssue[]
  version: RuleVersion | null
  created: boolean
}

export interface FilterActionResult {
  ok: boolean
  message: string
  issues?: ValidationIssue[]
}

export interface DatasetChangeResult extends FilterActionResult {
  schemaVersion: number
  revision: number
  invalidatedBlocks: number
  affectedRules: string[]
}

export interface ShardTaskStartOptions {
  shardIndex?: number
  shardTotal?: number
  batchSize?: number
}

export interface ShardTaskResult {
  ok: boolean
  message: string
  task: ShardTask | null
}

export interface DrillOutcome {
  ok: boolean
  message: string
  drill: DrillResult | null
  /** true 表示复用了该规则首次引用的版本，而不是当前最新版本。 */
  reusedFirstVersion: boolean
}

export interface ShardAdvanceOptions {
  /** 批次扫描中途触发的动作，用于模拟执行期间规则被同步停用。 */
  interleave?: () => void
}

export interface RunOptions {
  /** 忽略已有命中结果与分块缓存，强制重新过滤。 */
  forceRefresh?: boolean
}

export interface ExportFile {
  filename: string
  content: string
  mime: string
}
