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
// 4.5 DSH 原生分支（官方 fork）：继承上下文 + 父会话工作区
// ---------------------------------------------------------------------------

const hn = await harness()
hn.fake.seedSession({ id: 's-native', turns: 2, cwd: 'D:\\native', agentPreset: 'standard' })
hn.fake.workspaces.seedWorkspace({
  id: 'ws-native',
  path: 'D:\\native',
  sessionIds: ['s-native'],
})
let nativeParentView = null
let nativeTurn1 = null
let nativeTurn2 = null
let nativeTurn3 = null
let nativeBranch = null

track('准备：原生分支的父会话有 3 轮，树上有第 1~3 轮节点', async () => {
  nativeParentView = await hn.service.adoptSession('s-native', never)
  hn.fake.addTurn('s-native')
  nativeParentView = await hn.service.adoptSession('s-native', never)
  nativeTurn1 = nativeParentView.document.nodes.find(
    (node) => node.sessionId === 's-native' && node.turn === 1,
  )
  nativeTurn2 = nativeParentView.document.nodes.find(
    (node) => node.sessionId === 's-native' && node.turn === 2,
  )
  nativeTurn3 = nativeParentView.document.nodes.find(
    (node) => node.sessionId === 's-native' && node.turn === 3,
  )
  assert.ok(nativeTurn1 && nativeTurn2 && nativeTurn3, '三只父轮次节点都应存在')
})

track('forkBranch：原生分支继承上下文（isSeeded / 前缀事件 / 同 cwd + preset）', async () => {
  nativeBranch = await hn.service.forkBranch(
    { parentNodeId: nativeTurn2.id, prompt: '带着上文继续问' },
    never,
  )
  assert.equal(nativeBranch.nativeBranch, true, '回包应标明这是原生分支')
  assert.equal(nativeBranch.contextInherited, true, '回包应标明继承了上下文')
  assert.equal(nativeBranch.forkAtSeq, nativeTurn2.anchorSeq, 'fork 切点应是第 2 轮 turn/end 的 seq')
  assert.equal(nativeBranch.promptDelivered, true, '首句提问应投递进新会话')

  const child = hn.fake.get(nativeBranch.sessionId)
  assert.ok(child !== undefined, '没有创建出原生分支会话')
  assert.equal(child.meta.isSeeded, true, '原生分支必须是 seeded 会话')
  assert.equal(child.meta.parentSession, 's-native', '血缘应指向父会话')
  assert.equal(child.meta.cwd, 'D:\\native', 'cwd 应继承父会话')
  assert.equal(child.meta.agentPreset, 'standard', '人设应继承父会话')
  assert.equal(
    child.meta.seedLength,
    nativeTurn2.anchorSeq + 1,
    'seedLength 应是"截止切点（含）"的事件条数',
  )
  // 上游 3 轮里只应复制到第 2 轮（含）：第 3 轮是 fork 之后才有的，不属于这份上下文。
  const inheritedTurnStarts = child.events
    .filter((event) => event.seq <= nativeTurn2.anchorSeq && event.type === 'turn/start')
    .length
  assert.equal(inheritedTurnStarts, 2, '继承前缀里应只有第 1、2 轮，不能把第 3 轮也带进来')
  assert.equal(child.prompts.length, 1)
  assert.equal(child.prompts[0].mode, 'queue', '首句提问应先排队，不抢正在跑的轮次')
  assert.equal(child.prompts[0].text, '带着上文继续问')
})

track('forkBranch：原生分支由官方 fork 挂进父会话的工作区', async () => {
  assert.equal(
    nativeBranch.workspaceAttached,
    true,
    `回包说没挂进工作区：${nativeBranch.workspaceError ?? '(没有原因)'}`,
  )
  assert.equal(nativeBranch.workspaceId, 'ws-native', '挂进了错误的工作区')
  const owner = hn.fake.workspaces.workspaceOf(nativeBranch.sessionId)
  assert.equal(owner?.id, 'ws-native', '原生分支不在父会话的工作区账本里')
})

track('forkBranch：挂到被点的那一轮（不是最新一轮），仍在父会话同一棵树里', async () => {
  const view = await hn.service.viewOfSession('s-native')
  const turn2 = view.document.nodes.find((node) => node.id === nativeTurn2.id)
  const turn3 = view.document.nodes.find((node) => node.id === nativeTurn3.id)
  assert.ok(turn2.children.includes(nativeBranch.nodeId), '第 2 轮下应出现这条原生分支')
  assert.deepEqual(turn3.children, [], '不能因为第 3 轮更新就挂到第 3 轮下面')
  assert.equal(view.document.root.sessionId, 's-native', '树的根仍是父会话')
  const childNode = view.document.nodes.find((node) => node.id === nativeBranch.nodeId)
  assert.equal(childNode.label, '带着上文继续问', '节点标题应取首句提问')
  assert.equal(childNode.turn, null, '还没跑自有轮次时是占位节点')
  const treeIds = (await hn.store.listTreeIds()).filter((id) => id !== '_index')
  assert.equal(treeIds.length, 1, `原生分支不该另起一棵树：${treeIds.join(', ')}`)
})

track('adoptSession：打开原生分支时，不把父对话历史复制成它自己的节点', async () => {
  const view = await hn.service.adoptSession(nativeBranch.sessionId, never)
  assert.equal(view.document.root.sessionId, 's-native', '原生分支仍属于父会话那棵树')
  const childNodes = view.document.nodes.filter(
    (node) => node.sessionId === nativeBranch.sessionId,
  )
  assert.equal(childNodes.length, 1, `应只有 1 个占位节点，实际 ${childNodes.length} 个`)
  assert.equal(childNodes[0].turn, null, '还没跑自有轮次，节点仍是占位')
  assert.equal(view.currentNodeId, nativeBranch.nodeId, '当前节点应能定位到这条分支')
})

track('adoptSession：原生分支跑完第一轮后认领占位节点，且只多出一个轮次节点', async () => {
  hn.fake.addTurn(nativeBranch.sessionId)
  const view = await hn.service.adoptSession(nativeBranch.sessionId, never)
  const childNodes = view.document.nodes.filter(
    (node) => node.sessionId === nativeBranch.sessionId,
  )
  assert.equal(childNodes.length, 1, '占位节点应被认领，不能把父对话轮次再铺一遍')
  // 继承前缀里有几轮，自有轮次就从它的下一号继续（官方 seeded 会话的编号语义）。
  const child = hn.fake.get(nativeBranch.sessionId)
  const inheritedTurns = child.events.filter(
    (event) => event.seq <= nativeBranch.forkAtSeq && event.type === 'turn/start',
  ).length
  assert.equal(
    childNodes[0].turn,
    inheritedTurns + 1,
    `自有轮次号应接在继承轮次之后，实际 ${childNodes[0].turn}`,
  )
  assert.equal(childNodes[0].label, '带着上文继续问', '首句提问当标题的节点不该被改成通用名')
})

track('adoptSession：官方 UI 建的原生分支（插件没参与）打开后挂回父树', async () => {
  // 模拟用户在官方聊天里点「在新对话中分支」：直接走官方 fork，插件完全不知情。
  const external = await hn.fake.controller.fork({
    sessionId: 's-native',
    atSeq: nativeTurn3.anchorSeq,
  })
  const view = await hn.service.adoptSession(external.sessionId, never)
  assert.equal(view.document.root.sessionId, 's-native', '打开后不能变成一棵以它自己为根的新树')
  const turn3 = view.document.nodes.find((node) => node.id === nativeTurn3.id)
  const childNode = view.document.nodes.find(
    (node) => node.sessionId === external.sessionId,
  )
  assert.ok(childNode !== undefined, '原生分支应被挂进父树')
  assert.ok(turn3.children.includes(childNode.id), '应挂在被 fork 的第 3 轮下面')
  const treeIds = (await hn.store.listTreeIds()).filter((id) => id !== '_index')
  assert.equal(treeIds.length, 1, `不该多出一棵以子会话为根的树：${treeIds.join(', ')}`)
})

track('adoptSession：打开父会话时能发现尚未打开过的原生分支', async () => {
  const external = await hn.fake.controller.fork({
    sessionId: 's-native',
    atSeq: nativeTurn1.anchorSeq,
  })
  const view = await hn.service.adoptSession('s-native', never)
  const turn1 = view.document.nodes.find((node) => node.id === nativeTurn1.id)
  const childNode = view.document.nodes.find((node) => node.sessionId === external.sessionId)
  assert.ok(childNode !== undefined, '父会话 adopt 时应发现这条尚未打开过的原生分支')
  assert.ok(turn1.children.includes(childNode.id), '应挂在第 1 轮下面')
})

track('forkBranch：缺少官方 fork 能力 → unsupported（不静默退回不继承上文的通道）', async () => {
  const withoutFork = {
    list: async () => ({ items: [] }),
    inspect: async () => null,
  }
  const bare = new BranchService({
    store: hn.store,
    ctx: { sessionController: withoutFork },
    log: () => {},
  })
  const error = await bare
    .forkBranch({ parentNodeId: nativeTurn1.id }, never)
    .then(() => null, (cause) => cause)
  assert.equal(knownCode(error), 'unsupported')
})

track('forkBranch：节点不存在 / 文件节点 / 未完成轮次 → 可读错误', async () => {
  const missing = await hn.service
    .forkBranch({ parentNodeId: 'nope' }, never)
    .then(() => null, (cause) => cause)
  assert.equal(knownCode(missing), 'not-found')

  const fileNode = await hn.service.attachFileNode({
    parentNodeId: nativeTurn1.id,
    path: join(hn.root, 'not-a-real-file.txt'),
  })
  const onFile = await hn.service
    .forkBranch({ parentNodeId: fileNode.nodeId }, never)
    .then(() => null, (cause) => cause)
  assert.equal(knownCode(onFile), 'invalid-request', '文件节点上不该能开分支')

  const placeholder = await hn.service.createBranch(
    { parentSessionId: 's-native', parentTurn: 1, prompt: '不继承上文的子会话' },
    never,
  )
  const onPlaceholder = await hn.service
    .forkBranch({ parentNodeId: placeholder.nodeId }, never)
    .then(() => null, (cause) => cause)
  assert.equal(knownCode(onPlaceholder), 'invalid-request', '没有 turn/end 锚点时不能 fork')
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

  // 原生分支路由：先 adopt 拿到节点 id，再 POST /branch/fork。
  const adopted = await handler(
    new Request('http://127.0.0.1:19387/branch/adopt', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's-route' }),
    }),
  )
  const adoptedBody = await adopted.json()
  const routeNodeId = adoptedBody.value.document.nodes.find(
    (node) => node.sessionId === 's-route' && node.kind === 'qa',
  )?.id
  assert.ok(typeof routeNodeId === 'string', 'adopt 后应能找到父轮次节点')
  const forkResponse = await handler(
    new Request('http://127.0.0.1:19387/branch/fork', {
      method: 'POST',
      body: JSON.stringify({ parentNodeId: routeNodeId, prompt: '路由建的原生分支' }),
    }),
  )
  assert.equal(forkResponse.status, 200)
  const forkBody = await forkResponse.json()
  assert.equal(forkBody.ok, true, `原生分支信封异常：${JSON.stringify(forkBody)}`)
  assert.equal(forkBody.value.nativeBranch, true)
  assert.equal(forkBody.value.contextInherited, true)

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

for (const holder of [h1, h2, h3, hn, h9]) {
  await rm(holder.root, { recursive: true, force: true })
}
process.exitCode = failed === 0 ? 0 : 1
