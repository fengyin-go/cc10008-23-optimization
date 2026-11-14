import { evaluateCondition, type MatchState } from './validation'
import type {
  BlockCacheEntry,
  DatasetDefinition,
  DatasetRow,
  FilterBlock,
  FilterCondition,
  FilterRuleConfig,
  ProjectedRow,
  RowMatchState,
} from './types'

/** 稳定字符串哈希：同一份筛选语义每次得到同一个块键，不依赖运行期随机数。 */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (Math.imul(h2 ^ code, 0x85ebca6b) >>> 0) + index
  }
  return `${h1.toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

/** 只对筛选语义取哈希：展示列、排序方向与输出上限不进入版本去重键。 */
export function hashConfig(config: FilterRuleConfig): string {
  const canonical = config.conditions
    .map((condition) =>
      [condition.field, condition.combination, condition.operator, condition.value.trim()].join('\u0001'),
    )
    .sort()
    .join('\u0002')
  return stableHash(`v1|${config.datasetId}|${canonical}`)
}

export function blockKeyOf(condition: Pick<FilterCondition, 'field' | 'combination'>): string {
  return `${condition.field}::${condition.combination}`
}

/** 块签名只由块内谓词决定，不含规则编号和版本，因此能被其他规则复用。 */
export function blockSignature(
  field: string,
  combination: string,
  conditions: FilterCondition[],
): string {
  const predicates = conditions
    .map((condition) => `${condition.operator}\u0001${condition.value.trim()}`)
    .sort()
  return stableHash(`${field}\u0002${combination}\u0002${predicates.join('\u0003')}`)
}

export function buildBlocks(config: FilterRuleConfig): FilterBlock[] {
  const groups = new Map<string, FilterCondition[]>()
  for (const condition of config.conditions) {
    if (condition.field.trim() === '') {
      continue
    }
    const key = blockKeyOf(condition)
    const list = groups.get(key) ?? []
    list.push(condition)
    groups.set(key, list)
  }
  return [...groups.entries()].map(([key, conditions]) => {
    const field = conditions[0].field
    const combination = conditions[0].combination
    const signature = blockSignature(field, combination, conditions)
    return {
      key,
      field,
      combination,
      conditions: [...conditions],
      signature,
    }
  })
}

export function cacheKeyFor(dataset: DatasetDefinition, block: FilterBlock): string {
  return [dataset.id, dataset.schemaVersion, dataset.revision, block.key, block.signature].join('\u0002')
}

function combineStates(states: MatchState[], combination: 'AND' | 'OR'): MatchState {
  if (combination === 'AND') {
    if (states.some((state) => state === 'no-match')) {
      return 'no-match'
    }
    if (states.some((state) => state === 'incompatible')) {
      return 'incompatible'
    }
    return 'match'
  }
  if (states.some((state) => state === 'match')) {
    return 'match'
  }
  if (states.some((state) => state === 'incompatible')) {
    return 'incompatible'
  }
  return 'no-match'
}

export function computeBlockEntry(
  dataset: DatasetDefinition,
  block: FilterBlock,
  computedAt: string,
): BlockCacheEntry {
  const stateByRow: Record<string, RowMatchState> = {}
  const matchedRowIds: number[] = []
  const incompatibleRowIds: number[] = []
  const fieldsByName = new Map(dataset.fields.map((field) => [field.name, field]))

  for (const row of dataset.rows) {
    const field = fieldsByName.get(block.field)
    const states = block.conditions.map((condition) =>
      field ? evaluateCondition(row.values[condition.field], condition, field.type) : 'incompatible',
    )
    const state = field ? combineStates(states, block.combination) : 'incompatible'
    stateByRow[String(row.id)] = state
    if (state === 'match') {
      matchedRowIds.push(row.id)
    } else if (state === 'incompatible') {
      incompatibleRowIds.push(row.id)
    }
  }

  return {
    cacheKey: cacheKeyFor(dataset, block),
    datasetId: dataset.id,
    datasetSchemaVersion: dataset.schemaVersion,
    datasetRevision: dataset.revision,
    blockKey: block.key,
    field: block.field,
    combination: block.combination,
    signature: block.signature,
    stateByRow,
    matchedRowIds,
    incompatibleRowIds,
    computedAt,
  }
}

/** 把多个块的逐行状态合成规则命中集合：AND 块取交集，OR 块取并集，再整体取交集。
 * entries 以块键（字段 + 逻辑组合）索引，同一块的结果可能来自其他规则的缓存。 */
export function combineBlockStates(
  blocks: FilterBlock[],
  entries: Map<string, BlockCacheEntry>,
  rows: DatasetRow[],
): { stateByRow: Record<string, RowMatchState>; matchedRowIds: number[] } {
  const andBlocks = blocks.filter((block) => block.combination === 'AND')
  const orBlocks = blocks.filter((block) => block.combination === 'OR')
  const stateByRow: Record<string, RowMatchState> = {}
  const matchedRowIds: number[] = []

  for (const row of rows) {
    const rowKey = String(row.id)
    const andStates = andBlocks.map((block) => {
      const entry = entries.get(block.key)
      return entry?.stateByRow[rowKey] ?? 'incompatible'
    })
    const orStates = orBlocks.map((block) => {
      const entry = entries.get(block.key)
      return entry?.stateByRow[rowKey] ?? 'incompatible'
    })
    let state: MatchState
    if (andStates.length === 0 && orStates.length === 0) {
      state = 'no-match'
    } else if (andStates.length === 0) {
      state = combineStates(orStates, 'OR')
    } else if (orStates.length === 0) {
      state = combineStates(andStates, 'AND')
    } else {
      state = combineStates([combineStates(andStates, 'AND'), combineStates(orStates, 'OR')], 'AND')
    }
    stateByRow[rowKey] = state
    if (state === 'match') {
      matchedRowIds.push(row.id)
    }
  }
  return { stateByRow, matchedRowIds }
}

/** 某行由哪些块命中来解释：只记录该行通过的块。 */
export function explainingBlockKeys(
  blocks: FilterBlock[],
  entries: Map<string, BlockCacheEntry>,
  rowId: number,
): string[] {
  const rowKey = String(rowId)
  return blocks
    .filter((block) => entries.get(block.key)?.stateByRow[rowKey] === 'match')
    .map((block) => block.key)
}

export function projectRow(
  dataset: DatasetDefinition,
  row: DatasetRow,
  columns: string[],
): ProjectedRow {
  return {
    rowId: row.id,
    values: columns.map((column) => row.values[column] ?? ''),
    raw: { ...row.values },
  }
}
