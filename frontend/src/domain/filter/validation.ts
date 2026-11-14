import {
  EQUALITY_OPERATORS,
  RANGE_OPERATORS,
  type ComparisonOperator,
  type DatasetDefinition,
  type DatasetField,
  type DatasetValue,
  type FieldType,
  type FilterCondition,
  type FilterRuleConfig,
  type ValidationIssue,
} from './types'

/** 每种字段类型允许的比较运算符：布尔只支持等值，字符串不支持区间。 */
export const OPERATORS_BY_TYPE: Record<FieldType, ComparisonOperator[]> = {
  string: ['=', '!=', 'contains', 'regex', 'in'],
  number: ['=', '!=', '>', '>=', '<', '<=', 'in'],
  date: ['=', '!=', '>', '>=', '<', '<=', 'in'],
  boolean: ['=', '!='],
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

export type ParsedLiteral =
  | { ok: true; value: string | number | boolean }
  | {
      ok: false
      code: 'missing-condition-value' | 'invalid-number' | 'invalid-date' | 'invalid-boolean'
    }

/**
 * 按字段类型解析比较值。解析失败直接拒绝，不在计算阶段做隐式类型转换。
 * in 运算符的外部调用方先用 splitInValues 拆开再逐个解析。
 */
export function parseLiteral(raw: string, type: FieldType): ParsedLiteral {
  const text = raw.trim()
  if (text === '') {
    return { ok: false, code: 'missing-condition-value' }
  }
  if (type === 'string') {
    return { ok: true, value: text }
  }
  if (type === 'number') {
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) {
      return { ok: false, code: 'invalid-number' }
    }
    return { ok: true, value: parsed }
  }
  if (type === 'date') {
    if (!ISO_DATE.test(text) || Number.isNaN(Date.parse(text))) {
      return { ok: false, code: 'invalid-date' }
    }
    return { ok: true, value: text }
  }
  const lowered = text.toLowerCase()
  if (['true', '1', 'yes', '是'].includes(lowered)) {
    return { ok: true, value: true }
  }
  if (['false', '0', 'no', '否'].includes(lowered)) {
    return { ok: true, value: false }
  }
  return { ok: false, code: 'invalid-boolean' }
}

export function splitInValues(raw: string): string[] {
  return raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '')
}

/** 严格读取数据行里的值：类型不符视为 incompatible，而不是强转后参与比较。 */
export function coerceRowValue(
  value: DatasetValue | undefined,
  type: FieldType,
): string | number | boolean | null {
  if (value === undefined || value === null) {
    return null
  }
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  if (type === 'boolean') {
    return typeof value === 'boolean' ? value : null
  }
  if (type === 'date') {
    return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))
      ? value
      : null
  }
  return typeof value === 'string' ? value : null
}

export type MatchState = 'match' | 'no-match' | 'incompatible'

/** 单条谓词求值：无法按声明类型解释的值返回 incompatible。 */
export function evaluateCondition(
  value: DatasetValue | undefined,
  condition: FilterCondition,
  type: FieldType,
): MatchState {
  if (condition.operator === 'regex') {
    if (condition.value.trim() === '') {
      return 'incompatible'
    }
    const actual = coerceRowValue(value, type)
    if (actual === null) {
      return 'incompatible'
    }
    try {
      return new RegExp(condition.value).test(String(actual)) ? 'match' : 'no-match'
    } catch {
      return 'incompatible'
    }
  }

  const actual = coerceRowValue(value, type)
  if (actual === null) {
    return 'incompatible'
  }
  if (!OPERATORS_BY_TYPE[type].includes(condition.operator)) {
    return 'incompatible'
  }
  if (condition.operator === 'in') {
    const tokens = splitInValues(condition.value)
    if (tokens.length === 0) {
      return 'incompatible'
    }
    const literals = tokens.map((token) => parseLiteral(token, type))
    if (literals.some((literal) => !literal.ok)) {
      return 'incompatible'
    }
    return literals.some((literal) => literal.ok && literal.value === actual) ? 'match' : 'no-match'
  }
  if (condition.operator === 'contains') {
    return String(actual).includes(condition.value.trim()) ? 'match' : 'no-match'
  }
  const literal = parseLiteral(condition.value, type)
  if (!literal.ok) {
    return 'incompatible'
  }
  if (condition.operator === '=') {
    return literal.value === actual ? 'match' : 'no-match'
  }
  if (condition.operator === '!=') {
    return literal.value !== actual ? 'match' : 'no-match'
  }
  // 区间比较：日期转换为时间戳，数值直接比较，字符串不允许进入这里。
  const left = type === 'date' ? Date.parse(String(actual)) : actual
  const right = type === 'date' ? Date.parse(String(literal.value)) : literal.value
  if (typeof left !== 'number' || typeof right !== 'number' || Number.isNaN(left) || Number.isNaN(right)) {
    return 'incompatible'
  }
  switch (condition.operator) {
    case '>':
      return left > right ? 'match' : 'no-match'
    case '>=':
      return left >= right ? 'match' : 'no-match'
    case '<':
      return left < right ? 'match' : 'no-match'
    case '<=':
      return left <= right ? 'match' : 'no-match'
    default:
      return 'incompatible'
  }
}

export function findField(dataset: DatasetDefinition, name: string): DatasetField | undefined {
  return dataset.fields.find((field) => field.name === name)
}

/**
 * 校验规则配置。缺失条件值、非法正则、字段类型不支持运算符，以及同一 AND 分块内
 * 等值类与区间类比较混用，都在进入计算前拒绝。
 */
export function validateRuleConfig(
  config: FilterRuleConfig,
  dataset: DatasetDefinition | undefined,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!dataset) {
    return [{ code: 'dataset-not-found', message: `目标数据集 ${config.datasetId} 不存在` }]
  }
  if (config.conditions.length === 0) {
    issues.push({ code: 'no-conditions', message: '至少需要一条筛选条件才能发布' })
  }
  if (!Number.isInteger(config.limit) || config.limit < 1) {
    issues.push({ code: 'invalid-limit', message: '输出行数上限必须是大于 0 的整数' })
  }
  if (config.sortDirection !== 'asc' && config.sortDirection !== 'desc') {
    issues.push({ code: 'invalid-sort-direction', message: '排序方向只能是 asc 或 desc' })
  }
  if (config.sortField.trim() !== '' && !findField(dataset, config.sortField)) {
    issues.push({
      code: 'invalid-sort-field',
      message: `排序字段 ${config.sortField} 不在数据集 ${dataset.name} 中`,
      field: config.sortField,
    })
  }

  const seenIds = new Set<string>()
  config.conditions.forEach((condition, index) => {
    const label = condition.field || `第 ${index + 1} 条条件`
    if (seenIds.has(condition.id)) {
      issues.push({
        code: 'no-conditions',
        message: `条件标识 ${condition.id} 重复`,
        conditionId: condition.id,
      })
    }
    seenIds.add(condition.id)
    const field = findField(dataset, condition.field)
    if (!field) {
      issues.push({
        code: 'field-not-found',
        message: `筛选字段 ${condition.field || '(空)'} 不在数据集 ${dataset.name} 中`,
        field: condition.field,
        conditionId: condition.id,
      })
      return
    }
    if (!OPERATORS_BY_TYPE[field.type].includes(condition.operator)) {
      issues.push({
        code: 'unsupported-operator',
        message: `${field.name} 是 ${field.type} 类型，不支持运算符 ${condition.operator}`,
        field: field.name,
        conditionId: condition.id,
      })
      return
    }
    if (condition.operator === 'regex') {
      const source = condition.value
      if (source.trim() === '') {
        issues.push({
          code: 'missing-condition-value',
          message: `${label} 的正则表达式为空`,
          field: field.name,
          conditionId: condition.id,
        })
        return
      }
      try {
        new RegExp(source)
      } catch {
        issues.push({
          code: 'invalid-regex',
          message: `${label} 的正则表达式无效：${source}`,
          field: field.name,
          conditionId: condition.id,
        })
        return
      }
    }
    const literals = condition.operator === 'in' ? splitInValues(condition.value) : [condition.value]
    if (literals.length === 0 || (condition.operator !== 'in' && condition.value.trim() === '')) {
      issues.push({
        code: 'missing-condition-value',
        message: `${label} 缺少比较值`,
        field: field.name,
        conditionId: condition.id,
      })
      return
    }
    for (const literal of literals) {
      const parsed = parseLiteral(literal, field.type)
      if (!parsed.ok) {
        issues.push({
          code: parsed.code,
          message:
            parsed.code === 'invalid-date'
              ? `${label} 的比较值不是合法日期：${literal}`
              : parsed.code === 'invalid-number'
                ? `${label} 的比较值不是数字：${literal}`
                : parsed.code === 'invalid-boolean'
                  ? `${label} 的比较值不是布尔值：${literal}`
                  : `${label} 缺少比较值`,
          field: field.name,
          conditionId: condition.id,
        })
        return
      }
    }
  })

  // 同一字段 + AND 构成一个分块：区间边界互相矛盾同样属于“进入计算前就该拒绝”。
  const andBlocks = new Map<string, FilterCondition[]>()
  for (const condition of config.conditions) {
    if (condition.combination !== 'AND') {
      continue
    }
    const list = andBlocks.get(condition.field) ?? []
    list.push(condition)
    andBlocks.set(condition.field, list)
  }
  for (const [fieldName, conditions] of andBlocks) {
    const field = findField(dataset, fieldName)
    if (!field) {
      continue
    }
    const hasEquality = conditions.some((item) => EQUALITY_OPERATORS.includes(item.operator))
    const hasRange = conditions.some((item) => RANGE_OPERATORS.includes(item.operator))
    if (hasEquality && hasRange) {
      issues.push({
        code: 'mutually-exclusive-comparison',
        message: `${fieldName} 在 AND 组合中同时使用了等值比较与区间比较，两者互斥`,
        field: fieldName,
      })
      continue
    }
    const equalityLiterals = new Set(
      conditions
        .filter((item) => item.operator === '=')
        .map((item) => item.value.trim()),
    )
    if (equalityLiterals.size > 1) {
      issues.push({
        code: 'contradictory-equality',
        message: `${fieldName} 在 AND 组合中被要求同时等于多个不同值，不可能命中`,
        field: fieldName,
      })
      continue
    }
    const ranges = conditions.filter((item) => RANGE_OPERATORS.includes(item.operator))
    if (ranges.length < 2) {
      continue
    }
    const bounds = ranges
      .map((item) => {
        const parsed = parseLiteral(item.value, field.type)
        if (!parsed.ok) {
          return null
        }
        const numeric = field.type === 'date' ? Date.parse(String(parsed.value)) : Number(parsed.value)
        return { condition: item, numeric }
      })
      .filter((item): item is { condition: FilterCondition; numeric: number } => item !== null)
    const lower = bounds.filter((item) => ['>', '>='].includes(item.condition.operator))
    const upper = bounds.filter((item) => ['<', '<='].includes(item.condition.operator))
    if (lower.length > 1 || upper.length > 1) {
      issues.push({
        code: 'contradictory-range',
        message: `${fieldName} 在 AND 组合中出现了多个同向区间边界`,
        field: fieldName,
      })
      continue
    }
    if (lower.length === 1 && upper.length === 1) {
      const lowerValue = lower[0].numeric
      const upperValue = upper[0].numeric
      const reversed = lowerValue > upperValue
      const emptyBoundary =
        lowerValue === upperValue &&
        (lower[0].condition.operator === '>' || upper[0].condition.operator === '<')
      if (reversed || emptyBoundary) {
        issues.push({
          code: 'contradictory-range',
          message: `${fieldName} 的区间下界与上界相互矛盾，不可能命中任何行`,
          field: fieldName,
        })
      }
    }
  }

  return dedupeIssues(issues)
}

function dedupeIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.code}|${issue.field ?? ''}|${issue.conditionId ?? ''}|${issue.message}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

/** 展示列只影响呈现顺序，但必须都是数据集真实字段。 */
export function validateDisplayColumns(
  columns: string[],
  dataset: DatasetDefinition | undefined,
): ValidationIssue[] {
  if (!dataset) {
    return [{ code: 'dataset-not-found', message: '目标数据集不存在' }]
  }
  if (columns.length === 0) {
    return [{ code: 'empty-display-columns', message: '至少保留一个展示列' }]
  }
  const issues: ValidationIssue[] = []
  const seen = new Set<string>()
  for (const column of columns) {
    if (seen.has(column)) {
      issues.push({
        code: 'invalid-display-column',
        message: `展示列 ${column} 重复，呈现顺序里不能出现两次`,
        field: column,
      })
      continue
    }
    seen.add(column)
    if (!findField(dataset, column)) {
      issues.push({
        code: 'invalid-display-column',
        message: `展示列 ${column} 不在数据集 ${dataset.name} 中`,
        field: column,
      })
    }
  }
  return issues
}

export function isOperatorCompatible(
  field: DatasetField | undefined,
  operator: ComparisonOperator,
): boolean {
  return field ? OPERATORS_BY_TYPE[field.type].includes(operator) : false
}
