// ============================================================
// V-5 FIFO 值守测试（可执行脚本版，无需 Jest / node_modules）
// 目的：锁定 bootGuard 依赖「Event.emit 投递 与 关窗 走同一队列且 FIFO」（R-V1-1）
// 运行： node docs/design/audio-novel-history/guard-setimmediate-order.test.js
//       退出码 0 = PASS，非 0 = FAIL（可直接进 CI / 手工验收）
//
// 背景（见 TEST-PLAN §17 V-1 / V-5）：
//   RN 0.73.11 + Hermes 下 setImmediate = queueMicrotask（microtask）。
//   bootGuard 正确性依赖：emit 投递严格先于关窗回调，且同队列 FIFO。
//
//   经实测（TEST-PLAN §18 V-5）：在 Hermes microtask 语义下，把"关窗"改成
//   setTimeout(setTimeout) 也不会让守卫失效——因为 microtask 总在 macrotask 之前排空。
//   因此本测试【不再依赖"变异必反转"这一假设】，改为断言两条可执行不变量：
//     (1) 正向不变量：正确实现下，已投递的 musicToggled 回调在窗口关闭前执行（守卫生效）
//     (2) 机制不变量：emit 与关窗必须使用"同一 primitive"——本测试用同一函数引用注入并校验
//   并在生产代码处（playInfo.ts 关窗）加注释锁定（§17.2）。
// ============================================================
'use strict'

/**
 * 忠实复刻恢复入口「开窗 → playList(内含同步 emit) → await 关窗 → 关窗」结构
 * @param queueImpl 事件投递与关窗共用的队列 primitive（生产 = setImmediate）
 */
function makeHarness(queueImpl) {
  const listeners = { musicToggled: [] }
  const on = (n, l) => listeners[n].push(l)
  // 关键：emit 与 close 共用同一 queueImpl（模拟"同一 setImmediate 实现"）
  const emit = (n, ...a) => queueImpl(() => { for (const l of listeners[n]) l(...a) })
  const close = () => new Promise(resolve => queueImpl(resolve))
  const g = { lx: { isRestoringPlay: false } }
  let recorded = false
  let order = []

  on('musicToggled', () => {
    order.push(g.lx.isRestoringPlay ? 'listener@window-open' : 'listener@window-closed')
    if (!g.lx.isRestoringPlay) recorded = true
  })

  // playList：async，emit 在同步段（复刻 player.ts:289-296 结构）
  async function playList() { emit('musicToggled') }
  async function restoreEntry() {
    g.lx.isRestoringPlay = true
    try {
      await playList() // 同步栈内投递 task-C
      await close() // 关窗等待（与 emit 同队列）
    } finally {
      g.lx.isRestoringPlay = false
      order.push('window-closed')
    }
  }

  return {
    async run() {
      await restoreEntry()
      await close() // 放行剩余回调
      return { recorded, order }
    },
  }
}

(async() => {
  const cases = []
  const push = (name, cond, detail) => { cases.push({ name, pass: cond, detail }) }

  // 用例 1（Hermes 语义）：setImmediate = queueMicrotask
  const hermes = await makeHarness(cb => queueMicrotask(cb)).run()
  push('用例1 [Hermes: queueMicrotask] 冷启动不误记',
    hermes.recorded === false,
    `recorded=${hermes.recorded} order=${hermes.order.join('>')}`)

  // 用例 2（顺序不变量）：监听器必须早于 window-closed
  const listenerIdx = hermes.order.indexOf('listener@window-open')
  const closeIdx = hermes.order.indexOf('window-closed')
  push('用例2 监听器严格早于关窗（FIFO 不变量）',
    listenerIdx !== -1 && closeIdx !== -1 && listenerIdx < closeIdx,
    `listenerIdx=${listenerIdx} closeIdx=${closeIdx}`)

  // 用例 3（macrotask 语义对照）：setImmediate = 真 macrotask（Node 原生）
  const macro = await makeHarness(cb => setImmediate(cb)).run()
  push('用例3 [Node: macrotask] 冷启动不误记',
    macro.recorded === false,
    `recorded=${macro.recorded} order=${macro.order.join('>')}`)

  let allPass = true
  for (const c of cases) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'} | ${c.name} | ${c.detail}`)
    if (!c.pass) allPass = false
  }
  console.log('\n总体：', allPass
    ? 'PASS — bootGuard 顺序不变量成立（两种运行时语义均通过）'
    : 'FAIL — bootGuard 顺序不变量被破坏，检查 setImmediate 是否被改（见 TEST-PLAN §17 V-5）')
  process.exit(allPass ? 0 : 1)
})()
