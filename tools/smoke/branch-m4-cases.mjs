/**
 * M4 冒烟：失败恢复四场景 + 文件节点 + 导出路由。
 *
 * 四个场景（设计文档 §5「失败面」）：
 *   1. 会话被删 → 树里出现孤儿节点，`split-orphans` 能把子树升为独立树；
 *   2. 文件被移动 → 文件节点体检把 `missing` 回写，Ui 可显示"文件不存在"；
 *   3. 树文档损坏 → 读/写都报可读错误，不静默丢数据；
 *   4. 权限/路径不可用 → 用不可能存在的盘符做只读降级验证。
 *
 * 另覆盖：`/branch/export` 路由（三种格式 + 非法格式 400 + 不存在会话 404）。
 *
 * 用法：node tools/smoke/branch-m4-cases.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BranchFailure, BranchService, Config, TreeStore, apply } from '../../lib/index.js'
import { createFakeSessions } from '../../lib/testing/fake-sessions.js'

const cases = []
const track = (name, fn) => cases.push({ name, fn })
const never = new AbortController().signal
const knownCode = (error) => (error instanceof BranchFailure ? error.code : `不是 BranchFailure：${error}`)

/** 造一套「插件上下文 + 假会话面 + 真服务 + 真路由」。 */
async function harness(options = {}) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), 'branch-m4-')))
  const fake = createFakeSessions()
  const store = new TreeStore({ root })
  const ctx = { sessions: fake.store, sessionController: fake.controller }
  const service = new BranchService({ store, ctx, log: () => {} })
  let handler = null
  apply(
    {
      logger: { info: () => {}, warn: () => {} },
      webServer: { register: (input) => ((handler = input.handler), () => {}) },
      effect: () => {},
      sessions: fake.store,
      sessionController: fake.controller,
    },
    Config({ storageRoot: root, http: true }),
  )
  return { root, fake, store, service, call: (path, body) => callRoute(handler, path, body), handler }
}

/** 以 Node 的 (req, res) 形态调用路由（与真机一致）。 */
async function callRoute(handler, path, body, options = {}) {
  const url = new URL(`http://127.0.0.1/${path}`)
  const text = body === undefined ? '' : JSON.stringify(body)
  const request = {
    method: options.method ?? (body === undefined ? 'GET' : 'POST'),
    url: `${url.pathname}${url.search}`,
    headers: { 'content-type': 'application/json' },
    on(event, listener) {
      if (event === 'data' && text !== '') listener({ toString: () => text })
      if (event === 'end') listener()
    },
  }
  let status = 0
  let headers = {}
  let payload = ''
  const response = {
    writeHead(code, nextHeaders) {
      status = code
      headers = nextHeaders ?? {}
    },
    end(value) {
      payload = value ?? ''
    },
  }
  await handler(request, response)
  let parsed = null
  try {
    parsed = JSON.parse(payload)
  } catch {
    parsed = null
  }
  return { status, headers, text: payload, body: parsed }
}

// ---------------------------------------------------------------------------
// 场景 1：会话被删 → 孤儿 → 拆分升根
// ---------------------------------------------------------------------------

const h1 = await harness()
h1.fake.seedSession({ id: 's-root', turns: 1 })
let child = null

track('准备：父会话下建一个子分支', async () => {
  child = await h1.service.createBranch({ parentSessionId: 's-root', parentTurn: 1, prompt: '子问题' }, never)
  assert.ok(child.sessionId.startsWith('session-fake-'), '应建出新会话')
})

track('场景1：删父会话后，树里出现孤儿节点（view 仍可读）', async () => {
  h1.fake.delete('s-root')
  const view = await h1.service.viewOfSession(child.sessionId)
  const orphan = view.document.nodes.find((node) => node.sessionId === 's-root')
  assert.equal(orphan?.orphan, false, '此时还没体检，标记仍为 false（体检才写回）')
  // split-orphans 会同时标记孤儿并拆分
  const result = await h1.service.splitOrphans(undefined, never)
  assert.ok(result.changed.includes('t-s-root'), `应改动原树：${result.changed.join(', ')}`)
})

track('场景1：子对话升为独立树的根，原节点标孤儿且文件引用清空', async () => {
  const view = await h1.service.viewOfSession(child.sessionId)
  assert.equal(view.document.root.sessionId, child.sessionId)
  assert.equal(view.document.originTreeId, 't-s-root')

  const raw = JSON.parse(await readFile(join(h1.root, 't-s-root.json'), 'utf8'))
  const orphan = raw.nodes.find((node) => node.sessionId === 's-root')
  assert.equal(orphan.orphan, true)
  assert.deepEqual(orphan.children, [])
  assert.equal(orphan.file, null)
})

// ---------------------------------------------------------------------------
// 场景 2：文件节点体检（文件存在 → 移动后标记 missing）
// ---------------------------------------------------------------------------

const h2 = await harness()
h2.fake.seedSession({ id: 's-file', turns: 1 })
const filePath = join(h2.root, '参考文档.md')
await writeFile(filePath, '内容', 'utf8')
let fileNodeId = null

track('文件节点：挂载时记录路径，文件存在时 missing=false', async () => {
  const view = await h2.service.adoptSession('s-file', never)
  const parentNodeId = view.document.nodes.find((node) => node.sessionId === 's-file')?.id
  assert.ok(parentNodeId !== undefined, '应能取到父节点 id')
  const attached = await h2.service.attachFileNode({ parentNodeId, path: filePath })
  fileNodeId = attached.nodeId
  const after = await h2.service.viewOfSession('s-file')
  const node = after.document.nodes.find((row) => row.id === fileNodeId)
  assert.equal(node?.kind, 'file')
  assert.equal(node?.file?.path, filePath)
  assert.equal(node?.file?.missing, false, '文件存在时不该标缺失')
  assert.equal(node?.label, '参考文档.md', '标题取路径最后一段')
})

track('场景2：文件被移走后，体检把 missing 回写为 true', async () => {
  await rename(filePath, join(h2.root, '被移动的文档.md'))
  const first = await h2.service.auditFileNodes(undefined, never)
  assert.ok(first.changed.includes('t-s-file'), `应体检出变化：${first.changed.join(', ')}`)
  const view = await h2.service.viewOfSession('s-file')
  const node = view.document.nodes.find((row) => row.id === fileNodeId)
  assert.equal(node?.file?.missing, true)
})

track('场景2：体检幂等（状态没变就不再写盘）', async () => {
  const again = await h2.service.auditFileNodes(undefined, never)
  assert.deepEqual(again.changed, [], '状态未变时不应再写')
})

track('场景2：打开缺失文件时给出可读失败（不静默）', async () => {
  const error = await h2.service.openFileNode(fileNodeId, never).then(() => null, (cause) => cause)
  assert.equal(knownCode(error), 'unsupported', '假会话面没有 openWorkspacePath → 应报 unsupported')
})

track('场景2：对非文件节点调 openFileNode → invalid-request', async () => {
  const view = await h2.service.viewOfSession('s-file')
  const qaNode = view.document.nodes.find((node) => node.kind === 'qa')
  const error = await h2.service.openFileNode(qaNode.id, never).then(() => null, (cause) => cause)
  assert.equal(knownCode(error), 'invalid-request')
})

// ---------------------------------------------------------------------------
// 场景 3：树文档损坏
// ---------------------------------------------------------------------------

const h3 = await harness()
h3.fake.seedSession({ id: 's-broken', turns: 1 })
await h3.service.adoptSession('s-broken', never)

track('场景3：树文档被写坏后，读树报 corrupt-document（可读错误）', async () => {
  await writeFile(join(h3.root, 't-s-broken.json'), '{ 这不是 JSON', 'utf8')
  const error = await h3.service.viewOfSession('s-broken').then(() => null, (cause) => cause)
  assert.equal(knownCode(error), 'corrupt-document', `应报损坏：${error?.message}`)
})

track('场景3：损坏时写入也被拒绝（不覆盖坏文件）', async () => {
  const before = await readFile(join(h3.root, 't-s-broken.json'), 'utf8')
  const write = await h3.store.update('t-s-broken', () => null)
  assert.equal(write.ok, false)
  assert.equal(write.error.kind, 'io')
  const after = await readFile(join(h3.root, 't-s-broken.json'), 'utf8')
  assert.equal(after, before, '坏文件内容应逐字未变')
})

// ---------------------------------------------------------------------------
// 场景 4：权限 / 路径不可用 → 只读降级
// ---------------------------------------------------------------------------

track('场景4：存储根不可用（不存在的盘符）时，写操作报可读 io 错误而不崩', async () => {
  const badRoot = 'Q:\\definitely-not-a-drive\\branch-conversation'
  const store = new TreeStore({ root: badRoot })
  const probe = await store.probeRoot()
  assert.equal(probe.exists, false, '不存在的盘符应报告 exists=false')
  const write = await store.update('t1', () => ({
    schema: 1,
    treeId: 't1',
    originTreeId: null,
    root: { sessionId: 's', cwd: null, createdAt: 1, title: '' },
    nodes: [],
  }))
  assert.equal(write.ok, false, '写入应失败')
  assert.equal(write.error.kind, 'io', '失败原因应是可读的 io')
  assert.ok(String(write.error.reason).length > 0, '应带可读原因')
})

// ---------------------------------------------------------------------------
// 导出路由
// ---------------------------------------------------------------------------

const h4 = await harness()
h4.fake.seedSession({ id: 's-export', turns: 2, cwd: 'D:\\work' })

track('准备：把导出用的会话接进树（两个轮次节点）', async () => {
  const view = await h4.service.adoptSession('s-export', never)
  assert.equal(view.document.nodes.filter((node) => node.sessionId === 's-export').length, 2)
})

track('路由：三种导出都返回内容与文件名', async () => {
  for (const format of ['json', 'markdown', 'mermaid']) {
    const response = await h4.call('branch/export', { sessionId: 's-export', format })
    assert.equal(response.status, 200, `${format} 应 200`)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.value.format, format)
    assert.ok(response.body.value.fileName.endsWith(format === 'markdown' ? '.md' : format === 'json' ? '.json' : '.mmd'))
    assert.ok(response.body.value.content.length > 0, `${format} 内容不应为空`)
  }
  const json = await h4.call('branch/export', { sessionId: 's-export', format: 'json' })
  const parsed = JSON.parse(json.body.value.content)
  assert.equal(parsed.nodes.filter((node) => node.sessionId === 's-export').length, 2, '导出应含两个轮次节点')
})

track('路由：非法格式 400、不存在的会话 404', async () => {
  const badFormat = await h4.call('branch/export', { sessionId: 's-export', format: 'dot' })
  assert.equal(badFormat.status, 400)
  assert.equal(badFormat.body.error.code, 'invalid-request')

  const noSession = await h4.call('branch/export', { sessionId: 's-nope', format: 'json' })
  assert.equal(noSession.status, 404)
  assert.equal(noSession.body.error.code, 'not-found')
})

track('路由：GET 下载（content-disposition + 正确 content-type）', async () => {
  const response = await callRoute(h4.handler, 'branch/export?sessionId=s-export&format=markdown', undefined, {
    method: 'GET',
  })
  assert.equal(response.status, 200)
  assert.ok(
    String(response.headers['content-type'] ?? '').startsWith('text/markdown'),
    `content-type 不对：${response.headers['content-type']}`,
  )
  assert.ok(
    String(response.headers['content-disposition'] ?? '').includes('attachment'),
    '应带 attachment 以便浏览器下载',
  )
  assert.ok(response.text.startsWith('# 分支对话树'), '下载内容应是 Markdown')

  const bad = await callRoute(h4.handler, 'branch/export?format=json', undefined, { method: 'GET' })
  assert.equal(bad.status, 400, 'GET 缺 sessionId 应 400')
})

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

for (const root of [h1.root, h2.root, h3.root, h4.root]) {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
process.exitCode = failed === 0 ? 0 : 1
