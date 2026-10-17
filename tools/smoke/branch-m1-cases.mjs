/**
 * M1 冒烟测试：建子会话（无 seed + 血缘 + 人设继承）、节点派生、孤儿升根。
 *
 * 用 `src/testing/fake-sessions.ts` 造的假 DSH 会话面驱动真实的 `BranchService`
 * 与真实的 `/branch/*` 路由，因此覆盖的是生产代码路径，不是替身逻辑。
 *
 * 注意：用例**按顺序串行执行**（共享同一 storageRoot，且后面的用例依赖前面的结果），
 * 所以这里依次 await，而不是并发 Promise.all。
 *
 * 用法：node tools/smoke/branch-m1-cases.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BranchFailure, BranchService, Config, TreeStore, apply } from '../../lib/index.js'
import { createFakeSessions } from '../../lib/testing/fake-sessions.js'

const cases = []
/** 注册一个串行执行的用例。 */
const track = (name, fn) => cases.push({ name, fn })

const knownCode = (error) => (error instanceof BranchFailure ? error.code : `不是 BranchFailure：${error}`)
const never = new AbortController().signal

/** 造一套「插件上下文 + 假会话面 + 真服务」。 */
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'branch-m1-'))
  const fake = createFakeSessions()
  const store = new TreeStore({ root })
  const ctx = {
    agents: fake.agents,
    sessions: fake.store,
    sessionController: fake.controller,
    agentPresets: fake.presets,
    agentDefaultModel: fake.defaultModel,
    // 缺陷 29：工作区账本。建子会话后必须把新会话 attachSession 到父会话所在的工作区。
    workspaceRegistry: fake.workspaces,
  }
  const service = new BranchService({ store, ctx, log: () => {} })
  return { root, fake, store, service }
}

// ---------------------------------------------------------------------------
// 1. 建子会话：不继承上下文、继承人设与 cwd、挂到父节点下
// ---------------------------------------------------------------------------

const h1 = await harness()
h1.fake.seedSession({ id: 's-parent', turns: 2, cwd: 'D:\\work', agentPreset: 'standard' })
// 父会话在一个工作区里（侧边栏的「f分支对话插件」那一组）：子会话应挂进同一个工作区。
h1.fake.workspaces.seedWorkspace({ id: 'ws-work', path: 'D:\\work', sessionIds: ['s-parent'] })
let firstBranch = null

track('createBranch：新会话无 seed（seedLength=0）但有血缘与同一个人设', async () => {
  firstBranch = await h1.service.createBranch(
    { parentSessionId: 's-parent', parentTurn: 2, prompt: '这个函数的复杂度是多少？' },
    never,
  )
  const child = h1.fake.get(firstBranch.sessionId)
  assert.ok(child !== undefined, '没有创建出新会话')
  assert.equal(child.meta.seedLength, 0, '新会话不该继承任何事件前缀')
  assert.equal(child.meta.parentSession, 's-parent', '血缘应指向父会话')
  assert.equal(child.meta.agentPreset, 'standard', '人设/权限应继承父会话')
  assert.equal(child.meta.cwd, 'D:\\work', '工作目录应沿用父会话')
  assert.equal(child.meta.isSeeded, false, '会话头应写明 isSeeded=false（与官方新建会话同款）')
  assert.equal(child.meta.delegationDepth, 0, '不是子智能体，委托深度为 0')
  assert.deepEqual(child.events, [], '新会话不该有继承来的事件')
  assert.equal(firstBranch.promptDelivered, true, '首句提问应被投递')
  assert.equal(child.prompts.length, 1)
  assert.equal(child.prompts[0].mode, 'queue', '新会话应先排队而不是 steer')
  assert.equal(child.prompts[0].text, '这个函数的复杂度是多少？')
  // 缺陷 27 的回归：会话 id 必须是**真实 uuid 会话**，不是 `session-<n>` 计数器号。
  assert.match(
    firstBranch.sessionId,
    /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    `子会话 id 应是 session-<uuid>（真实会话），实际 ${firstBranch.sessionId}`,
  )
  // 走的是 Agent 工厂：父会话的 preset 必须在 setup 里真的 mount 过（工具集/权限来自它）。
  assert.ok(
    h1.fake.presets.mounted.includes('standard'),
    `人设没有被装配：${JSON.stringify(h1.fake.presets.mounted)}`,
  )
})

track('createBranch：新会话是可打开、会落盘的真实会话（在会话列表里）', async () => {
  // 缺陷 27 的核心断言：旧通道（ctx.sessions.create）建出的会话**不进列表**，
  // 于是树上节点永远匹配不到真实会话 → 真机看到"子会话变成新根"。
  assert.ok(
    h1.fake.persistedIds().includes(firstBranch.sessionId),
    `子会话不在会话列表里：${JSON.stringify(h1.fake.persistedIds())}`,
  )
})

track('createBranch：子会话被挂进父会话所在的工作区（缺陷 29，不再落到「未分组」）', async () => {
  // 官方工作区是**账本制**：只传 cwd 不会入账，必须显式 attachSession。
  assert.equal(
    firstBranch.workspaceAttached,
    true,
    `回包说没挂进工作区：${firstBranch.workspaceError ?? '(没有原因)'}`,
  )
  assert.equal(firstBranch.workspaceId, 'ws-work', '挂进了错误的工作区')
  const owner = h1.fake.workspaces.workspaceOf(firstBranch.sessionId)
  assert.ok(owner !== undefined, '子会话不在任何工作区的账本里（侧边栏会显示「未分组」）')
  assert.equal(owner.id, 'ws-work', '子会话挂到了别的工作区')
  assert.deepEqual(h1.fake.workspaces.rejected, [], '不该有被拒绝的 attach')
})

track('createBranch：树上出现父节点，新分支挂在该节点的 children 下', async () => {
  const view = await h1.service.viewOfSession(firstBranch.sessionId)
  assert.equal(view.document.root.sessionId, 's-parent', '树根应是父会话')
  const parentNode = view.document.nodes.find(
    (node) => node.sessionId === 's-parent' && node.turn === 2,
  )
  assert.ok(parentNode !== undefined, '树上没有「第 2 轮」的父节点')
  const childNodeId = parentNode.children[0]
  assert.ok(childNodeId !== undefined, '父节点没有子节点')
  const childNode = view.document.nodes.find((node) => node.id === childNodeId)
  assert.ok(childNode !== undefined, '子节点不在同一棵树里')
  assert.equal(childNode.sessionId, firstBranch.sessionId)
  assert.equal(childNode.anchorSeq, 7, '锚点应是父轮次 turn/end 的 seq')
  assert.equal(childNode.label, '这个函数的复杂度是多少？', '子节点标题应取首句提问')
  // 缺陷 27 的回归：挂载点必须是**点的那一轮**，不能是该会话的第一个节点。
  const firstTurn = view.document.nodes.find(
    (node) => node.sessionId === 's-parent' && node.turn === 1,
  )
  assert.deepEqual(firstTurn.children, [], '第 2 轮上建的分支不该挂到第 1 轮下面')
})

track('adoptSession：子会话与父会话共用同一棵树（不会再被当成新根）', async () => {
  // 缺陷 27 的第二个症状：打开刚建出来的子会话时，它必须是父会话那棵树里的一员。
  const childView = await h1.service.adoptSession(firstBranch.sessionId, never)
  const parentView = await h1.service.viewOfSession('s-parent')
  assert.equal(childView.treeId, parentView.treeId, '子会话应落在父会话同一棵树里')
  assert.equal(childView.document.root.sessionId, 's-parent', '树的根仍是父会话')
  assert.equal(childView.currentNodeId !== null, true, '子会话在树上应能定位到自己的节点')
  // 落盘上也只有这一棵树（不能凭空多出一棵以子会话为根的树）。
  const treeIds = (await h1.store.listTreeIds()).filter((id) => id !== '_index')
  assert.equal(treeIds.length, 1, `不该多出一棵树：${treeIds.join(', ')}`)
})

track('adoptSession：子会话跑完第一轮后认领占位节点（不重复长出一个框）', async () => {
  const before = await h1.service.viewOfSession(firstBranch.sessionId)
  const beforeCount = before.document.nodes.filter(
    (node) => node.sessionId === firstBranch.sessionId,
  ).length
  h1.fake.addTurn(firstBranch.sessionId)
  const after = await h1.service.adoptSession(firstBranch.sessionId, never)
  const childNodes = after.document.nodes.filter((node) => node.sessionId === firstBranch.sessionId)
  assert.equal(childNodes.length, beforeCount, '占位节点应被认领，而不是再加一个「第 1 轮」')
  assert.equal(childNodes[0].turn, 1, '占位节点应升级成第 1 轮')
  assert.equal(childNodes[0].label, '这个函数的复杂度是多少？', '首句提问当标题的节点不该被改成通用名')
})

track('createBranch：索引记住了树里的会话（索引丢了也能靠扫描重建）', async () => {
  const raw = await readFile(join(h1.root, '_index.json'), 'utf8')
  const index = JSON.parse(raw)
  const treeIds = new Set(Object.values(index.trees))
  assert.equal(treeIds.size, 1, `同一棵树里的会话应指向同一个 treeId：${JSON.stringify(index.trees)}`)
  assert.ok(Object.keys(index.trees).includes('s-parent'), '索引缺少父会话')
  assert.ok(Object.keys(index.trees).includes(firstBranch.sessionId), '索引缺少子会话')
})

// ---------------------------------------------------------------------------
// 2. 边界：不存在的父会话 / 非法的轮次 / 超长提问 / 服务缺失
// ---------------------------------------------------------------------------

track('createBranch：父会话不存在 → not-found', async () => {
  const error = await h1.service
    .createBranch({ parentSessionId: 's-nope', parentTurn: 1 }, never)
    .then(() => null, (cause) => cause)
  assert.equal(knownCode(error), 'not-found')
})

track('createBranch：轮次不是从 1 开始的整数 → invalid-request', async () => {
  const error = await h1.service
    .createBranch({ parentSessionId: 's-parent', parentTurn: 0 }, never)
    .then(() => null, (cause) => cause)
  assert.equal(knownCode(error), 'invalid-request')
})

track('createBranch：首句提问过长 → invalid-request', async () => {
  const error = await h1.service
    .createBranch({ parentSessionId: 's-parent', parentTurn: 1, prompt: 'x'.repeat(4001) }, never)
    .then(() => null, (cause) => cause)
  assert.equal(knownCode(error), 'invalid-request')
})

track('createBranch：缺少会话能力 → unsupported（而不是崩）', async () => {
  const bare = new BranchService({ store: h1.store, ctx: {}, log: () => {} })
  const error = await bare
    .createBranch({ parentSessionId: 's-parent', parentTurn: 1 }, never)
    .then(() => null, (cause) => cause)
  assert.equal(knownCode(error), 'unsupported')
})

// ---------------------------------------------------------------------------
// 3. 空提问 / 后续轮次 / 幂等
// ---------------------------------------------------------------------------

const h2 = await harness()
h2.fake.seedSession({ id: 's-two', turns: 1 })

track('createBranch：不给提问也能建（promptDelivered=false）', async () => {
  const result = await h2.service.createBranch({ parentSessionId: 's-two', parentTurn: 1 }, never)
  assert.equal(result.promptDelivered, false)
  const child = h2.fake.get(result.sessionId)
  assert.equal(child?.prompts.length, 0)
})

track('adoptSession：把已有轮次补成节点，且重复调用幂等', async () => {
  const first = await h2.service.adoptSession('s-two', never)
  const countAfterFirst = first.document.nodes.filter((node) => node.sessionId === 's-two').length
  assert.equal(countAfterFirst, 1, `第一轮应补成 1 个节点，实际 ${countAfterFirst}`)

  h2.fake.addTurn('s-two')
  const second = await h2.service.adoptSession('s-two', never)
  const countAfterSecond = second.document.nodes.filter((node) => node.sessionId === 's-two').length
  assert.equal(countAfterSecond, 2, `新增一轮后应补成 2 个节点，实际 ${countAfterSecond}`)

  const third = await h2.service.adoptSession('s-two', never)
  const countAfterThird = third.document.nodes.filter((node) => node.sessionId === 's-two').length
  assert.equal(countAfterThird, 2, '重复 adopt 不该重复加节点')
})

// ---------------------------------------------------------------------------
// 4. 孤儿：父会话被删 → 整棵子树升为独立树
// ---------------------------------------------------------------------------

const h3 = await harness()
h3.fake.seedSession({ id: 's-root', turns: 1 })
let branchA = null
let branchB = null

track('准备：同一节点下挂两个分支', async () => {
  branchA = await h3.service.createBranch({ parentSessionId: 's-root', parentTurn: 1, prompt: '分支 A' }, never)
  branchB = await h3.service.createBranch({ parentSessionId: 's-root', parentTurn: 1, prompt: '分支 B' }, never)
  const view = await h3.service.viewOfSession(branchA.sessionId)
  const rootNode = view.document.nodes.find((node) => node.sessionId === 's-root')
  assert.equal(rootNode?.children.length, 2, '同一节点下应能挂多个子对话')
})

track('splitOrphans：删掉父会话后，每个子对话各升为一棵独立树且树形不改写', async () => {
  h3.fake.delete('s-root')
  const { changed } = await h3.service.splitOrphans(undefined, never)
  assert.ok(changed.length >= 2, `应至少产生 2 棵新树，实际：${changed.join(', ')}`)

  const treeA = await h3.service.viewOfSession(branchA.sessionId)
  const treeB = await h3.service.viewOfSession(branchB.sessionId)
  assert.notEqual(treeA.treeId, treeB.treeId, '两个子对话应各自成为独立树的根')
  assert.equal(treeA.document.root.sessionId, branchA.sessionId)
  assert.equal(treeB.document.root.sessionId, branchB.sessionId)
  assert.equal(treeA.document.originTreeId, 't-s-root', '应记录来历（原树）')
  assert.equal(treeA.document.nodes.length, 1, '新树只含该子对话自己的节点（树形不改写）')
})

track('splitOrphans：原树里被删会话的节点标 orphan、子节点已摘除、文件引用清空', async () => {
  const oldTree = JSON.parse(await readFile(join(h3.root, 't-s-root.json'), 'utf8'))
  const orphan = oldTree.nodes.find((node) => node.sessionId === 's-root')
  assert.equal(orphan.orphan, true, '被删会话的节点应标记 orphan')
  assert.deepEqual(orphan.children, [], '升根后原节点不应再挂着已迁走的子节点')
  assert.equal(orphan.file, null, '被删节点上的文件引用应被清除')
})

track('子智能体会话不参与：origin=subagent 的会话不建树', async () => {
  const h4 = await harness()
  h4.fake.seedSession({ id: 's-human', turns: 1 })
  h4.fake.seedSession({ id: 's-sub', turns: 1, parentSession: 's-human', origin: 'subagent' })
  const error = await h4.service
    .viewOfSession('s-sub')
    .then(() => null, (cause) => cause)
  assert.equal(knownCode(error), 'not-found', '子智能体会话不该出现在任何一棵树里')
  await rm(h4.root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 5. 路由层：真 apply() + 假上下文，走 HTTP 语义
// ---------------------------------------------------------------------------

track('路由：/branch/create 走通，缺字段 400，未知路由 404，缺能力 501', async () => {
  const root = await mkdtemp(join(tmpdir(), 'branch-m1-route-'))
  const fake = createFakeSessions()
  fake.seedSession({ id: 's-route', turns: 1, agentPreset: 'standard' })

  let handler = null
  const disposers = []
  apply(
    {
      logger: { info: () => {}, warn: () => {} },
      webServer: { register: (input) => ((handler = input.handler), () => disposers.push('disposed')) },
      effect: (factory) => disposers.push(factory()),
      agents: fake.agents,
      sessions: fake.store,
      sessionController: fake.controller,
      agentPresets: fake.presets,
      agentDefaultModel: fake.defaultModel,
    },
    Config({ storageRoot: root, http: true }),
  )
  assert.ok(handler !== null, '没有注册路由')

  const okResponse = await handler(
    new Request('http://127.0.0.1:19387/branch/create', {
      method: 'POST',
      body: JSON.stringify({ parentSessionId: 's-route', parentTurn: 1, prompt: '路由建的分支' }),
    }),
  )
  assert.equal(okResponse.status, 200)
  const okBody = await okResponse.json()
  assert.equal(okBody.ok, true, `信封异常：${JSON.stringify(okBody)}`)
  assert.equal(okBody.value.promptDelivered, true)

  const missing = await handler(
    new Request('http://127.0.0.1:19387/branch/create', {
      method: 'POST',
      body: JSON.stringify({ parentTurn: 1 }),
    }),
  )
  assert.equal(missing.status, 400)
  assert.equal((await missing.json()).error.code, 'invalid-request')

  const notFound = await handler(new Request('http://127.0.0.1:19387/branch/whatever', { method: 'POST' }))
  assert.equal(notFound.status, 404)

  // 没有会话能力的部署：诊断仍然可用，建分支返回 501（unsupported）。
  const bareRoot = await mkdtemp(join(tmpdir(), 'branch-m1-bare-'))
  let bareHandler = null
  apply(
    {
      logger: {},
      webServer: { register: (input) => ((bareHandler = input.handler), () => {}) },
      effect: () => {},
    },
    Config({ storageRoot: bareRoot, http: true }),
  )
  const diagnostics = await bareHandler(
    new Request('http://127.0.0.1:19387/branch/diagnostics', { method: 'POST' }),
  )
  const diagnosticsBody = await diagnostics.json()
  assert.equal(diagnosticsBody.value.agents, false)
  assert.equal(diagnosticsBody.value.sessionController, false)
  assert.equal(diagnosticsBody.value.treeCount, 0)

  const unsupported = await bareHandler(
    new Request('http://127.0.0.1:19387/branch/create', {
      method: 'POST',
      body: JSON.stringify({ parentSessionId: 's-route', parentTurn: 1 }),
    }),
  )
  assert.equal(unsupported.status, 501)
  assert.equal((await unsupported.json()).error.code, 'unsupported')

  await rm(root, { recursive: true, force: true })
  await rm(bareRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 缺陷 29 的降级路径：父会话自己就不在任何工作区里 / 部署没有工作区注册表
// ---------------------------------------------------------------------------

const h9 = await harness()
h9.fake.seedSession({ id: 's-loose', turns: 1, cwd: 'D:\\loose' })

track('createBranch：父会话未分组时，建会话照常成功，回包说清"没挂上工作区"', async () => {
  const created = await h9.service.createBranch(
    { parentSessionId: 's-loose', parentTurn: 1 },
    never,
  )
  assert.equal(created.workspaceAttached, false, '父会话未分组时不该声称挂上了')
  assert.match(
    String(created.workspaceError),
    /工作区/u,
    `应给出可读原因，实际 ${String(created.workspaceError)}`,
  )
  assert.ok(h9.fake.get(created.sessionId) !== undefined, '会话本身仍应建出来（降级不拦路）')
  assert.equal(
    h9.fake.workspaces.workspaceOf(created.sessionId),
    undefined,
    '父会话不在工作区时，不该凭空造一个工作区',
  )
})

track('createBranch：部署没有 workspaceRegistry 时降级为"未挂上"，不抛错', async () => {
  const loose = createFakeSessions()
  loose.seedSession({ id: 's-nows', turns: 1, cwd: 'D:\\nows' })
  const service = new BranchService({
    store: h9.store,
    ctx: {
      agents: loose.agents,
      sessions: loose.store,
      sessionController: loose.controller,
      agentPresets: loose.presets,
      agentDefaultModel: loose.defaultModel,
      // 刻意不给 workspaceRegistry：老部署 / 精简部署就是这样
    },
    log: () => {},
  })
  const created = await service.createBranch({ parentSessionId: 's-nows', parentTurn: 1 }, never)
  assert.equal(created.workspaceAttached, false, '没有注册表时不该声称挂上了')
  assert.match(String(created.workspaceError), /工作区/u, '应给出可读原因')
})

// ---------------------------------------------------------------------------
// 串行执行
// ---------------------------------------------------------------------------

let failed = 0
for (const item of cases) {
  try {
    await item.fn()
    console.log(`  ✓ ${item.name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${item.name}\n      ${String(error?.message ?? error)}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`)

for (const holder of [h1, h2, h3, h9]) {
  await rm(holder.root, { recursive: true, force: true })
}
process.exitCode = failed === 0 ? 0 : 1
