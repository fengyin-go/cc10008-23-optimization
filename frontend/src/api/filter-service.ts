import {
  buildBlocks,
  cacheKeyFor,
  combineBlockStates,
  computeBlockEntry,
  explainingBlockKeys,
  hashConfig,
  projectRow,
  stableHash,
} from '@/domain/filter/blocks'
import { buildRuleArchive, buildRunResultFile } from '@/domain/filter/exports'
import { loadFilterState, normalizeState, saveFilterState, seedFilterState, type FilterState } from '@/domain/filter/store'
import {
  RULE_STATUS_LABELS,
  type BlockCacheEntry,
  type BlockExecution,
  type DatasetChangeResult,
  type DatasetDefinition,
  type DatasetField,
  type DatasetValue,
  type DrillOutcome,
  type DrillResult,
  type ExportFile,
  type FilterActionResult,
  type FilterBlock,
  type FilterRule,
  type FilterRuleConfig,
  type FilterStats,
  type FilterStudioSnapshot,
  type HitExplanation,
  type HitRecord,
  type ProjectedRow,
  type PublishResult,
  type RowMatchState,
  type RuleRun,
  type RuleRunView,
  type RuleVersion,
  type RunOptions,
  type RunReason,
  type ShardAdvanceOptions,
  type ShardStopReason,
  type ShardTask,
  type ShardTaskResult,
  type ShardTaskStartOptions,
  type ValidationIssue,
} from '@/domain/filter/types'
import { validateDisplayColumns, validateRuleConfig } from '@/domain/filter/validation'
import { OPERATORS_BY_TYPE } from '@/domain/filter/validation'

/** 进程内分块缓存：数据集结构/数据版本 + 块签名构成缓存键，跨规则、跨执行复用。 */
const blockCache = new Map<string, Map<string, BlockCacheEntry>>()
const cacheCounters = { hits: 0, misses: 0 }

/** 引擎运行计数：停用规则被请求执行的次数单独统计，便于区分「规则未执行」。 */
const runStats = { disabledRuns: 0 }

/** 可注入的时钟：同一批操作里版本与任务需要稳定的先后顺序。 */
let sequence = 0
let clockAnchor = Date.parse('2026-11-14T08:00:00.000Z')

function stamp(): string {
  sequence += 1
  return new Date(clockAnchor + sequence * 1000).toISOString()
}

function newId(prefix: string): string {
  sequence += 1
  return `${prefix}-${stableHash(`${prefix}:${sequence}`).slice(0, 8)}`
}

/** 仅在测试/演示时需要固定时钟；正常运行时跟随真实时间。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readState(): FilterState {
  return normalizeState(loadFilterState())
}

function commit(next: FilterState): void {
  saveFilterState(next)
}

function ruleOf(state: FilterState, ruleId: string): FilterRule | undefined {
  return state.rules.find((rule) => rule.id === ruleId)
}

function datasetOf(state: FilterState, datasetId: string): DatasetDefinition | undefined {
  return state.datasets.find((dataset) => dataset.id === datasetId)
}

function versionOf(state: FilterState, versionId: string): RuleVersion | undefined {
  return state.versions.find((version) => version.id === versionId)
}

function shapeOf(version: RuleVersion): FilterRuleConfig {
  return {
    datasetId: version.datasetId,
    conditions: version.conditions,
    sortField: '',
    sortDirection: 'asc',
    limit: 1,
  }
}

function issueText(issues: ValidationIssue[]): string {
  return issues.map((issue) => issue.message).join('；')
}

/** 规则的筛选语义是否发生变化：展示列与排序呈现参数不改变版本。 */
export function validateRule(
  ruleId: string,
  config?: FilterRuleConfig,
  displayColumns?: string[],
): ValidationIssue[] {
  const state = readState()
  const rule = ruleOf(state, ruleId)
  if (!rule) {
    return [{ code: 'dataset-not-found', message: `规则 ${ruleId} 不存在` }]
  }
  const target = config ?? rule.config
  const dataset = datasetOf(state, target.datasetId)
  const issues = validateRuleConfig(target, dataset)
  issues.push(...validateDisplayColumns(displayColumns ?? rule.displayColumns, dataset))
  return issues
}

export function updateRuleDraft(
  ruleId: string,
  config: FilterRuleConfig,
  displayColumns?: string[],
): FilterActionResult {
  const state = readState()
  const rule = ruleOf(state, ruleId)
  if (!rule) {
    return { ok: false, message: `规则 ${ruleId} 不存在` }
  }
  const dataset = datasetOf(state, config.datasetId)
  rule.config = {
    datasetId: config.datasetId,
    conditions: config.conditions.map((condition) => ({ ...condition })),
    sortField: config.sortField,
    sortDirection: config.sortDirection,
    limit: config.limit,
  }
  if (displayColumns) {
    rule.displayColumns = [...displayColumns]
  }
  rule.updatedAt = stamp()
  const issues = validateRuleConfig(rule.config, dataset)
  issues.push(...validateDisplayColumns(rule.displayColumns, dataset))
  commit(state)
  return {
    ok: issues.length === 0,
    message: issues.length === 0 ? '草稿已保存' : `草稿已保存，但校验未通过：${issueText(issues)}`,
    issues,
  }
}

/** 发布：相同筛选语义连续发布只复用已有版本，不递增版本号。 */
export function publishRule(ruleId: string): PublishResult {
  const state = readState()
  const rule = ruleOf(state, ruleId)
  if (!rule) {
    return { ok: false, message: `规则 ${ruleId} 不存在`, issues: [], version: null, created: false }
  }
  const dataset = datasetOf(state, rule.config.datasetId)
  const issues = validateRuleConfig(rule.config, dataset)
  issues.push(...validateDisplayColumns(rule.displayColumns, dataset))
  if (issues.length > 0) {
    return {
      ok: false,
      message: `校验未通过，未生成版本：${issueText(issues)}`,
      issues,
      version: null,
      created: false,
    }
  }
  const hash = hashConfig(rule.config)
  const ownVersions = state.versions.filter((version) => version.ruleId === rule.id)
  const existing = ownVersions.find(
    (version) => version.configHash === hash && version.datasetSchemaVersion === (dataset?.schemaVersion ?? 0),
  )
  if (existing) {
    rule.latestVersionId = existing.id
    rule.needsRevalidation = false
    rule.updatedAt = stamp()
    commit(state)
    return {
      ok: true,
      message: `筛选条件与 v${existing.versionNo} 相同，复用既有版本，未新增版本`,
      issues: [],
      version: existing,
      created: false,
    }
  }
  const versionNo = ownVersions.reduce((max, version) => Math.max(max, version.versionNo), 0) + 1
  const version: RuleVersion = {
    id: newId('ver'),
    ruleId: rule.id,
    versionNo,
    datasetId: rule.config.datasetId,
    conditions: rule.config.conditions.map((condition) => ({ ...condition })),
    configHash: hash,
    datasetSchemaVersion: dataset?.schemaVersion ?? 0,
    createdAt: stamp(),
  }
  state.versions = [...state.versions, version]
  rule.latestVersionId = version.id
  rule.needsRevalidation = false
  rule.updatedAt = stamp()
  commit(state)
  return {
    ok: true,
    message: `已发布 v${version.versionNo}`,
    issues: [],
    version,
    created: true,
  }
}

/** 登记新规则：默认落为草稿，字段与展示列取自目标数据集。 */
export function createRule(name: string, datasetId: string): FilterActionResult & { ruleId?: string } {
  const state = readState()
  const trimmed = name.trim()
  if (trimmed === '') {
    return { ok: false, message: '规则名称不能为空' }
  }
  if (state.rules.some((rule) => rule.name === trimmed)) {
    return { ok: false, message: `已存在同名规则「${trimmed}」` }
  }
  const dataset = datasetOf(state, datasetId)
  if (!dataset) {
    return { ok: false, message: `数据集 ${datasetId} 不存在` }
  }
  const field = dataset.fields[0]
  const config: FilterRuleConfig = {
    datasetId,
    conditions: [
      {
        id: newId('cond'),
        field: field?.name ?? '',
        operator: field && OPERATORS_BY_TYPE[field.type].includes('>=') ? '>=' : '=',
        value: '',
        combination: 'AND',
      },
    ],
    sortField: '',
    sortDirection: 'asc',
    limit: 100,
  }
  const nowStamp = stamp()
  const rule: FilterRule = {
    id: newId('rule'),
    name: trimmed,
    description: `基于「${dataset.name}」的筛选规则`,
    config,
    displayColumns: dataset.fields.slice(0, Math.min(4, dataset.fields.length)).map((item) => item.name),
    status: 'draft',
    latestVersionId: '',
    needsRevalidation: false,
    createdAt: nowStamp,
    updatedAt: nowStamp,
  }
  state.rules = [...state.rules, rule]
  commit(state)
  return { ok: true, message: `已登记规则「${trimmed}」，补全条件后提交校验`, ruleId: rule.id }
}

export function submitValidation(ruleId: string): FilterActionResult {
  const state = readState()
  const rule = ruleOf(state, ruleId)
  if (!rule) {
    return { ok: false, message: `规则 ${ruleId} 不存在` }
  }
  const dataset = datasetOf(state, rule.config.datasetId)
  const issues = validateRuleConfig(rule.config, dataset)
  issues.push(...validateDisplayColumns(rule.displayColumns, dataset))
  if (issues.length > 0) {
    return { ok: false, message: `校验未通过：${issueText(issues)}`, issues }
  }
  if (rule.status === 'draft') {
    rule.status = 'validated'
  }
  rule.needsRevalidation = false
  rule.updatedAt = stamp()
  commit(state)
  return { ok: true, message: '校验通过，可发布并启用', issues: [] }
}

/** 启用规则必须重新校验字段可用性，并且必须存在结构匹配的版本。 */
export function enableRule(ruleId: string): FilterActionResult {
  const state = readState()
  const rule = ruleOf(state, ruleId)
  if (!rule) {
    return { ok: false, message: `规则 ${ruleId} 不存在` }
  }
  const dataset = datasetOf(state, rule.config.datasetId)
  const issues = validateRuleConfig(rule.config, dataset)
  issues.push(...validateDisplayColumns(rule.displayColumns, dataset))
  const version = versionOf(state, rule.latestVersionId)
  if (!version) {
    issues.push({ code: 'no-version', message: '规则还没有发布版本，不能启用' })
  } else if (dataset && version.datasetSchemaVersion !== dataset.schemaVersion) {
    issues.push({
      code: 'field-not-found',
      message: '目标数据集字段结构已变化，旧版本失效，请重新校验并发布后再启用',
    })
  }
  if (issues.length > 0) {
    rule.needsRevalidation = true
    rule.updatedAt = stamp()
    commit(state)
    return { ok: false, message: `启用失败：${issueText(issues)}`, issues }
  }
  rule.status = 'enabled'
  rule.needsRevalidation = false
  rule.updatedAt = stamp()
  commit(state)
  return { ok: true, message: `规则已启用，读取 v${version?.versionNo}` }
}

/**
 * 停用规则：旧命中行保留，仍可解释来源；但新输出不再包含它们。
 * 正在执行的分片任务只有在当前批次跑完后才停止后续读取。
 */
export function disableRule(ruleId: string): FilterActionResult {
  const state = readState()
  const rule = ruleOf(state, ruleId)
  if (!rule) {
    return { ok: false, message: `规则 ${ruleId} 不存在` }
  }
  rule.status = 'disabled'
  rule.updatedAt = stamp()
  const running = state.shardTasks.filter((task) => task.ruleId === ruleId && task.status === 'running')
  running.forEach((task) => {
    task.pendingStopReason = 'rule-disabled-after-batch'
    task.updatedAt = stamp()
  })
  commit(state)
  return {
    ok: true,
    message: running.length
      ? `规则已停用；${running.length} 个分片任务会在当前批次完成后停止读取`
      : '规则已停用，历史命中保留溯源，不再参与新输出',
  }
}

/** 切换展示列只改呈现顺序：不改版本、不重算块、命中集合保持不变。 */
export function setDisplayColumns(ruleId: string, columns: string[]): FilterActionResult {
  const state = readState()
  const rule = ruleOf(state, ruleId)
  if (!rule) {
    return { ok: false, message: `规则 ${ruleId} 不存在` }
  }
  const dataset = datasetOf(state, rule.config.datasetId)
  const issues = validateDisplayColumns(columns, dataset)
  if (issues.length > 0) {
    return { ok: false, message: issueText(issues), issues }
  }
  rule.displayColumns = [...columns]
  rule.updatedAt = stamp()
  commit(state)
  return { ok: true, message: '展示列已更新，命中集合保持不变' }
}

function emptyRun(
  rule: FilterRule,
  version: RuleVersion | undefined,
  reason: RunReason,
  issues: ValidationIssue[],
  dataset: DatasetDefinition | undefined,
  warning = '',
): RuleRun {
  return {
    id: newId('run'),
    ruleId: rule.id,
    ruleName: rule.name,
    ruleVersionId: version?.id ?? rule.latestVersionId,
    versionNo: version?.versionNo ?? 0,
    datasetId: rule.config.datasetId,
    datasetName: dataset?.name ?? rule.config.datasetId,
    datasetSchemaVersion: dataset?.schemaVersion ?? 0,
    datasetRevision: dataset?.revision ?? 0,
    outcome: 'not-executed',
    reason,
    issues,
    incompatibleCount: 0,
    rowIds: [],
    outputRowIds: [],
    outputRows: [],
    columns: [...rule.displayColumns],
    blocks: [],
    hitIds: [],
    createdAt: stamp(),
    runReused: false,
    warning,
  }
}

function tableFor(dataset: DatasetDefinition): Map<string, BlockCacheEntry> {
  let table = blockCache.get(dataset.id)
  if (!table) {
    table = new Map()
    blockCache.set(dataset.id, table)
  }
  return table
}

/**
 * 逐块执行：只有签名变化的块才重新过滤；其余块直接复用缓存。
 * 缓存键包含数据集结构版本与数据版本，因此字段类型变化不会悄悄复用旧候选集。
 */
function executeBlocks(
  dataset: DatasetDefinition,
  blocks: FilterBlock[],
  forceRefresh: boolean,
): { entries: Map<string, BlockCacheEntry>; executions: BlockExecution[]; refreshed: number } {
  const table = tableFor(dataset)
  const entries = new Map<string, BlockCacheEntry>()
  const executions: BlockExecution[] = []
  let refreshed = 0
  for (const block of blocks) {
    const cacheKey = cacheKeyFor(dataset, block)
    let entry = forceRefresh ? undefined : table.get(cacheKey)
    let status: BlockExecution['status'] = 'reused'
    if (entry) {
      cacheCounters.hits += 1
    } else {
      entry = computeBlockEntry(dataset, block, stamp())
      table.set(cacheKey, entry)
      status = 'refreshed'
      refreshed += 1
      cacheCounters.misses += 1
    }
    entries.set(block.key, entry)
    executions.push({
      key: block.key,
      field: block.field,
      combination: block.combination,
      signature: block.signature,
      cacheKey,
      status,
      matchedCount: entry.matchedRowIds.length,
      incompatibleCount: entry.incompatibleRowIds.length,
      conditions: block.conditions.map((condition) => ({ ...condition })),
    })
  }
  return { entries, executions, refreshed }
}

function orderRows(
  dataset: DatasetDefinition,
  rowIds: number[],
  sortField: string,
  sortDirection: 'asc' | 'desc',
): number[] {
  const field = dataset.fields.find((item) => item.name === sortField)
  if (!field) {
    return [...rowIds].sort((left, right) => left - right)
  }
  const rowById = new Map(dataset.rows.map((row) => [row.id, row]))
  const factor = sortDirection === 'desc' ? -1 : 1
  return [...rowIds].sort((left, right) => {
    const leftValue = rowById.get(left)?.values[sortField]
    const rightValue = rowById.get(right)?.values[sortField]
    const leftKey =
      field.type === 'date' ? Date.parse(String(leftValue)) : typeof leftValue === 'number' ? leftValue : String(leftValue ?? '')
    const rightKey =
      field.type === 'date' ? Date.parse(String(rightValue)) : typeof rightValue === 'number' ? rightValue : String(rightValue ?? '')
    if (leftKey === rightKey) {
      return left - right
    }
    return leftKey < rightKey ? -factor : factor
  })
}

function executeVersion(
  state: FilterState,
  rule: FilterRule,
  version: RuleVersion,
  dataset: DatasetDefinition,
  options: RunOptions,
): { run: RuleRun; hits: HitRecord[] } {
  const blocks = buildBlocks(shapeOf(version))
  const { entries, executions } = executeBlocks(dataset, blocks, options.forceRefresh ?? false)
  const combined = combineBlockStates(blocks, entries, dataset.rows)
  const rowIds = [...combined.matchedRowIds].sort((left, right) => left - right)
  const incompatibleCount = dataset.rows.filter(
    (row) => combined.stateByRow[String(row.id)] === 'incompatible',
  ).length

  const ordered = orderRows(dataset, rowIds, rule.config.sortField, rule.config.sortDirection)
  const limit = Number.isInteger(rule.config.limit) && rule.config.limit > 0
    ? rule.config.limit
    : ordered.length
  const outputRowIds = ordered.slice(0, limit)
  const displayColumns = rule.displayColumns.length > 0
    ? [...rule.displayColumns]
    : dataset.fields.map((field) => field.name)
  const rowById = new Map(dataset.rows.map((row) => [row.id, row]))
  const outputRows: ProjectedRow[] = outputRowIds.map((rowId) => {
    const row = rowById.get(rowId)
    return row ? projectRow(dataset, row, displayColumns) : { rowId, values: [], raw: {} }
  })

  const createdAt = stamp()
  const run: RuleRun = {
    id: newId('run'),
    ruleId: rule.id,
    ruleName: rule.name,
    ruleVersionId: version.id,
    versionNo: version.versionNo,
    datasetId: dataset.id,
    datasetName: dataset.name,
    datasetSchemaVersion: dataset.schemaVersion,
    datasetRevision: dataset.revision,
    outcome: rowIds.length > 0 ? 'matched' : 'no-match',
    reason: null,
    issues: [],
    incompatibleCount,
    rowIds,
    outputRowIds,
    outputRows,
    columns: displayColumns,
    blocks: executions,
    hitIds: [],
    createdAt,
    runReused: false,
    warning: '',
  }

  // 命中行只在输出行里生成溯源记录：分块明细保证完整命中集合可复算，输出行才需要逐行解释。
  const blockSnapshots = blocks.map((block) => ({
    key: block.key,
    field: block.field,
    combination: block.combination,
    conditions: block.conditions.map((condition) => ({ ...condition })),
  }))
  const hits: HitRecord[] = outputRowIds.map((rowId) => ({
    id: newId('hit'),
    runId: run.id,
    ruleId: rule.id,
    ruleName: rule.name,
    ruleVersionId: version.id,
    versionNo: version.versionNo,
    datasetId: dataset.id,
    datasetName: dataset.name,
    datasetSchemaVersion: dataset.schemaVersion,
    datasetRevision: dataset.revision,
    rowId,
    blockKeys: explainingBlockKeys(blocks, entries, rowId),
    blockSnapshot: blockSnapshots,
    rowSnapshot: outputRows.find((row) => row.rowId === rowId) ?? { rowId, values: [], raw: {} },
    matchedAt: createdAt,
  }))
  run.hitIds = hits.map((hit) => hit.id)
  return { run, hits }
}

/**
 * 执行规则。规则停用/未启用/版本未发布时一律返回「规则未执行」，
 * 与「确实无命中」（outcome = no-match）严格区分。
 */
export function runRule(ruleId: string, options: RunOptions = {}): RuleRun {
  const state = readState()
  const rule = ruleOf(state, ruleId)
  if (!rule) {
    return emptyRun(
      {
        id: ruleId,
        name: ruleId,
        description: '',
        config: { datasetId: '', conditions: [], sortField: '', sortDirection: 'asc', limit: 100 },
        displayColumns: [],
        status: 'draft',
        latestVersionId: '',
        needsRevalidation: false,
        createdAt: stamp(),
        updatedAt: stamp(),
      },
      undefined,
      'rule-not-found',
      [],
      undefined,
    )
  }

  const dataset = datasetOf(state, rule.config.datasetId)
  const version = versionOf(state, rule.latestVersionId)
  if (rule.status === 'disabled') {
    runStats.disabledRuns += 1
    return emptyRun(rule, version, 'rule-disabled', [], dataset, '规则已停用：历史命中仍可溯源，本次不产生新输出')
  }
  if (rule.status !== 'enabled') {
    return emptyRun(
      rule,
      version,
      'rule-not-enabled',
      [],
      dataset,
      `规则当前状态为「${RULE_STATUS_LABELS[rule.status]}」，尚未启用`,
    )
  }
  if (!version) {
    return emptyRun(rule, version, 'rule-not-published', [], dataset, '规则还没有发布版本，无法执行')
  }
  if (!dataset) {
    return emptyRun(rule, version, 'dataset-not-found', [], undefined, '目标数据集不存在')
  }
  if (rule.needsRevalidation) {
    return emptyRun(rule, version, 'needs-revalidation', [], dataset, '数据集结构已变化，需要重新校验后再执行')
  }
  if (version.datasetSchemaVersion !== dataset.schemaVersion) {
    return emptyRun(
      rule,
      version,
      'dataset-schema-changed',
      [{ code: 'field-not-found', message: '目标数据集字段结构已变化，旧版本候选集失效' }],
      dataset,
      '旧候选集随字段结构变化失效，不做隐式类型转换',
    )
  }
  if (hashConfig(rule.config) !== version.configHash) {
    return emptyRun(rule, version, 'unpublished-changes', [], dataset, '筛选条件存在未发布的改动，请先发布')
  }
  const issues = validateRuleConfig(shapeOf(version), dataset)
  if (issues.length > 0) {
    return emptyRun(rule, version, 'validation-failed', issues, dataset, '规则未通过校验，未进入计算')
  }

  // 命中结果按「规则 + 版本 + 数据集结构/数据版本」复用；要求全量刷新时才重算。
  if (!options.forceRefresh) {
    const reusable = state.runs.find(
      (item) =>
        item.ruleId === rule.id &&
        item.ruleVersionId === version.id &&
        item.datasetSchemaVersion === dataset.schemaVersion &&
        item.datasetRevision === dataset.revision &&
        item.outcome === 'matched',
    )
    if (reusable) {
      // 命中集合与版本不变：只按当前展示列、排序与上限重新投影，不重算任何块。
      return clone({
        ...reusable,
        ...projectOutput(rule, dataset, reusable.columns, reusable.rowIds),
        runReused: true,
      })
    }
  }

  const { run, hits } = executeVersion(state, rule, version, dataset, options)
  const trimmedHits = state.hits.length + hits.length - 5000
  state.runs = [run, ...state.runs].slice(0, 300)
  state.hits = [...hits, ...state.hits].slice(0, 5000)
  commit(state)
  if (trimmedHits > 0) {
    // 超出留存上限时明确告知：最早的一批溯源记录已被清理，执行结果本身仍在。
    run.warning = `命中记录留存已达上限，最早的 ${trimmedHits} 条溯源记录被清理`
  }
  return clone(run)
}

/** 由完整命中集合派生输出行：排序与行数上限只影响呈现，不影响命中集合。 */
function projectOutput(
  rule: FilterRule,
  dataset: DatasetDefinition,
  baseColumns: string[],
  rowIds: number[],
): Pick<RuleRun, 'outputRowIds' | 'outputRows' | 'columns'> {
  const columns = rule.displayColumns.length > 0 ? [...rule.displayColumns] : [...baseColumns]
  const ordered = orderRows(dataset, rowIds, rule.config.sortField, rule.config.sortDirection)
  const limit = Number.isInteger(rule.config.limit) && rule.config.limit > 0 ? rule.config.limit : ordered.length
  const outputRowIds = ordered.slice(0, limit)
  const rowById = new Map(dataset.rows.map((row) => [row.id, row]))
  return {
    columns,
    outputRowIds,
    outputRows: outputRowIds.map((rowId) => {
      const row = rowById.get(rowId)
      return row ? projectRow(dataset, row, columns) : { rowId, values: [], raw: {} }
    }),
  }
}

export function listRuns(ruleId?: string): RuleRun[] {
  const state = readState()
  const runs = ruleId ? state.runs.filter((run) => run.ruleId === ruleId) : state.runs
  return clone(runs)
}

export function listRuleRuns(ruleId: string): RuleRunView[] {
  const state = readState()
  const rule = ruleOf(state, ruleId)
  return state.runs
    .filter((run) => run.ruleId === ruleId)
    .map((run) => {
      const liveColumns = rule ? [...rule.displayColumns] : [...run.columns]
      // 历史输出行按行快照重新投影：展示列调整只改变呈现顺序，不改命中集合。
      const dataset = datasetOf(state, run.datasetId)
      const rowsById = new Map((dataset?.rows ?? []).map((row) => [row.id, row]))
      const liveRows = run.outputRows.map((row) => {
        const datasetRow = rowsById.get(row.rowId)
        if (datasetRow) {
          return projectRow(dataset!, datasetRow, liveColumns)
        }
        return {
          rowId: row.rowId,
          values: liveColumns.map((column) => row.raw[column] ?? ''),
          raw: row.raw,
        }
      })
      return { ...clone(run), liveColumns, liveRows, ruleStatus: rule?.status ?? 'draft' }
    })
}

/**
 * 下钻复用规则版本：同一规则首次下钻引用的版本会被固定下来，
 * 之后即使规则发布新版本，下钻仍读取首次引用的版本。
 */
export function openDrill(ruleId: string): DrillOutcome {
  const state = readState()
  const rule = ruleOf(state, ruleId)
  if (!rule) {
    return { ok: false, message: `规则 ${ruleId} 不存在`, drill: null, reusedFirstVersion: false }
  }
  const existing = state.drills.find((drill) => drill.ruleId === ruleId)
  if (existing) {
    const pinned = versionOf(state, existing.firstReferencedVersionId)
    const drift = rule.latestVersionId !== existing.firstReferencedVersionId
    return {
      ok: true,
      message: drift
        ? `下钻继续读取首次引用的 v${pinned?.versionNo ?? existing.firstReferencedVersionNo}，未采用最新版本`
        : `下钻复用首次引用的 v${existing.firstReferencedVersionNo}`,
      drill: clone(existing),
      reusedFirstVersion: true,
    }
  }

  const run = runRule(ruleId)
  if (run.outcome === 'not-executed') {
    return { ok: false, message: `规则未执行（${run.warning}），无法下钻`, drill: null, reusedFirstVersion: false }
  }
  if (run.outcome === 'no-match') {
    return { ok: false, message: '确认无命中行，下钻没有可展示的数据', drill: null, reusedFirstVersion: false }
  }
  const drill: DrillResult = {
    id: newId('drill'),
    ruleId,
    ruleName: rule.name,
    ruleVersionId: run.ruleVersionId,
    versionNo: run.versionNo,
    firstReferencedVersionId: run.ruleVersionId,
    firstReferencedVersionNo: run.versionNo,
    datasetId: run.datasetId,
    datasetName: run.datasetName,
    datasetSchemaVersion: run.datasetSchemaVersion,
    datasetRevision: run.datasetRevision,
    runId: run.id,
    hitIds: [...run.hitIds],
    columns: [...run.columns],
    rows: clone(run.outputRows),
    createdAt: stamp(),
  }
  state.drills = [drill, ...state.drills]
  commit(state)
  return {
    ok: true,
    message: `下钻已生成，固定引用 v${run.versionNo}`,
    drill: clone(drill),
    reusedFirstVersion: false,
  }
}

export function listDrills(ruleId?: string): DrillResult[] {
  const state = readState()
  const drills = ruleId ? state.drills.filter((drill) => drill.ruleId === ruleId) : state.drills
  return clone(drills)
}

export function listVersions(ruleId?: string): RuleVersion[] {
  const state = readState()
  const versions = ruleId ? state.versions.filter((version) => version.ruleId === ruleId) : state.versions
  return clone(versions)
}

/** 旧命中行的溯源：规则版本、分块条件与停用后的输出参与状态一并给出。 */
export function explainHit(hitId: string): HitExplanation | FilterActionResult {
  const state = readState()
  const hit = state.hits.find((item) => item.id === hitId)
  if (!hit) {
    return { ok: false, message: `命中记录 ${hitId} 不存在` }
  }
  const rule = ruleOf(state, hit.ruleId)
  const version = versionOf(state, hit.ruleVersionId)
  const ruleStatus = rule?.status ?? 'disabled'
  const participatesInNewOutput =
    ruleStatus === 'enabled' && rule?.latestVersionId === hit.ruleVersionId
  const disabledReason = !rule
    ? '规则已不存在'
    : ruleStatus === 'disabled'
      ? '规则已停用：历史命中保留来源，但不再参与新输出'
      : rule.latestVersionId !== hit.ruleVersionId
        ? `规则已发布 v${versionOf(state, rule.latestVersionId)?.versionNo ?? '?'}，该命中属于历史版本`
        : ''
  return {
    hit: clone(hit),
    ruleStatus,
    version: version ? clone(version) : undefined,
    blocks: clone(hit.blockSnapshot),
    participatesInNewOutput,
    disabledReason,
  }
}

/** 仅返回参与新输出的命中：停用规则与历史版本的命中不会出现在这里。 */
export function listActiveHits(ruleId?: string): HitRecord[] {
  const state = readState()
  return clone(
    state.hits.filter((hit) => {
      if (ruleId && hit.ruleId !== ruleId) {
        return false
      }
      const rule = ruleOf(state, hit.ruleId)
      return rule?.status === 'enabled' && rule.latestVersionId === hit.ruleVersionId
    }),
  )
}

export function buildLatestRunFile(ruleId: string): ExportFile | FilterActionResult {
  const state = readState()
  const rule = ruleOf(state, ruleId)
  if (!rule) {
    return { ok: false, message: `规则 ${ruleId} 不存在` }
  }
  const run = state.runs.find((item) => item.ruleId === ruleId)
  if (!run) {
    return { ok: false, message: '该规则还没有执行结果，无法下载结果文件' }
  }
  return buildRunResultFile(run, versionOf(state, run.ruleVersionId), datasetOf(state, run.datasetId))
}

export function archiveRule(ruleId: string): ExportFile | FilterActionResult {
  const state = readState()
  const rule = ruleOf(state, ruleId)
  if (!rule) {
    return { ok: false, message: `规则 ${ruleId} 不存在` }
  }
  return buildRuleArchive(
    rule,
    state.versions.filter((version) => version.ruleId === ruleId),
    state.runs.filter((run) => run.ruleId === ruleId),
    state.hits.filter((hit) => hit.ruleId === ruleId),
  )
}

export function downloadFile(file: ExportFile): void {
  if (typeof document === 'undefined') {
    return
  }
  const blob = new Blob([file.content], { type: file.mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/**
 * 字段结构变化：结构版本递增，旧分块缓存键整体失效；受影响规则置为待重新校验，
 * 重新启用时 enableRule 会再次校验字段可用性。
 */
export function updateDatasetSchema(datasetId: string, fields: DatasetField[]): DatasetChangeResult {
  const state = readState()
  const dataset = datasetOf(state, datasetId)
  if (!dataset) {
    return { ok: false, message: `数据集 ${datasetId} 不存在`, schemaVersion: 0, revision: 0, invalidatedBlocks: 0, affectedRules: [] }
  }
  const invalidatedBlocks = invalidateBlocks(dataset)
  dataset.fields = fields.map((field) => ({ ...field }))
  dataset.schemaVersion += 1
  dataset.revision += 1
  const affectedRules: string[] = []
  for (const rule of state.rules) {
    if (rule.config.datasetId !== datasetId) {
      continue
    }
    rule.needsRevalidation = true
    rule.updatedAt = stamp()
    affectedRules.push(rule.id)
  }
  for (const task of state.shardTasks) {
    if (task.datasetId === datasetId && task.status === 'running') {
      task.pendingStopReason = 'dataset-schema-changed'
      task.updatedAt = stamp()
    }
  }
  commit(state)
  return {
    ok: true,
    message: `字段结构更新为 v${dataset.schemaVersion}：${invalidatedBlocks} 个旧分块缓存失效，${affectedRules.length} 条规则需要重新校验`,
    schemaVersion: dataset.schemaVersion,
    revision: dataset.revision,
    invalidatedBlocks,
    affectedRules,
  }
}

export function updateDatasetRows(datasetId: string, rows: DatasetDefinition['rows']): DatasetChangeResult {
  const state = readState()
  const dataset = datasetOf(state, datasetId)
  if (!dataset) {
    return { ok: false, message: `数据集 ${datasetId} 不存在`, schemaVersion: 0, revision: 0, invalidatedBlocks: 0, affectedRules: [] }
  }
  const invalidatedBlocks = invalidateBlocks(dataset)
  dataset.rows = rows.map((row) => ({ id: row.id, values: { ...row.values } }))
  dataset.revision += 1
  for (const task of state.shardTasks) {
    if (task.datasetId === datasetId && task.status === 'running') {
      task.pendingStopReason = 'dataset-updated'
      task.updatedAt = stamp()
    }
  }
  commit(state)
  return {
    ok: true,
    message: `数据更新为修订 ${dataset.revision}：${invalidatedBlocks} 个旧分块缓存失效`,
    schemaVersion: dataset.schemaVersion,
    revision: dataset.revision,
    invalidatedBlocks,
    affectedRules: [],
  }
}

function invalidateBlocks(dataset: DatasetDefinition): number {
  const table = blockCache.get(dataset.id)
  if (!table) {
    return 0
  }
  let removed = 0
  for (const key of [...table.keys()]) {
    // 旧键以「数据集 + 结构版本 + 数据版本」开头；版本变化后旧键不会再被命中，这里顺手清理。
    removed += 1
    table.delete(key)
  }
  return removed
}

/**
 * 启动分片任务：捕获启动时读取的规则版本。同一规则的两个分片任务各自记录版本，
 * 之后规则发布新版本也不影响已启动的任务。
 */
export function startShardTask(
  ruleId: string,
  options: ShardTaskStartOptions = {},
): ShardTaskResult {
  const state = readState()
  const rule = ruleOf(state, ruleId)
  if (!rule) {
    return { ok: false, message: `规则 ${ruleId} 不存在`, task: null }
  }
  if (rule.status !== 'enabled') {
    return { ok: false, message: '只有已启用的规则才能启动分片任务', task: null }
  }
  const version = versionOf(state, rule.latestVersionId)
  const dataset = datasetOf(state, rule.config.datasetId)
  if (!version || !dataset) {
    return { ok: false, message: '规则缺少可用版本或数据集', task: null }
  }
  if (version.datasetSchemaVersion !== dataset.schemaVersion || rule.needsRevalidation) {
    return { ok: false, message: '目标数据集结构已变化，请重新校验并发布后再启动分片任务', task: null }
  }
  const shardTotal = Math.max(1, options.shardTotal ?? 1)
  const shardIndex = Math.min(Math.max(0, options.shardIndex ?? 0), shardTotal - 1)
  const batchSize = Math.max(1, options.batchSize ?? 4)
  const allRowIds = dataset.rows.map((row) => row.id).sort((left, right) => left - right)
  const rowIds = allRowIds.filter((_, index) => index % shardTotal === shardIndex)
  const task: ShardTask = {
    id: newId('shard'),
    ruleId,
    ruleName: rule.name,
    versionUsed: version.id,
    versionNo: version.versionNo,
    datasetId: dataset.id,
    datasetName: dataset.name,
    datasetSchemaVersion: dataset.schemaVersion,
    datasetRevision: dataset.revision,
    shardIndex,
    shardTotal,
    batchSize,
    rowIds,
    cursor: 0,
    batchesCompleted: 0,
    rowsScanned: 0,
    hitRowIds: [],
    status: 'running',
    pendingStopReason: null,
    stopReason: null,
    startedAt: stamp(),
    updatedAt: stamp(),
  }
  state.shardTasks = [task, ...state.shardTasks]
  commit(state)
  return {
    ok: true,
    message: `分片 ${shardIndex + 1}/${shardTotal} 已启动，读取 v${version.versionNo}（${version.id}）`,
    task: clone(task),
  }
}

export function listShardTasks(ruleId?: string): ShardTask[] {
  const state = readState()
  const tasks = ruleId ? state.shardTasks.filter((task) => task.ruleId === ruleId) : state.shardTasks
  return clone(tasks)
}

function stopSignalOf(state: FilterState, task: ShardTask): ShardStopReason | null {
  const rule = ruleOf(state, task.ruleId)
  const dataset = datasetOf(state, task.datasetId)
  if (!rule || !dataset) {
    return 'version-missing'
  }
  if (rule.status !== 'enabled') {
    return 'rule-disabled'
  }
  if (dataset.schemaVersion !== task.datasetSchemaVersion) {
    return 'dataset-schema-changed'
  }
  if (dataset.revision !== task.datasetRevision) {
    return 'dataset-updated'
  }
  return null
}

/**
 * 推进一个批次。批次扫描过程中如果规则被同步停用，信号先记为 pendingStopReason，
 * 当前批次完整跑完才真正停下；新版本发布不影响已在执行的任务版本。
 */
export function advanceShardTask(
  taskId: string,
  options: ShardAdvanceOptions = {},
): ShardTaskResult {
  const state = readState()
  const task = state.shardTasks.find((item) => item.id === taskId)
  if (!task) {
    return { ok: false, message: `分片任务 ${taskId} 不存在`, task: null }
  }
  if (task.status !== 'running') {
    return { ok: false, message: `分片任务已结束（${task.status}），无法继续推进`, task: clone(task) }
  }
  const version = versionOf(state, task.versionUsed)
  const dataset = datasetOf(state, task.datasetId)
  if (!version || !dataset) {
    task.status = 'stopped'
    task.stopReason = 'version-missing'
    task.updatedAt = stamp()
    commit(state)
    return { ok: false, message: '任务读取的版本或数据集已不存在，任务停止', task: clone(task) }
  }

  // 批次开始前已观察到停用/失效信号：直接停止，不再读取新批次。
  const earlySignal =
    stopSignalOf(state, task) ??
    (task.pendingStopReason === 'rule-disabled-after-batch' ? 'rule-disabled' : task.pendingStopReason)
  if (earlySignal) {
    task.status = 'stopped'
    task.stopReason = earlySignal
    task.pendingStopReason = null
    task.updatedAt = stamp()
    commit(state)
    return {
      ok: true,
      message: `未开始新批次，任务在当前批次边界停止（${earlySignal}）`,
      task: clone(task),
    }
  }

  const blocks = buildBlocks(shapeOf(version))
  const entries = new Map<string, BlockCacheEntry>()
  const table = tableFor(dataset)
  for (const block of blocks) {
    const key = cacheKeyFor(dataset, block)
    let entry = table.get(key)
    if (!entry) {
      entry = computeBlockEntry(dataset, block, stamp())
      table.set(key, entry)
      cacheCounters.misses += 1
    } else {
      cacheCounters.hits += 1
    }
    entries.set(block.key, entry)
  }

  const batch = task.rowIds.slice(task.cursor, task.cursor + task.batchSize)
  for (const rowId of batch) {
    options.interleave?.()
    const rowKey = String(rowId)
    const next = readState()
    const ruleNow = ruleOf(next, task.ruleId)
    if (ruleNow && ruleNow.status !== 'enabled') {
      // 批次内观察到的停用只登记信号，不中断当前批次的扫描。
      task.pendingStopReason = task.pendingStopReason ?? 'rule-disabled-after-batch'
    }
    const andPass = blocks
      .filter((block) => block.combination === 'AND')
      .every((block) => entries.get(block.key)?.stateByRow[rowKey] === 'match')
    const orBlocks = blocks.filter((block) => block.combination === 'OR')
    const orPass =
      orBlocks.length === 0 ||
      orBlocks.some((block) => entries.get(block.key)?.stateByRow[rowKey] === 'match')
    if (blocks.length > 0 && andPass && orPass) {
      task.hitRowIds.push(rowId)
    }
    task.rowsScanned += 1
    task.cursor += 1
  }
  task.batchesCompleted += 1
  task.updatedAt = stamp()

  // 批次结束后才判定停止：确保「正在执行的批次完成后再停止后续读取」。
  const afterBatch = readState()
  const afterTask = afterBatch.shardTasks.find((item) => item.id === taskId)
  const signal =
    task.pendingStopReason ?? (afterTask ? stopSignalOf(afterBatch, afterTask) : null)
  if (signal) {
    task.status = 'stopped'
    task.stopReason = signal
    task.pendingStopReason = null
  } else if (task.cursor >= task.rowIds.length) {
    task.status = 'completed'
  }
  commit(state)
  return {
    ok: true,
    message:
      task.status === 'running'
        ? `批次 ${task.batchesCompleted} 已完成，已扫描 ${task.rowsScanned}/${task.rowIds.length} 行`
        : task.status === 'stopped'
          ? `批次 ${task.batchesCompleted} 已完成后停止后续读取（${task.stopReason}）`
          : `分片扫描完成，命中 ${task.hitRowIds.length} 行`,
    task: clone(task),
  }
}

export function advanceAllRunningTasks(batchCount = 1): ShardTask[] {
  const state = readState()
  const running = state.shardTasks.filter((task) => task.status === 'running')
  for (const task of running) {
    for (let index = 0; index < batchCount; index += 1) {
      const result = advanceShardTask(task.id)
      if (!result.ok || result.task?.status !== 'running') {
        break
      }
    }
  }
  return listShardTasks()
}

export function computeStats(): FilterStats {
  const state = readState()
  let cachedBlocks = 0
  for (const table of blockCache.values()) {
    cachedBlocks += table.size
  }
  return {
    ruleCount: state.rules.length,
    enabledRules: state.rules.filter((rule) => rule.status === 'enabled').length,
    versionCount: state.versions.length,
    cachedBlocks,
    cacheHits: cacheCounters.hits,
    cacheMisses: cacheCounters.misses,
    hitCount: state.hits.length,
    drillCount: state.drills.length,
    runningShardTasks: state.shardTasks.filter((task) => task.status === 'running').length,
    disabledRuns: runStats.disabledRuns,
  }
}

export function getFilterSnapshot(): FilterStudioSnapshot {
  const state = readState()
  return {
    datasets: clone(state.datasets),
    rules: clone(state.rules),
    versions: clone(state.versions),
    runs: clone(state.runs),
    hits: clone(state.hits),
    drills: clone(state.drills),
    shardTasks: clone(state.shardTasks),
    stats: computeStats(),
  }
}

export function resetFilterEngine(): void {
  sequence = 0
  runStats.disabledRuns = 0
  blockCache.clear()
  cacheCounters.hits = 0
  cacheCounters.misses = 0
  saveFilterState(seedFilterState())
}

