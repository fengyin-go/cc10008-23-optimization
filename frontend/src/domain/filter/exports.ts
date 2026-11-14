import type {
  DatasetDefinition,
  ExportFile,
  FilterRule,
  HitRecord,
  RuleRun,
  RuleVersion,
} from './types'

function escapeCell(value: unknown): string {
  const text = String(value ?? '')
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function csvLine(cells: unknown[]): string {
  return cells.map(escapeCell).join(',')
}

export function runOutcomeLabel(run: RuleRun): string {
  if (run.outcome === 'matched') {
    return '有命中'
  }
  if (run.outcome === 'no-match') {
    return '确实无命中'
  }
  return '规则未执行'
}

const REASON_LABELS: Record<string, string> = {
  'rule-not-found': '规则不存在',
  'rule-disabled': '规则已停用',
  'rule-not-enabled': '规则尚未启用',
  'rule-not-published': '规则尚未发布版本',
  'needs-revalidation': '数据集结构已变化，需要重新校验',
  'validation-failed': '规则校验未通过',
  'unpublished-changes': '存在未发布的配置改动',
  'dataset-schema-changed': '目标数据集结构已变化，旧候选集失效',
  'dataset-not-found': '目标数据集不存在',
}

export function runReasonLabel(reason: RuleRun['reason']): string {
  return reason ? REASON_LABELS[reason] ?? reason : '无'
}

/** 结果文件必须自带规则版本信息：元数据行 + 每行一个「规则版本」列。 */
export function buildRunResultFile(
  run: RuleRun,
  version: RuleVersion | undefined,
  dataset: DatasetDefinition | undefined,
): ExportFile {
  const lines: string[] = []
  lines.push(csvLine(['# 结果文件', run.ruleName]))
  lines.push(
    csvLine([
      '# 规则版本',
      version ? `v${version.versionNo}` : run.versionNo,
      version?.id ?? run.ruleVersionId,
    ]),
  )
  lines.push(csvLine(['# 目标数据集', run.datasetName, dataset?.sourceTable ?? '']))
  lines.push(csvLine(['# 数据集结构版本', run.datasetSchemaVersion, '数据版本', run.datasetRevision]))
  lines.push(csvLine(['# 执行时间', run.createdAt, '结果状态', runOutcomeLabel(run)]))
  lines.push(csvLine(['# 命中行数', run.rowIds.length, '输出行数', run.outputRows.length]))
  lines.push('')
  const versionText = version ? `v${version.versionNo}` : `v${run.versionNo}`
  lines.push(csvLine(['规则版本', ...run.columns]))
  for (const row of run.outputRows) {
    lines.push(csvLine([versionText, ...row.values]))
  }
  return {
    filename: `${run.ruleName}-${versionText}-结果.csv`,
    content: `﻿${lines.join('\n')}`,
    mime: 'text/csv;charset=utf-8',
  }
}

/** 规则配置归档：规则、版本谱系与命中摘要装进一个 JSON 包。 */
export function buildRuleArchive(
  rule: FilterRule,
  versions: RuleVersion[],
  runs: RuleRun[],
  hits: HitRecord[],
): ExportFile {
  const archive = {
    kind: 'filter-rule-archive',
    exportedAt: new Date().toISOString(),
    rule,
    versions,
    runSummary: runs.map((run) => ({
      id: run.id,
      ruleVersionId: run.ruleVersionId,
      versionNo: run.versionNo,
      datasetId: run.datasetId,
      datasetSchemaVersion: run.datasetSchemaVersion,
      datasetRevision: run.datasetRevision,
      outcome: run.outcome,
      reason: run.reason,
      rowIds: run.rowIds,
      outputRowIds: run.outputRowIds,
    })),
    hitSummary: hits.map((hit) => ({
      id: hit.id,
      runId: hit.runId,
      ruleVersionId: hit.ruleVersionId,
      rowId: hit.rowId,
      blockKeys: hit.blockKeys,
      matchedAt: hit.matchedAt,
    })),
  }
  return {
    filename: `${rule.name}-规则归档.json`,
    content: JSON.stringify(archive, null, 2),
    mime: 'application/json;charset=utf-8',
  }
}
