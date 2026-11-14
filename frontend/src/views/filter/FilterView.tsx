import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  archiveRule,
  buildLatestRunFile,
  createRule,
  disableRule,
  downloadFile,
  enableRule,
  explainHit,
  getFilterSnapshot,
  openDrill,
  publishRule,
  resetFilterEngine,
  runRule,
  setDisplayColumns,
  startShardTask,
  advanceShardTask,
  submitValidation,
  updateRuleDraft,
} from '@/api/filter-service'
import {
  COMPARISON_OPERATORS,
  LOGICAL_COMBINATIONS,
  OPERATOR_LABELS,
  RULE_STATUS_LABELS,
  type ComparisonOperator,
  type DatasetDefinition,
  type FilterCondition,
  type FilterRule,
  type FilterRuleConfig,
  type HitExplanation,
  type RuleRun,
  type ShardTask,
  type ValidationIssue,
} from '@/domain/filter/types'
import { runOutcomeLabel, runReasonLabel } from '@/domain/filter/exports'
import { OPERATORS_BY_TYPE } from '@/domain/filter/validation'

const statusOrder = ['draft', 'validated', 'enabled', 'disabled'] as const

export default function FilterStudioView() {
  const [version, setVersion] = useState(0)
  const [selectedRuleId, setSelectedRuleId] = useState<string>('')
  const [message, setMessage] = useState('')
  const [issues, setIssues] = useState<ValidationIssue[]>([])

  const [detailHit, setDetailHit] = useState<HitExplanation | null>(null)

  const [editingRuleId, setEditingRuleId] = useState('')
  const [editDraft, setEditDraft] = useState<FilterRuleConfig | null>(null)
  const [editColumns, setEditColumns] = useState<string[]>([])
  const [newRuleName, setNewRuleName] = useState('')
  const [newRuleDataset, setNewRuleDataset] = useState('')

  const refresh = useCallback(() => setVersion((value) => value + 1), [])
  const snapshot = useMemo(() => {
    void version
    return getFilterSnapshot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  const rules = snapshot.rules
  const selectedRule = rules.find((rule) => rule.id === selectedRuleId) ?? rules[0]
  const dataset = snapshot.datasets.find((item) => item.id === selectedRule?.config.datasetId)
  const ruleVersions = snapshot.versions.filter((item) => item.ruleId === selectedRule?.id)
  const latestVersion = ruleVersions.find((item) => item.id === selectedRule?.latestVersionId)
  const ruleRuns = snapshot.runs.filter((run) => run.ruleId === selectedRule?.id)
  const latestRun = ruleRuns[0]
  const ruleHits = snapshot.hits.filter((hit) => hit.ruleId === selectedRule?.id)
  const ruleDrills = snapshot.drills.filter((drill) => drill.ruleId === selectedRule?.id)
  const ruleTasks = snapshot.shardTasks.filter((task) => task.ruleId === selectedRule?.id)
  const ruleStats = snapshot.rules.map((rule) => ({
    rule,
    runs: snapshot.runs.filter((run) => run.ruleId === rule.id).length,
    versionNo: snapshot.versions.find((version) => version.id === rule.latestVersionId)?.versionNo,
  }))

  useEffect(() => {
    if (rules.length > 0 && !rules.some((rule) => rule.id === selectedRuleId)) {
      setSelectedRuleId(rules[0].id)
    }
  }, [rules, selectedRuleId])

  useEffect(() => {
    if (!newRuleDataset && snapshot.datasets.length > 0) {
      setNewRuleDataset(snapshot.datasets[0].id)
    }
  }, [snapshot.datasets, newRuleDataset])

  const beginEdit = (rule: FilterRule) => {
    setEditingRuleId(rule.id)
    setEditDraft({
      datasetId: rule.config.datasetId,
      conditions: rule.config.conditions.map((condition) => ({ ...condition })),
      sortField: rule.config.sortField,
      sortDirection: rule.config.sortDirection,
      limit: rule.config.limit,
    })
    setEditColumns([...rule.displayColumns])
    setSelectedRuleId(rule.id)
  }

  const activeDraft = editingRuleId === selectedRule?.id && editDraft ? editDraft : selectedRule?.config
  const activeColumns =
    editingRuleId === selectedRule?.id ? editColumns : selectedRule?.displayColumns ?? []

  const mutate = (fn: () => { ok: boolean; message: string; issues?: ValidationIssue[] }) => {
    const result = fn()
    setMessage(result.message)
    setIssues(result.issues ?? [])
    refresh()
    return result
  }

  const stats = [
    { label: '筛选规则总数', value: snapshot.stats.ruleCount },
    { label: '已启用规则', value: snapshot.stats.enabledRules },
    { label: '规则版本数', value: snapshot.stats.versionCount },
    { label: '可复用分块', value: snapshot.stats.cachedBlocks },
    { label: '命中行留存', value: snapshot.stats.hitCount },
    { label: '停用后执行请求', value: snapshot.stats.disabledRuns },
    { label: '下钻快照', value: snapshot.stats.drillCount },
  ]

  function patchDraft(patch: Partial<FilterRuleConfig>) {
    if (!editDraft || !selectedRule) {
      return
    }
    setEditDraft((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  function patchCondition(index: number, patch: Partial<FilterCondition>) {
    if (!editDraft) {
      return
    }
    const next = editDraft.conditions.map((condition, position) =>
      position === index ? { ...condition, ...patch } : condition,
    )
    setEditDraft({ ...editDraft, conditions: next })
  }

  function addCondition() {
    if (!editDraft || !dataset) {
      return
    }
    const field = dataset.fields[0]
    setEditDraft({
      ...editDraft,
      conditions: [
        ...editDraft.conditions,
        {
          id: `cond-${editDraft.conditions.length + 1}-${Date.now().toString(36)}`,
          field: field.name,
          operator: OPERATORS_BY_TYPE[field.type][0],
          value: '',
          combination: 'AND',
        },
      ],
    })
  }

  function removeCondition(index: number) {
    if (!editDraft) {
      return
    }
    setEditDraft({
      ...editDraft,
      conditions: editDraft.conditions.filter((_, position) => position !== index),
    })
  }

  function shiftColumn(column: string, direction: -1 | 1) {
    const columns = [...activeColumns]
    const index = columns.indexOf(column)
    const target = index + direction
    if (index < 0 || target < 0 || target >= columns.length) {
      return
    }
    ;[columns[index], columns[target]] = [columns[target], columns[index]]
    if (editingRuleId === selectedRule?.id) {
      setEditColumns(columns)
    } else if (selectedRule) {
      mutate(() => setDisplayColumns(selectedRule.id, columns))
    }
  }

  function toggleColumn(column: string) {
    const columns = [...activeColumns]
    if (columns.includes(column)) {
      if (columns.length === 1) {
        return
      }
      columns.splice(columns.indexOf(column), 1)
    } else {
      columns.push(column)
    }
    if (editingRuleId === selectedRule?.id) {
      setEditColumns(columns)
    } else if (selectedRule) {
      mutate(() => setDisplayColumns(selectedRule.id, columns))
    }
  }

  return (
    <section className="page" data-module="filter-engine">
      <header className="page-head">
        <div>
          <h2>数据筛选 · 规则工作台</h2>
          <p className="page-desc">
            按「筛选字段 + 逻辑组合」切分可复用分块；只有条件变化的块重新过滤，命中的行集合与规则版本一并留存，
            下钻与分片任务各自引用固定版本。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={() => { resetFilterEngine(); setEditingRuleId(''); setDetailHit(null); setMessage('已恢复示例规则与数据集'); refresh() }}>
            重置示例数据
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <div className="studio-grid">
        <aside className="studio-rules">
          <h3>筛选规则</h3>
          {(statusOrder as readonly string[]).map((status) => (
            <div key={status} className="rule-group">
              <span className="rule-group-label">
                {RULE_STATUS_LABELS[status as keyof typeof RULE_STATUS_LABELS]}：
                {rules.filter((rule) => rule.status === status).length}
              </span>
            </div>
          ))}
          <div className="rule-create">
            <input
              value={newRuleName}
              placeholder="新规则名称"
              onChange={(event) => setNewRuleName(event.target.value)}
            />
            <select value={newRuleDataset} onChange={(event) => setNewRuleDataset(event.target.value)}>
              {snapshot.datasets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <button
              className="btn"
              type="button"
              onClick={() => {
                const result = createRule(newRuleName, newRuleDataset)
                setMessage(result.message)
                setIssues([])
                if (result.ok) {
                  setNewRuleName('')
                  if (result.ruleId) {
                    setSelectedRuleId(result.ruleId)
                    setEditingRuleId('')
                  }
                }
                refresh()
              }}
            >
              登记筛选规则
            </button>
          </div>
          <ul className="rule-list">
            {ruleStats.map(({ rule, runs, versionNo }) => (
              <li key={rule.id}>
                <button
                  type="button"
                  className={`rule-item ${rule.id === selectedRule?.id ? 'active' : ''}`}
                  onClick={() => { setSelectedRuleId(rule.id); setEditingRuleId(''); setDetailHit(null) }}
                >
                  <span className="rule-name">{rule.name}</span>
                  <span className="rule-meta">
                    {RULE_STATUS_LABELS[rule.status]} · v{versionNo ?? '-'} · 执行 {runs}
                  </span>
                  {rule.needsRevalidation && <span className="rule-flag">需要重新校验</span>}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="studio-main">
          {!selectedRule || !dataset ? (
            <p className="empty-state">没有可用规则或目标数据集。</p>
          ) : (
            <>
              <div className="toolbar">
                <button className="btn" type="button" onClick={() => beginEdit(selectedRule)}>编辑草稿</button>
                <button className="btn" type="button" onClick={() => mutate(() => submitValidation(selectedRule.id))}>提交校验</button>
                <button className="btn primary" type="button" onClick={() => mutate(() => publishRule(selectedRule.id))}>发布版本</button>
                <button className="btn" type="button" onClick={() => mutate(() => enableRule(selectedRule.id))}>启用规则</button>
                <button className="btn" type="button" onClick={() => mutate(() => disableRule(selectedRule.id))}>停用规则</button>
                <button className="btn" type="button" onClick={() => {
                  const run = runRule(selectedRule.id)
                  setMessage(`${runOutcomeLabel(run)}：命中 ${run.rowIds.length} 行，输出 ${run.outputRows.length} 行${run.warning ? `（${run.warning}）` : ''}`)
                  refresh()
                }}>执行筛选</button>
                <button className="btn" type="button" onClick={() => {
                  const run = runRule(selectedRule.id, { forceRefresh: true })
                  setMessage(`已强制重新过滤：命中 ${run.rowIds.length} 行，涉及 ${run.blocks.filter((block) => block.status === 'refreshed').length} 个块`)
                  refresh()
                }}>全量重算</button>
                <button className="btn ghost" type="button" onClick={() => {
                  const result = openDrill(selectedRule.id)
                  setMessage(`${result.ok ? '' : '未生成下钻：'}${result.message}`)
                  refresh()
                }}>打开下钻</button>
                <button className="btn ghost" type="button" onClick={() => {
                  const result = startShardTask(selectedRule.id, { shardIndex: 0, shardTotal: 1, batchSize: 3 })
                  setMessage(result.message)
                  refresh()
                }}>启动分片任务</button>
                <button className="btn ghost" type="button" onClick={() => {
                  const file = buildLatestRunFile(selectedRule.id)
                  if ('ok' in file) {
                    setMessage(file.message)
                  } else {
                    downloadFile(file)
                    setMessage(`已下载 ${file.filename}`)
                  }
                  refresh()
                }}>下载命中结果</button>
                <button className="btn ghost" type="button" onClick={() => {
                  const file = archiveRule(selectedRule.id)
                  if ('ok' in file) {
                    setMessage(file.message)
                  } else {
                    downloadFile(file)
                    setMessage(`已归档 ${file.filename}`)
                  }
                }}>打包规则归档</button>
              </div>

              {(message || issues.length > 0) && (
                <div className="notice">
                  {message && <p className="notice-text">{message}</p>}
                  {issues.length > 0 && (
                    <ul className="issue-list">
                      {issues.map((issue, index) => (
                        <li key={`${issue.code}-${index}`}>{issue.message}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {activeDraft && (
                <RuleEditor
                  dataset={dataset}
                  draft={activeDraft}
                  columns={activeColumns}
                  editing={editingRuleId === selectedRule.id}
                  onChange={patchDraft}
                  onConditionChange={patchCondition}
                  onAddCondition={addCondition}
                  onRemoveCondition={removeCondition}
                  onToggleColumn={toggleColumn}
                  onMoveColumn={shiftColumn}
                  onSave={() => {
                    const result = mutate(() => updateRuleDraft(selectedRule.id, activeDraft, activeColumns))
                    if (result.ok) {
                      setEditingRuleId('')
                    }
                  }}
                  onCancel={() => setEditingRuleId('')}
                />
              )}

              <div className="panel-grid">
                <section className="panel">
                  <h3>执行结果</h3>
                  {!latestRun && <p className="empty-state">还没有执行记录，点「执行筛选」。</p>}
                  {latestRun && <RunSummary run={latestRun} />}
                </section>

                <section className="panel">
                  <h3>版本谱系</h3>
                  {ruleVersions.length === 0 && <p className="empty-state">尚未发布版本。</p>}
                  <ul className="version-list">
                    {[...ruleVersions].sort((a, b) => b.versionNo - a.versionNo).map((item) => (
                      <li key={item.id} className={item.id === selectedRule.latestVersionId ? 'current' : ''}>
                        <span>v{item.versionNo} · {item.id}</span>
                        <span className="muted">
                          {item.id === selectedRule.latestVersionId ? '当前' : '历史'} · 结构 v{item.datasetSchemaVersion}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {latestVersion && (
                    <p className="hint">
                      连续发布相同筛选条件不会新增版本；展示列调整也不会改变版本。
                    </p>
                  )}
                </section>
              </div>

              <section className="panel">
                <h3>命中行与溯源（停用后仍可解释来源）</h3>
                {ruleHits.length === 0 && <p className="empty-state">还没有命中记录。</p>}
                {ruleHits.length > 0 && (
                  <table className="data-table compact">
                    <thead>
                      <tr>
                        <th>行</th>
                        <th>版本</th>
                        <th>解释块</th>
                        <th>状态</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ruleHits.slice(-30).reverse().map((hit) => (
                        <tr key={hit.id}>
                          <td>{hit.rowSnapshot.values.join(' / ') || `#${hit.rowId}`}</td>
                          <td>v{hit.versionNo}</td>
                          <td>{hit.blockKeys.join('、')}</td>
                          <td>
                            {selectedRule.status === 'enabled' && selectedRule.latestVersionId === hit.ruleVersionId
                              ? '参与新输出'
                              : '仅历史溯源'}
                          </td>
                          <td>
                            <button className="link" type="button" onClick={() => {
                              const explanation = explainHit(hit.id)
                              if ('ok' in explanation) {
                                setMessage(explanation.message)
                              } else {
                                setDetailHit(explanation)
                              }
                            }}>查看来源</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {detailHit && (
                  <div className="explain-card">
                    <p>
                      <strong>规则版本：</strong>v{detailHit.hit.versionNo}（{detailHit.hit.ruleVersionId}）
                      <strong className="spaced">数据集：</strong>{detailHit.hit.datasetName} 结构 v{detailHit.hit.datasetSchemaVersion}
                    </p>
                    <p><strong>命中的块：</strong>{detailHit.blocks.map((block) => `${block.key}（${block.conditions.map((condition) => `${OPERATOR_LABELS[condition.operator]} ${condition.value}`).join(' 且 ')}）`).join('；')}</p>
                    <p><strong>输出参与：</strong>{detailHit.participatesInNewOutput ? '参与新输出' : `不参与新输出 —— ${detailHit.disabledReason}`}</p>
                    <p><strong>行快照：</strong>{JSON.stringify(detailHit.hit.rowSnapshot.raw)}</p>
                    <button className="link" type="button" onClick={() => setDetailHit(null)}>收起</button>
                  </div>
                )}
              </section>

              <div className="panel-grid">
                <section className="panel">
                  <h3>下钻结果（固定首次引用版本）</h3>
                  {ruleDrills.length === 0 && <p className="empty-state">还没有下钻结果。</p>}
                  {ruleDrills.map((drill) => (
                    <div key={drill.id} className="drill-card">
                      <p>
                        首次引用 v{drill.firstReferencedVersionNo} · 当前读取 v{drill.versionNo} · 命中 {drill.rows.length} 行
                      </p>
                      <p className="muted">数据集 {drill.datasetName} 结构 v{drill.datasetSchemaVersion} · 生成于 {drill.createdAt}</p>
                      <ul className="drill-rows">
                        {drill.rows.slice(0, 8).map((row) => (
                          <li key={row.rowId}>{row.values.join(' / ')}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </section>

                <section className="panel">
                  <h3>分片任务</h3>
                  {ruleTasks.length === 0 && <p className="empty-state">还没有分片任务。</p>}
                  {ruleTasks.map((task) => (
                    <ShardCard
                      key={task.id}
                      task={task}
                      onAdvance={() => {
                        const result = advanceShardTask(task.id)
                        setMessage(result.message)
                        refresh()
                      }}
                    />
                  ))}
                </section>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function RuleEditor(props: {
  dataset: DatasetDefinition
  draft: FilterRuleConfig
  columns: string[]
  editing: boolean
  onChange: (patch: Partial<FilterRuleConfig>) => void
  onConditionChange: (index: number, patch: Partial<FilterCondition>) => void
  onAddCondition: () => void
  onRemoveCondition: (index: number) => void
  onToggleColumn: (column: string) => void
  onMoveColumn: (column: string, direction: -1 | 1) => void
  onSave: () => void
  onCancel: () => void
}) {
  const { dataset, draft, columns, editing } = props
  return (
    <section className="panel editor">
      <h3>筛选条件（按字段 + 逻辑组合分块）</h3>
      <table className="data-table compact">
        <thead>
          <tr>
            <th>逻辑</th>
            <th>筛选字段</th>
            <th>比较运算符</th>
            <th>比较值</th>
            <th>块键</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {draft.conditions.map((condition, index) => {
            const field = dataset.fields.find((item) => item.name === condition.field)
            const operators = field ? OPERATORS_BY_TYPE[field.type] : COMPARISON_OPERATORS
            return (
              <tr key={condition.id}>
                <td>
                  <select
                    value={condition.combination}
                    disabled={!editing}
                    onChange={(event) => props.onConditionChange(index, { combination: event.target.value as 'AND' | 'OR' })}
                  >
                    {LOGICAL_COMBINATIONS.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </td>
                <td>
                  <select
                    value={condition.field}
                    disabled={!editing}
                    onChange={(event) => props.onConditionChange(index, { field: event.target.value })}
                  >
                    {dataset.fields.map((item) => <option key={item.name} value={item.name}>{item.name}（{item.type}）</option>)}
                  </select>
                </td>
                <td>
                  <select
                    value={condition.operator}
                    disabled={!editing}
                    onChange={(event) => props.onConditionChange(index, { operator: event.target.value as ComparisonOperator })}
                  >
                    {operators.map((item) => <option key={item} value={item}>{item} {OPERATOR_LABELS[item]}</option>)}
                  </select>
                </td>
                <td>
                  <input
                    value={condition.value}
                    disabled={!editing}
                    placeholder="条件值不可为空"
                    onChange={(event) => props.onConditionChange(index, { value: event.target.value })}
                  />
                </td>
                <td className="muted">{condition.field || '—'}::{condition.combination}</td>
                <td>
                  {editing && <button className="link" type="button" onClick={() => props.onRemoveCondition(index)}>移除</button>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div className="editor-row">
        {editing && <button className="btn ghost" type="button" onClick={props.onAddCondition}>添加条件</button>}
        <label className="filter-item">
          <span>排序字段</span>
          <select
            value={draft.sortField}
            disabled={!editing}
            onChange={(event) => props.onChange({ sortField: event.target.value })}
          >
            <option value="">不排序（按行号）</option>
            {dataset.fields.map((field) => <option key={field.name} value={field.name}>{field.name}</option>)}
          </select>
        </label>
        <label className="filter-item">
          <span>排序方向</span>
          <select
            value={draft.sortDirection}
            disabled={!editing}
            onChange={(event) => props.onChange({ sortDirection: event.target.value as 'asc' | 'desc' })}
          >
            <option value="asc">升序</option>
            <option value="desc">降序</option>
          </select>
        </label>
        <label className="filter-item">
          <span>输出行数上限</span>
          <input
            type="number"
            min={1}
            value={draft.limit}
            disabled={!editing}
            onChange={(event) => props.onChange({ limit: Number(event.target.value) })}
          />
        </label>
      </div>

      <h3>展示列（只改变呈现顺序，不改变命中集合）</h3>
      <div className="column-chips">
        {dataset.fields.map((field) => (
          <button
            key={field.name}
            type="button"
            className={`chip ${columns.includes(field.name) ? 'on' : ''}`}
            onClick={() => props.onToggleColumn(field.name)}
          >
            {field.name}
          </button>
        ))}
      </div>
      <ul className="column-order">
        {columns.map((column, index) => (
          <li key={column}>
            <span>{index + 1}. {column}</span>
            <button className="link" type="button" onClick={() => props.onMoveColumn(column, -1)} disabled={index === 0}>上移</button>
            <button className="link" type="button" onClick={() => props.onMoveColumn(column, 1)} disabled={index === columns.length - 1}>下移</button>
          </li>
        ))}
      </ul>

      {editing && (
        <div className="editor-row">
          <button className="btn primary" type="button" onClick={props.onSave}>保存草稿</button>
          <button className="btn ghost" type="button" onClick={props.onCancel}>取消</button>
        </div>
      )}
    </section>
  )
}

function RunSummary({ run }: { run: RuleRun }) {
  return (
    <div className="run-summary">
      <p>
        <span className={`badge ${run.outcome}`}>{runOutcomeLabel(run)}</span>
        <span className="spaced">v{run.versionNo} · {run.id}</span>
        {run.runReused && <span className="badge reused">复用已记录命中</span>}
      </p>
      {run.reason && (
        <p className="hint">未执行原因：{runReasonLabel(run.reason)}{run.warning ? ` —— ${run.warning}` : ''}</p>
      )}
      {run.outcome === 'matched' && (
        <>
          <p>
            命中 {run.rowIds.length} 行，输出 {run.outputRows.length} 行（上限 {run.outputRowIds.length === run.rowIds.length ? '未截断' : '已截断'}）；
            类型不兼容 {run.incompatibleCount} 行
          </p>
          <table className="data-table compact">
            <thead>
              <tr>
                {run.columns.map((column) => <th key={column}>{column}</th>)}
                <th>规则版本</th>
              </tr>
            </thead>
            <tbody>
              {run.outputRows.slice(0, 12).map((row) => (
                <tr key={row.rowId}>
                  {row.values.map((value, index) => <td key={index}>{String(value)}</td>)}
                  <td>v{run.versionNo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {run.outcome === 'no-match' && <p className="hint">规则已正常执行，目标数据集没有任何行满足全部条件（不是规则未执行）。</p>}
      <h4>分块执行明细</h4>
      {run.blocks.length === 0 && <p className="hint">本次未进入块计算。</p>}
      <table className="data-table compact">
        <thead>
          <tr>
            <th>块键</th>
            <th>缓存状态</th>
            <th>命中行</th>
            <th>类型不兼容行</th>
          </tr>
        </thead>
        <tbody>
          {run.blocks.map((block) => (
            <tr key={block.key}>
              <td>{block.key}</td>
              <td>{block.status === 'reused' ? '复用缓存' : block.status === 'refreshed' ? '重新过滤' : '跳过'}</td>
              <td>{block.matchedCount}</td>
              <td>{block.incompatibleCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ShardCard({ task, onAdvance }: { task: ShardTask; onAdvance: () => void }) {
  return (
    <div className="drill-card">
      <p>
        分片 {task.shardIndex + 1}/{task.shardTotal} · 读取 v{task.versionNo}（{task.versionUsed}）
        <span className={`badge ${task.status}`}>{task.status === 'running' ? '执行中' : task.status === 'completed' ? '已完成' : '已停止'}</span>
      </p>
      <p className="muted">
        已扫描 {task.rowsScanned}/{task.rowIds.length} 行 · 命中 {task.hitRowIds.length} 行 · 批次 {task.batchesCompleted}
        {task.rowsScanned < task.rowIds.length ? '（批次边界停止，未继续读取）' : ''}
      </p>
      {task.pendingStopReason && <p className="hint">已收到停用信号，当前批次完成后停止。</p>}
      {task.stopReason && <p className="hint">停止原因：{task.stopReason}</p>}
      {task.status === 'running' && <button className="btn" type="button" onClick={onAdvance}>推进一个批次</button>}
    </div>
  )
}
