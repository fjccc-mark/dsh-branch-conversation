/**
 * 冒烟测试：不用真机 DSH，也能验证 host 半的对外契约。
 *
 * 覆盖：
 *   1. 插件被 `apply` 后确实注册了 `/branch` 前缀路由，并把 disposer 交给 ctx.effect；
 *   2. `/branch/diagnostics` 返回 `{ ok: true, value }` 信封，且字段齐全；
 *   3. 未知路由返回 404 与 not-found；
 *   4. `TreeStore`：缺失→null、读改写往返、原子发布无残留临时文件；
 *   5. `TreeStore`：每棵树一把锁（同树串行、异树并行）；
 *   6. `TreeStore`：损坏文档与更高 schema 的只读降级。
 *
 * 用法：node tools/smoke/branch-smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, TreeStore } from '../../lib/index.js'

const results = []
const track = (name, fn) =>
  results.push(
    Promise.resolve()
      .then(fn)
      .then(() => ({ name, ok: true }))
      .catch((error) => ({ name, ok: false, detail: String(error?.message ?? error) })),
  )

/** 构造一个最小可用的树文档（测试用）。 */
const makeDocument = (treeId, title) => ({
  schema: 1,
  treeId,
  originTreeId: null,
  root: { sessionId: `session-${treeId}`, cwd: 'D:\\x', createdAt: 1, title },
  nodes: [],
})

// 用 schema 解析出配置，保证测试走的是与生产同一条默认值路径。
const config = Config({
  storageRoot: await mkdtemp(join(tmpdir(), 'branch-conv-')),
  http: true,
})

let registered = null
const disposers = []
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  webServer: {
    register: (input) => {
      registered = input
      return () => disposers.push('disposed')
    },
  },
  effect: (factory) => {
    disposers.push(factory())
  },
}

track('apply 注册了 /branch 前缀路由', () => {
  apply(ctx, config)
  assert.ok(registered !== null, '没有注册任何路由')
  assert.equal(registered.kind, 'prefix')
  assert.equal(registered.path, 'branch')
})

track('apply 把路由 disposer 交给了 ctx.effect', () => {
  assert.equal(disposers.length, 1, '路由 disposer 没有交给 ctx.effect')
  assert.equal(typeof disposers[0], 'function')
})

track('/branch/diagnostics 返回 ok 信封与完整字段', async () => {
  const response = await registered.handler(
    new Request('http://127.0.0.1:19387/branch/diagnostics', { method: 'POST' }),
  )
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true, `信封异常：${JSON.stringify(body)}`)
  const value = body.value
  assert.equal(typeof value.sessions, 'boolean')
  assert.equal(typeof value.sessionController, 'boolean')
  assert.equal(typeof value.agentPresets, 'boolean')
  assert.equal(value.panelId, 'branch-conversation')
  assert.equal(value.storage.root, config.storageRoot)
  assert.equal(value.storage.exists, true, '存储根在探测前已建好，应为存在')
  assert.equal(value.storage.writable, true)
})

track('未知路由返回 404 与 not-found 错误码', async () => {
  const response = await registered.handler(
    new Request('http://127.0.0.1:19387/branch/nope', { method: 'POST' }),
  )
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'not-found')
})

const store = new TreeStore({ root: config.storageRoot })

track('树文档：缺失 → missing，写入后可读回', async () => {
  const missing = await store.read('t1')
  assert.equal(missing.kind, 'missing')

  const written = await store.update('t1', () => ({
    schema: 1,
    treeId: 't1',
    originTreeId: null,
    root: { sessionId: 'session-1', cwd: 'D:\\x', createdAt: 1, title: '主对话' },
    nodes: [
      {
        id: 'n-1',
        sessionId: 'session-1',
        turn: 1,
        anchorSeq: 3,
        kind: 'qa',
        label: '第一个问题',
        collapsed: false,
        orphan: false,
        children: [],
        file: null,
      },
    ],
  }))
  assert.equal(written.ok, true, `写入失败：${JSON.stringify(written)}`)

  const back = await store.read('t1')
  assert.equal(back.kind, 'read')
  assert.equal(back.document.nodes.length, 1)
  assert.equal(back.document.nodes[0].label, '第一个问题')
})

track('写入过程不留临时文件（原子发布）', async () => {
  const files = await readdir(config.storageRoot)
  const leftovers = files.filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [], `残留临时文件：${leftovers.join(', ')}`)
})

track('每棵树一把锁：同树两次并发写串行，后者看到前者的结果', async () => {
  const seen = []
  const slow = store.update('t-lock', async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
    return makeDocument('t-lock', '第一次写的值')
  })
  const fast = store.update('t-lock', (current) => {
    seen.push(current === null ? '<null>' : current.root.title)
    return makeDocument('t-lock', '第二次写的值')
  })
  const [slowResult, fastResult] = await Promise.all([slow, fast])
  assert.equal(slowResult.ok, true, `第一次写失败：${JSON.stringify(slowResult)}`)
  assert.equal(fastResult.ok, true, `第二次写失败：${JSON.stringify(fastResult)}`)
  assert.deepEqual(seen, ['第一次写的值'], `第二次写读到的旧状态：${seen.join(', ')}`)
  const back = await store.read('t-lock')
  assert.equal(back.kind, 'read')
  assert.equal(back.document.root.title, '第二次写的值')
})

track('不同树之间可并行（慢的写不阻塞另一棵树）', async () => {
  let slowFinished = false
  const a = store.update('t-a', async () => {
    await new Promise((resolve) => setTimeout(resolve, 80))
    slowFinished = true
    return makeDocument('t-a', '慢树')
  })
  // 若两棵树共用一把锁，这次写入必须等 a 完成；分开上锁则应立刻落地。
  await store.update('t-b', () => makeDocument('t-b', '另一棵树'))
  assert.equal(slowFinished, false, 't-b 被 t-a 的写阻塞了 → 锁的粒度不是每棵树')
  await a
})

track('update 允许 async mutate：不会把 Promise 当文档写入', async () => {
  const written = await store.update('t-async', async () => makeDocument('t-async', '异步产出的树'))
  assert.equal(written.ok, true, `写入失败：${JSON.stringify(written)}`)
  const back = await store.read('t-async')
  assert.equal(back.kind, 'read')
  assert.equal(back.document.root.title, '异步产出的树')
})

track('update 拒绝非法文档（mutate 返回坏对象时不落盘）', async () => {
  const seed = await store.update('t-valid', () => makeDocument('t-valid', '合法文档'))
  assert.equal(seed.ok, true, `准备失败：${JSON.stringify(seed)}`)
  const before = await store.read('t-valid')
  assert.equal(before.kind, 'read')
  const beforeText = JSON.stringify(before.document)
  const written = await store.update('t-valid', () => ({ nope: true }))
  assert.equal(written.ok, false)
  assert.equal(written.error.kind, 'io')
  const after = await store.read('t-valid')
  assert.equal(after.kind, 'read')
  assert.equal(JSON.stringify(after.document), beforeText, '非法写入改动了磁盘上的旧文档')
})

track('损坏文档：报告 unreadable，且拒绝在其上写入', async () => {
  await writeFile(join(config.storageRoot, 'broken.json'), '{ 这不是 JSON', 'utf8')
  const read = await store.read('broken')
  assert.equal(read.kind, 'unreadable')
  const write = await store.update('broken', () => null)
  assert.equal(write.ok, false)
  assert.equal(write.error.kind, 'io')
})

track('更高 schema：拒绝改写（只读降级）', async () => {
  await writeFile(
    join(config.storageRoot, 'future.json'),
    JSON.stringify({
      schema: 99,
      treeId: 'future',
      originTreeId: null,
      root: { sessionId: 's', cwd: null, createdAt: 0, title: '' },
      nodes: [],
    }),
    'utf8',
  )
  const write = await store.update('future', () => null)
  assert.equal(write.ok, false)
  assert.equal(write.error.kind, 'newer-schema')
  assert.equal(write.error.found, 99)
})

const settled = await Promise.all(results)
let failed = 0
for (const row of settled) {
  if (row.ok) {
    console.log(`  ✓ ${row.name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${row.name}\n      ${row.detail}`)
  }
}
console.log(`\n${settled.length - failed}/${settled.length} 通过`)

await rm(config.storageRoot, { recursive: true, force: true })
process.exitCode = failed === 0 ? 0 : 1
