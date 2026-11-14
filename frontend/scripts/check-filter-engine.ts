/**
 * 筛选引擎行为自检：用内存 localStorage 驱动真实服务层，逐条核对需求里的约束。
 * 运行方式见 package.json 的 check:filter（esbuild 打包后由 node 执行）。
 */

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  get length(): number {
    return this.map.size
  }
}

const storage = new MemoryStorage()
;(globalThis as unknown as { window: unknown }).window = { localStorage: storage }
;(globalThis as unknown as { document: unknown }).document = undefined

const {
  advanceShardTask,
  archiveRule,
  buildLatestRunFile,
  disableRule,
  enableRule,
  explainHit,
  getFilterSnapshot,
  openDrill,
  publishRule,
  resetFilterEngine,
  runRule,
  setDisplayColumns,
  startShardTask,
  submitValidation,
  updateDatasetSchema,
  updateRuleDraft,
  validateRule,
} = await import('../src/api/filter-service')

let failures = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function rule(id: string) {
  const found = getFilterSnapshot().rules.find((item) => item.id === id)
  if (!found) throw new Error(`规则 ${id} 不存在`)
  return found
}

function reset(): void {
  storage.clear()
  resetFilterEngine()
}

console.log('\n[1] 校验前置：缺失值 / 非法正则 / 互斥比较')
reset()
{
  const base = rule('rule-seed-1').config
  const missing = validateRule('rule-seed-1', {
    ...base,
    conditions: [{ id: 'c1', field: '区域', operator: '=', value: '  ', combination: 'AND' }],
  })
  check('缺失条件值被拒绝', missing.some((issue) => issue.code === 'missing-condition-value'), JSON.stringify(missing))

  const badRegex = validateRule('rule-seed-1', {
    ...base,
    conditions: [{ id: 'c1', field: '区域', operator: 'regex', value: '([', combination: 'AND' }],
  })
  check('非法正则被拒绝', badRegex.some((issue) => issue.code === 'invalid-regex'), JSON.stringify(badRegex))

  const mixed = validateRule('rule-seed-1', {
    ...base,
    conditions: [
      { id: 'c1', field: '金额', operator: '>', value: '100', combination: 'AND' },
      { id: 'c2', field: '金额', operator: '=', value: '500', combination: 'AND' },
    ],
  })
  check(
    '同分块等值/区间互斥被拒绝',
    mixed.some((issue) => issue.code === 'mutually-exclusive-comparison'),
    JSON.stringify(mixed),
  )

  const incompatibleType = validateRule('rule-seed-1', {
    ...base,
    conditions: [{ id: 'c1', field: '金额', operator: 'contains', value: '1', combination: 'AND' }],
  })
  check('字段类型不支持运算符被拒绝', incompatibleType.some((issue) => issue.code === 'unsupported-operator'))

  const contradictoryRange = validateRule('rule-seed-1', {
    ...base,
    conditions: [
      { id: 'c1', field: '金额', operator: '>', value: '900', combination: 'AND' },
      { id: 'c2', field: '金额', operator: '<', value: '100', combination: 'AND' },
    ],
  })
  check(
    '区间上下界矛盾被拒绝',
    contradictoryRange.some((issue) => issue.code === 'contradictory-range'),
    JSON.stringify(contradictoryRange),
  )

  const contradictoryEquality = validateRule('rule-seed-1', {
    ...base,
    conditions: [
      { id: 'c1', field: '区域', operator: '=', value: '华东', combination: 'AND' },
      { id: 'c2', field: '区域', operator: '=', value: '华南', combination: 'AND' },
    ],
  })
  check(
    '等值条件互相矛盾被拒绝',
    contradictoryEquality.some((issue) => issue.code === 'contradictory-equality'),
    JSON.stringify(contradictoryEquality),
  )

  const numberAsString = validateRule('rule-seed-1', {
    ...base,
    conditions: [{ id: 'c1', field: '金额', operator: '>', value: '一百', combination: 'AND' }],
  })
  check('数值字段写入非数字比较值被拒绝', numberAsString.some((issue) => issue.code === 'invalid-number'))
}

console.log('\n[2] 只刷新条件命中的块 + 相同规则连续发布只产生一个版本')
reset()
{
  const before = getFilterSnapshot()
  const first = runRule('rule-seed-1')
  check('首次执行有命中', first.outcome === 'matched', first.outcome)
  check('首次执行所有块都重算', first.blocks.every((block) => block.status === 'refreshed'))

  const v1 = rule('rule-seed-1').latestVersionId
  const publishSame = publishRule('rule-seed-1')
  check('相同内容发布复用版本', publishSame.ok && publishSame.created === false)
  check('版本号未增加', getFilterSnapshot().versions.length === before.versions.length)

  // 只调整金额块（华东条件保持不变）并发布
  const current = rule('rule-seed-1')
  const changed = {
    ...current.config,
    conditions: current.config.conditions.map((condition) =>
      condition.field === '金额' ? { ...condition, value: '1000' } : condition,
    ),
  }
  updateRuleDraft('rule-seed-1', changed)
  const published = publishRule('rule-seed-1')
  check('筛选条件变化生成了新版本', published.created === true)
  check('旧版本仍在版本谱系中', getFilterSnapshot().versions.some((version) => version.id === v1))

  const second = runRule('rule-seed-1')
  const regionBlock = second.blocks.find((block) => block.field === '区域')
  const amountBlock = second.blocks.find((block) => block.field === '金额')
  check('未变化的区域块被复用', regionBlock?.status === 'reused', JSON.stringify(regionBlock))
  check('变化的金额块重新过滤', amountBlock?.status === 'refreshed', JSON.stringify(amountBlock))
  check('命中行随新条件收窄', second.rowIds.length < first.rowIds.length, `${first.rowIds.length} -> ${second.rowIds.length}`)
}

console.log('\n[3] 下钻复用规则版本，旧下钻结果固定首次引用版本')
reset()
{
  runRule('rule-seed-1')
  const firstDrill = openDrill('rule-seed-1')
  check('首次下钻成功', firstDrill.ok && firstDrill.drill !== null, firstDrill.message)
  const pinnedVersion = firstDrill.drill?.firstReferencedVersionId

  const current = rule('rule-seed-1')
  updateRuleDraft('rule-seed-1', {
    ...current.config,
    conditions: current.config.conditions.map((condition) =>
      condition.field === '金额' ? { ...condition, value: '5000' } : condition,
    ),
  })
  publishRule('rule-seed-1')
  runRule('rule-seed-1')

  const secondDrill = openDrill('rule-seed-1')
  check('再次下钻复用首次引用版本', secondDrill.reusedFirstVersion === true)
  check('下钻版本未被新发布改写', secondDrill.drill?.firstReferencedVersionId === pinnedVersion)
  check(
    '下钻读取提示未采用最新版本',
    secondDrill.message.includes('首次引用'),
    secondDrill.message,
  )
}

console.log('\n[4] 停用后旧命中可溯源，但不参与新输出')
reset()
{
  const run = runRule('rule-seed-1')
  const hitId = run.hitIds[0]
  disableRule('rule-seed-1')
  const afterDisable = runRule('rule-seed-1')
  check('停用后执行结果是「未执行」', afterDisable.outcome === 'not-executed')
  check('原因标记为规则停用', afterDisable.reason === 'rule-disabled')
  check('停用后不产生新命中', afterDisable.hitIds.length === 0)

  const explanation = explainHit(hitId)
  check('旧命中仍可读取解释', !('ok' in explanation))
  if (!('ok' in explanation)) {
    check('解释里带规则版本', explanation.hit.ruleVersionId === run.ruleVersionId)
    check('解释里带分块条件', explanation.blocks.length > 0)
    check('明确不参与新输出', explanation.participatesInNewOutput === false)
    check('给出停用原因', explanation.disabledReason.includes('停用'))
  }
  const activeHits = getFilterSnapshot().hits.filter(
    (hit) => hit.ruleId === 'rule-seed-1' && hit.id === hitId,
  )
  check('旧命中记录仍保留', activeHits.length === 1)
}

console.log('\n[5] 空结果区分「确实无命中」与「规则未执行」')
reset()
{
  const noMatchConfig = {
    ...rule('rule-seed-1').config,
    conditions: [
      { id: 'c1', field: '区域', operator: '=', value: '华东', combination: 'AND' as const },
      { id: 'c2', field: '金额', operator: '>', value: '999999', combination: 'AND' as const },
    ],
  }
  updateRuleDraft('rule-seed-1', noMatchConfig)
  publishRule('rule-seed-1')
  const empty = runRule('rule-seed-1')
  check('无命中时 outcome=no-match', empty.outcome === 'no-match')
  check('无命中时命中集合为空', empty.rowIds.length === 0)

  const blocked = runRule('rule-seed-3')
  check('停用规则 outcome=not-executed', blocked.outcome === 'not-executed')
  check('未执行会给出原因', blocked.reason === 'rule-disabled', String(blocked.reason))
  check('未执行不会伪装成无命中', blocked.outcome !== 'no-match')
}

console.log('\n[6] 字段类型变化使旧候选集失效，不做隐式强转')
reset()
{
  const before = runRule('rule-seed-1')
  check('结构变化前有命中', before.outcome === 'matched')
  const changed = updateDatasetSchema('ds-orders', [
    { name: '订单编号', type: 'string' },
    { name: '客户编号', type: 'string' },
    { name: '区域', type: 'number' },
    { name: '金额', type: 'string' },
    { name: '数量', type: 'number' },
    { name: '是否退款', type: 'boolean' },
    { name: '下单日期', type: 'date' },
    { name: '渠道', type: 'string' },
  ])
  check('结构变化返回失效块数量', changed.ok && changed.invalidatedBlocks >= 0, JSON.stringify(changed))
  check('受影响规则被标记', changed.affectedRules.includes('rule-seed-1'))

  const blocked = runRule('rule-seed-1')
  check('旧候选集失效后不执行', blocked.outcome === 'not-executed')
  check('原因为结构变化', blocked.reason === 'dataset-schema-changed' || blocked.reason === 'needs-revalidation', String(blocked.reason))

  const badEnable = enableRule('rule-seed-1')
  check('重新启用前必须重新校验字段可用性', badEnable.ok === false, badEnable.message)

  // 把规则改到新结构下可用（区域是 number，不能用 ='华东'）
  updateRuleDraft('rule-seed-1', {
    ...rule('rule-seed-1').config,
    conditions: [
      { id: 'c1', field: '区域', operator: '=', value: '1', combination: 'AND' },
      { id: 'c2', field: '金额', operator: '=', value: '1280', combination: 'AND' },
    ],
  })
  publishRule('rule-seed-1')
  const enabled = enableRule('rule-seed-1')
  check('按新结构重新校验后可启用', enabled.ok, enabled.message)
}

console.log('\n[7] 展示列只改呈现顺序，不改变命中集合')
reset()
{
  const run = runRule('rule-seed-1')
  const hitBefore = [...run.rowIds].sort().join(',')
  const versionBefore = rule('rule-seed-1').latestVersionId
  const swap = setDisplayColumns('rule-seed-1', ['金额', '区域', '订单编号', '下单日期'])
  check('展示列切换成功', swap.ok, swap.message)
  const after = runRule('rule-seed-1')
  check('命中集合不变', [...after.rowIds].sort().join(',') === hitBefore)
  check('版本未变化', rule('rule-seed-1').latestVersionId === versionBefore)
  check('输出列顺序已变', after.columns[0] === '金额' && after.columns[1] === '区域')

  const invalid = setDisplayColumns('rule-seed-1', ['不存在的列'])
  check('非法展示列被拒绝', invalid.ok === false)
}

console.log('\n[8] 两个分片任务各自记录所用版本；批次执行中停用只在批次边界生效')
reset()
{
  const shardA = startShardTask('rule-seed-1', { shardIndex: 0, shardTotal: 2, batchSize: 2 })
  const shardB = startShardTask('rule-seed-1', { shardIndex: 1, shardTotal: 2, batchSize: 2 })
  check('两个分片都启动成功', shardA.ok && shardB.ok)
  check('分片 A 记录版本', (shardA.task?.versionNo ?? 0) > 0 && shardA.task?.versionUsed === rule('rule-seed-1').latestVersionId)
  check('分片 B 记录版本', shardB.task?.versionUsed === shardA.task?.versionUsed)

  // 发布新版本后，已启动任务仍读取旧版本
  const current = rule('rule-seed-1')
  updateRuleDraft('rule-seed-1', {
    ...current.config,
    conditions: current.config.conditions.map((condition) =>
      condition.field === '金额' ? { ...condition, value: '400' } : condition,
    ),
  })
  publishRule('rule-seed-1')
  const newer = getFilterSnapshot().versions.find((version) => version.ruleId === 'rule-seed-1' && version.versionNo === 2)
  check('新版本已发布', Boolean(newer))
  const shardAAfter = getFilterSnapshot().shardTasks.find((task) => task.id === shardA.task?.id)
  check('已启动任务版本未被改写', shardAAfter?.versionUsed === shardA.task?.versionUsed)
  const advance = advanceShardTask(shardA.task!.id)
  check('任务继续用旧版本推进', advance.ok && advance.task?.versionUsed === shardA.task?.versionUsed)

  // 批次执行中同步停用：当前批次完成后停止
  const shardC = startShardTask('rule-seed-1', { shardIndex: 0, shardTotal: 1, batchSize: 3 })
  let disabledDuringBatch = false
  const result = advanceShardTask(shardC.task!.id, {
    interleave: () => {
      if (!disabledDuringBatch) {
        disabledDuringBatch = true
        disableRule('rule-seed-1')
      }
    },
  })
  check('停用信号在批次内被观察到', disabledDuringBatch)
  check('当前批次完整跑完', result.task?.batchesCompleted === 1 && result.task?.rowsScanned === 3, JSON.stringify(result.task))
  check('批次完成后停止任务', result.task?.status === 'stopped')
  check('停止原因记录为停用', result.task?.stopReason === 'rule-disabled-after-batch', String(result.task?.stopReason))
}

console.log('\n[9] 结果文件带规则版本；规则可打包归档')
reset()
{
  const run = runRule('rule-seed-1')
  const file = buildLatestRunFile('rule-seed-1')
  check('结果文件生成成功', !('ok' in file), JSON.stringify(file))
  if (!('ok' in file)) {
    check('结果文件标注规则版本', file.content.includes('# 规则版本') && file.content.includes(`v${run.versionNo}`))
    check('结果文件每行带版本列', file.content.includes('规则版本'))
    check('结果文件文件名带版本', file.filename.includes(`v${run.versionNo}`))
  }
  const archive = archiveRule('rule-seed-1')
  check('规则归档生成成功', !('ok' in archive))
  if (!('ok' in archive)) {
    const parsed = JSON.parse(archive.content) as { versions: unknown[]; rule: { id: string } }
    check('归档内含版本谱系', Array.isArray(parsed.versions) && parsed.versions.length > 0)
    check('归档内含规则配置', parsed.rule.id === 'rule-seed-1')
  }
}

console.log('\n[10] 规则未发布/有未发布改动时不计算')
reset()
{
  const draftOnly = runRule('rule-seed-3')
  check('停用规则不执行', draftOnly.outcome === 'not-executed' && draftOnly.reason === 'rule-disabled')
  enableRule('rule-seed-3')
  const current = rule('rule-seed-3')
  updateRuleDraft('rule-seed-3', {
    ...current.config,
    conditions: current.config.conditions.map((condition) =>
      condition.field === '停留秒数' ? { ...condition, value: '5' } : condition,
    ),
  })
  const stale = runRule('rule-seed-3')
  check('未发布改动时不使用旧版本', stale.outcome === 'not-executed' && stale.reason === 'unpublished-changes', `${stale.outcome}/${stale.reason}`)
}

console.log('\n[11] 新登记规则默认草稿，条件补齐前不会被执行')
reset()
{
  const { createRule } = await import('../src/api/filter-service')
  const created = createRule('新建筛选规则', 'ds-orders')
  check('新规则登记成功', created.ok && Boolean(created.ruleId), created.message)
  const fresh = getFilterSnapshot().rules.find((rule) => rule.id === created.ruleId)
  check('新规则状态为草稿', fresh?.status === 'draft')
  const blocked = runRule(created.ruleId!)
  check('草稿规则不执行', blocked.outcome === 'not-executed' && blocked.reason === 'rule-not-enabled', `${blocked.outcome}/${blocked.reason}`)
  const publishAttempt = publishRule(created.ruleId!)
  check('条件未补齐时发布被拒绝', publishAttempt.ok === false)
  const duplicate = createRule('新建筛选规则', 'ds-orders')
  check('同名规则被拒绝', duplicate.ok === false)
}

console.log(failures === 0 ? '\n全部检查通过' : `\n${failures} 项检查未通过`)
process.exitCode = failures === 0 ? 0 : 1
