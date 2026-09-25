# Spec — 有声小说播放历史 v1.0

> 生成日期：2026-09-25
> 基于：PRD（Phase 0 需求澄清）+ `ARCHITECTURE.md` v5（1304 行）+ `UIUX.md` v1.1（549 行）+ `TEST-PLAN.md` v4（671 行）
> 状态：**待用户确认**
> 项目：洛雪音乐助手移动版（React Native 0.73.11 + TypeScript，仅 Android）
> **规格即契约**：本文件一经确认即锁定，开发阶段以此为唯一依据。

---

## 1. 产品定义

- **一句话描述**：为歌单模块增加有声小说播放历史，自动记录「作品 + 集数 + 进度 + 时间」，支持断点续播。
- **目标用户**：使用洛雪音乐助手听有声小说的 Android 用户。
- **核心问题**：有声小说单集时长长（20-60 分钟），用户中断后无法记住听到哪一集、哪一位置，需要手动回忆与拖拽进度。

**目标场景**：用户听有声小说（如《三体》广播剧）第 37 集到 18:30 时退出 App，次日打开能够一键回到该集该位置继续收听。

---

## 2. MVP 范围（锁定——不在此列表的功能一律不做）

| 优先级 | 功能 | 验收标准摘要 |
|--------|------|-------------|
| P0 | 自动记录播放历史 | 播放有声小说时记录作品、集数、进度秒数、最近播放时间 |
| P0 | 断点续播 | 从历史进入时跳到对应集并恢复到记录位置 |
| P0 | 同作品去重更新 | 同一歌单重复播放**更新**已有记录，不新增；列表按最近播放时间倒序 |
| P0 | 删除单条 | 三点菜单删除单条历史 |
| P0 | 清空全部 | 二次确认后清空全部历史 |
| P0 | 500 条上限淘汰 | 超出 500 条自动淘汰最旧记录 |
| P0 | 本地持久化 | App 重启后可恢复 |
| P0 | 写入不阻塞播放 | 使用后台节流器 + 屏幕门控 |
| P1 | 有声小说开关 | 歌单三点菜单可标记/取消标记为有声小说 |
| P1 | 失效记录标记 | 歌单被删后历史条目标记失效并提供清理入口 |

---

## 3. 明确不做（Out-of-Scope — 锁定）

| 不做的功能 | 原因 | 何时考虑 |
|------------|------|----------|
| 云同步历史记录 | 用户明确要求「仅本地 App 重启可恢复」 | 用户提出多端需求时 |
| 新增顶层导航项 | `Main.tsx:181-193` `viewMap` 硬编码 5 项，新增破坏 PagerView 映射 | 重构导航层时 |
| 「今天/昨天」式时间措辞 | 项目 `dateFormat2` 无此档位，超 24h 显示绝对日期 | 用户提出时 |
| 历史记录一键导出/导入 | MVP 无此需求 | v2 |
| 空态专属图标（书本/耳机） | 图标集无此语义，新增需补 IcoMoon 字体资源 | 视觉验收提出时 |
| 未标记歌单的记录历史 | 仅记录已标记为「有声小说」的歌单 | 用户要求全量记录时 |

---

## 4. 技术架构（锁定 — 含版本锚定）

| 层 | 技术 | 版本/现状 | 锁定原因 |
|----|------|----------|----------|
| 框架 | React Native | 0.73.11（已装） | 现有项目 |
| 引擎 | Hermes | `hermesEnabled=true`（`android/gradle.properties:41`） | **影响 `setImmediate` 语义（实为 queueMicrotask）** |
| 语言 | TypeScript | 5.9.3（已装） | 现有项目 |
| 状态管理 | 项目自研（裸对象 state + 事件广播） | 现状 | **非标准 Redux**，必须跟随 |
| 存储 | AsyncStorage（经 `@/plugins/storage` 封装） | 现状，自带 500KB 分片 | 复用现有持久化层 |
| 事件系统 | `src/event/Event.ts` | 现状，**`emit` 用 `setImmediate`（实为 microtask）异步派发** | 已在此发现 3 个 P0 |
| 图标 | IcoMoon 自绘字体（`src/resources/fonts/selection.json`，52 图标） | 现状，**唯一一套** | 禁止引入第二套 |
| 部署 | 不适用（本地功能，随 App 发版） | — | — |

**锁定约束**：
- **禁止**硬编码颜色，一律 `theme['c-xxx']`
- **禁止** emoji 作功能图标
- **禁止**引入新依赖（本次零新增依赖）

---

## 5. 数据结构（锁定）

### 5.1 历史记录（`src/types/player.d.ts` 新增）

```ts
interface AudioNovelHistoryItem {
  listId: string        // 作品主键（歌单 id，创建后稳定）
  musicId: string       // 集数定位键（musicInfo.id，稳定）
  name: string          // 集标题（musicInfo.name）
  singer: string        // 主播/作者（musicInfo.singer）
  albumName: string     // 作品名（meta.albumName）
  picUrl: string | null // 封面（可选裁剪）
  progress: number      // 进度秒数（原始时间点，前端格式化）
  maxTime: number       // 该集总时长（秒）
  updateTime: number    // 最近播放时间戳（ms）
}
```

**关键决策**：
- **主键 = `listId`**：一条 `listId` 对应一条历史；集数变化时更新同一条记录
- **集数定位 = `musicId`**：严禁用 `playIndex`（歌单增删排序后会错位）
- **进度存原始秒数**：前端换算显示（兼容时间点/百分比两种展示）
- **体积约束**：单条 < 2KB，严禁存 lrc 等大字段（500 条实测约 187KB）

### 5.2 歌单标记（`src/types/list.d.ts` 改）

```ts
interface UserListInfo {
  id: string
  name: string
  source?: LX.OnlineSource
  sourceListId?: string
  locationUpdateTime: number | null
  isAudioNovel?: boolean   // ← 新增：有声小说开关（可选，默认 false）
}
```
**读取约定**：一律 `!!list.isAudioNovel` 真值判断（老数据 undefined → false）。

### 5.3 全局守卫位（`src/types/app.d.ts` 改）

```ts
global.lx.isRestoringPlay: boolean   // ← 新增：启动恢复窗口标记
```

---

## 6. 存储方案（锁定）

| 项 | 结论 |
|---|---|
| 存储键 | `@audio_novel_history`（在 `src/config/constant.ts` 的 `storageDataPrefix` 登记） |
| 形态 | 单键存 `AudioNovelHistoryItem[]` 数组 |
| 上限 | **500 条**，超出 FIFO 淘汰最旧 |
| 分片 | 复用 `storage.ts` 的 500KB 自动分片（500 条约 187KB，不触发） |
| 淘汰算法 | `upsert`：`findIndex` 去重 → `unshift` 头插 → `cache.length = 500` 尾截断（O(1)） |
| 写入节流 | 模块**自持**节流器（`throttleBackgroundTimer`，≥2s + 屏幕门控），**不复用** `@play_info` 的节流器 |
| 切歌语义 | 切歌**即时**写「切到哪集」；进度由播放中节流维护 |
| sync 隔离 | 历史键**不进** `getLocalListData` 白名单，天然被同步忽略 |

---

## 7. 核心机制（锁定 — 含关键的异步语义）

### 7.1 注入点（单一）

**`musicToggled` 事件**，发射点全项目唯一（`src/core/player/playInfo.ts:135`），**扩展签名为 `musicToggled(snapshot?)`** 携带上下文快照：

```ts
musicToggled(snapshot?: { musicInfo, listId, isTempPlay, playIndex })
```

**为什么必须带快照而非读全局 state**：`Event.emit` 用 `setImmediate` **异步派发**，同一 tick 内连续切歌时，监听器执行时读到的全局 state 已是最后一首 → 会漏记。

**向后兼容已验证**：4 处监听器（`init/player/lyric.ts:62`、`playerEvent.ts:137`、`playProgress.ts:177`、`preloadNextMusic.ts:64`）全部零参调用。

### 7.2 三重守卫（记录前置条件）

```ts
if (global.lx.isRestoringPlay) return          // 守卫1：冷启动恢复窗口（拦误记）
if (!snapshot || !listId || isTempPlay) return // 守卫2：无上下文/临时播放
if (!isAudioNovelList(listId)) return          // 守卫3：仅录音频小说歌单
```

### 7.3 bootGuard 开窗（`src/core/init/player/playInfo.ts`）

```ts
global.lx.isRestoringPlay = true
try {
  await playList(info.listId, info.index)
  await new Promise<void>(resolve => setImmediate(resolve))  // 让出，保证已投递事件先执行
} finally {
  global.lx.isRestoringPlay = false
}
```

**【依赖锁定】（必须保留注释）**：`emit` 投递与关窗 `setImmediate` 走**同一实现、同一队列、FIFO**，故监听器必先于关窗执行。
**禁止**改成 `setTimeout(..., 0)`（进不同队列，顺序可能反转）。

### 7.4 进度缓存（带身份校验）

```ts
on('playProgressChanged', (progress) => {
  if (progress.nowPlayTime === 0 && progress.maxPlayTime === 0) return  // 忽略 setProgress(0,0) 重置
  if (!cachedMusicId) return
  cachedProgress = progress.nowPlayTime
  cachedMaxTime = progress.maxPlayTime
})
```
**身份权威来源 = `musicToggled` 快照的 `musicId`**（非进度事件）。
**依赖既有守卫**：`playProgress.ts:30,32` 挡住 `setNowPlayTime` 越界写入。

### 7.5 续播契约（可断言三态）

```ts
type ResumeResult =
  | { ok: true }
  | { ok: false, reason: 'list_missing' }    // 歌单已删
  | { ok: false, reason: 'music_missing' }   // 集已不在列表
```
失败 → `toast(i18n 'audio_novel_history_item_invalid')` + 置灰 + **不自动删记录**。

---

## 8. 变更文件清单（锁定 — 含 3 处豁免）

| # | 文件 | 改动 | 豁免 |
|---|------|------|------|
| 1 | `src/core/audioNovelHistory.ts` | **新建**：核心模块（upsert/FIFO/节流/守卫/缓存/resume/purgeInvalid） | — |
| 2 | `src/types/list.d.ts` | `UserListInfo` + `isAudioNovel?: boolean` | — |
| 3 | `src/types/player.d.ts` | + `AudioNovelHistoryItem` | — |
| 4 | `src/types/app.d.ts` | `global.lx` + `isRestoringPlay` | — |
| 5 | `src/config/constant.ts` | `storageDataPrefix` + `@audio_novel_history` | — |
| 6 | `src/event/appEvent.ts:43-45` | `musicToggled(snapshot?)` 扩展签名 | — |
| 7 | `src/core/player/playInfo.ts:135` | 传快照对象 | **豁免①** |
| 8 | `src/core/init/player/playInfo.ts:6-17` | bootGuard 开窗 | **豁免②** |
| 9 | `src/core/init/player/playProgress.ts:41-57` | `getMaxTime` 加 id 快照+守卫 | **豁免③（仅 :41-57）** |
| 10 | `src/core/common.ts:57-61` | `exitApp` 新增 `destroyAudioNovelHistory()` | — |
| 11 | `src/core/init/player/index.ts:20-21` | 新增 `initAudioNovelHistory()` 注册 | — |
| 12 | `src/utils/listManage.ts:31-79` | `createUserList`/`updateList` 透传 `isAudioNovel` | — |
| 13 | `src/plugins/sync/listEvent.ts:6-15` | `buildUserListInfoFull` + `isAudioNovel` | — |
| 14 | `src/lang/{zh-cn,en-us,zh-tw}.json` | 新增 i18n key（见 §9） | — |
| 15 | `src/screens/Home/Views/Mylist/index.tsx` | 分段切换入口 | — |
| 16 | `src/screens/Home/Views/Mylist/PlayHistory/` | **新建**：`index.tsx` + `ListItem.tsx` | — |
| 17 | `src/screens/Home/Views/Mylist/MyList/ListMenu.tsx` | 新增「设为/取消有声小说」菜单项 | — |

**【豁免边界声明】**：
- 豁免① `playInfo.ts:135` **仅改该行**传参
- 豁免② `core/init/player/playInfo.ts` **仅改默认导出函数体内 `playList` 前后的开窗**
- 豁免③ `playProgress.ts` **仅改 `getMaxTime`（:41-57）**；`:13-39`（进度节流）、`:59-181` **一律不动**

---

## 9. i18n Key 清单（锁定 — 三语言齐全）

| Key | zh-cn 文案 | 用途 |
|-----|-----------|------|
| `audio_novel_history_title` | 播放历史 | 分段切换标签 / 页面标题 |
| `audio_novel_history_empty` | 还没有听过有声小说 | 空态标题 |
| `audio_novel_history_empty_desc` | 将歌单标记为有声小说后，播放时会自动记录进度 | 空态引导 |
| `audio_novel_history_item_invalid` | 该作品已不存在 | 失效条目 |
| `audio_novel_history_clear_confirm` | 将清空全部 {num} 条播放记录，清空后无法恢复 | 清空二次确认 |
| `audio_novel_history_remove_tip` | 已移除该条播放记录 | 删除单条反馈 |
| `audio_novel_history_purge_invalid` | 清理失效记录 | 清理入口按钮 |
| `list_set_audio_novel` | 设为有声小说 | 菜单项（未开启态） |
| `list_unset_audio_novel` | 取消有声小说 | 菜单项（已开启态） |
| `list_set_audio_novel_tip` | 已设为有声小说，播放时会自动记录进度 | 开启 toast |
| `list_unset_audio_novel_tip` | 已取消有声小说 | 关闭 toast |

**已存在的可复用 key（不新增）**：`date_format_second` / `date_format_minute` / `date_format_hour`（`src/lang/zh-cn.json:36-38`，配合 `utils/index.ts:174-185 dateFormat2`）

---

## 10. UI 规范（锁定 — 来自 `UIUX.md` v1.1）

| 项 | 规范 |
|---|---|
| 入口 | `Mylist` 视图内**分段切换**（「我的歌单 / 播放历史」） |
| 分段控件 | **项目无通用 segment 组件** → 复用 `Search/SearchTypeSelector.tsx:38-47` 的**下划线 tab 范式**（`borderBottomColor: c-primary-background-active`） |
| 历史列表项 L1 | 作品名（`c-font`，size 15，`numberOfLines={1}`）；播放中 `c-primary-font` |
| 历史列表项 L2 | 「第 N 集 · 集标题」（`c-500`，size 11，`numberOfLines={1}`） |
| 历史列表项 L3 | 进度时间点 + 相对时间（`c-350`/`c-250`，size 11-12） |
| 行高 | `scaleSizeH(52)` |
| 图标 | 历史 = `music_time`；续播 = `play-outline`(13) / `play`(20)；更多 = `dots-vertical`(12)；删除 = `remove`；清空 = `eraser`（复用 `HistorySearch.tsx:84` 用法） |
| 删除单条 | **三点菜单**（项目无左滑删除，不引入 swipeable 依赖） |
| 清空全部 | `ConfirmAlert` 二次确认（`components/common/ConfirmAlert.tsx`） |
| 开关形态 | **点击切换**（`Menu.tsx` 不支持勾选态），文案动态：未开启「设为有声小说」/ 已开启「取消有声小说」 |
| 开关位置 | `MyList/ListMenu.tsx` 第 3 项（`rename` 之后），仅用户歌单可选 |
| 500 上限 | **静默淘汰**，设置内只读告知，不做配额 UI |
| 空态 | 真实引导文案（见 §9），非「暂无数据」 |
| 颜色 | **全部** `theme['c-xxx']`，禁止裸 hex |

---

## 11. 验收标准（EARS 格式 — 锁定）

| 编号 | 功能 | EARS 验收标准 | 优先级 |
|------|------|--------------|--------|
| AC-01 | 记录 | While 用户在播放已标记为有声小说的歌单，系统**必须**记录 {listId, musicId, progress, updateTime} | P0 |
| AC-02 | 记录 | If 歌单未标记为有声小说，系统**必须不**记录历史 | P0 |
| AC-03 | 去重 | When 同一 listId 被再次播放，系统**必须更新**已有记录而非新增（列表长度不变） | P0 |
| AC-04 | 排序 | 系统**必须**按 `updateTime` 倒序展示历史列表 | P0 |
| AC-05 | 续播 | When 用户点击历史条目，系统**必须**跳到对应集并 seek 到记录的 progress 秒 | P0 |
| AC-06 | 续播 | If 目标歌单已删除，系统**必须**返回 `{ok:false, reason:'list_missing'}` 并提示，**不得**静默跳到错误集 | P0 |
| AC-07 | 续播 | If 目标集已不在歌单，系统**必须**返回 `{ok:false, reason:'music_missing'}` 并提示 | P0 |
| AC-08 | 删除 | When 用户删除单条，系统**必须**仅移除该条并持久化 | P0 |
| AC-09 | 清空 | When 用户确认清空，系统**必须**清空全部历史并持久化 | P0 |
| AC-10 | 淘汰 | While 历史已达 500 条，When 新增第 501 条，系统**必须**淘汰 `updateTime` 最旧的一条 | P0 |
| AC-11 | 持久化 | When App 冷启动，系统**必须**恢复上次历史（条数与内容一致） | P0 |
| AC-12 | 冷启动 | When App 冷启动恢复播放，系统**必须不**新增历史记录、**必须不**改变已有记录的 `updateTime` | P0 |
| AC-13 | 性能 | 系统**必须**使用后台节流器写历史，屏幕熄灭时**必须不**写入 | P0 |
| AC-14 | 集数正确 | While 用户在播放期间对歌单增删/排序，系统**必须**仍能准确跳到原 `musicId` 对应的集 | P0 |
| AC-15 | 开关 | When 用户在歌单菜单点击「设为有声小说」，系统**必须**持久化 `isAudioNovel=true` 并 toast 反馈 | P1 |
| AC-16 | 兼容 | While 老用户数据无 `isAudioNovel` 字段，系统**必须**按 false 处理且不报错 | P1 |
| AC-17 | 失效 | While 历史条目的歌单已被删除，系统**必须**标记失效并提供清理入口 | P1 |
| AC-18 | 防重 | While 模块重复初始化，系统**必须不**重复注册监听或产生双份定时器 | P2 |

---

## 12. 端到端验证步骤（锁定）

```bash
# 1. 类型检查（零错误）
npx tsc --noEmit

# 2. Lint（零错误）
npm run lint

# 3. bootGuard 顺序不变量值守测试（必须通过，退出码 0）
node docs/design/audio-novel-history/guard-setimmediate-order.test.js
# 断言：PASS × 3 用例，order=listener@window-open>window-closed

# 4. 真机验证（不可自动化，人工）
#   4.1 标记歌单为有声小说 → 播放第 3 集至 00:30 → 退出 App → 重启
#       断言：历史含该条目，progress≈30
#   4.2 冷启动恢复播放后
#       断言：历史条数不变（AC-12）
#   4.3 播放第 5 集 → 断言：历史仍为 1 条，musicId 已更新为第 5 集（AC-03）
#   4.4 删除该歌单 → 历史条目置灰显示「该作品已不存在」（AC-17）
#   4.5 快速切歌（1 秒内连切 3 集）→ 断言：最后一次记录正确（R-7 快照验证）
```

---

## 13. 已知坑清单（内嵌，防止重蹈覆辙）

| 坑 | 技术栈指纹 | 根因 | 修法 |
|----|------------|------|------|
| 事件异步派发 | `event/Event.ts:24-33` | `emit` 用 `setImmediate`（Hermes 下实为 **queueMicrotask**），监听器延迟执行 | 监听器**必须快照上下文**，禁止延迟读全局 state |
| 冷启动误记 | `player.ts:245-249` | 恢复分支提前 return，但 `setPlayMusicInfo` 已触发事件 | bootGuard 开窗 + `await setImmediate` 让出 |
| 进度事件清零 | `playInfo.ts:126` | `setProgress(0,0)` 同步先于 `musicToggled` | 双零忽略 + 身份校验 |
| 恒等死代码 | — | `curId !== playerState.musicInfo.id`（同源自比） | 已删除，改用快照 musicId |
| `getMaxTime` 无守卫 | `playProgress.ts:41-42` | 无 id 守卫 → stale duration 污染 maxTime | **豁免③** 加 2 行守卫 |
| 下标错位 | `listManage.ts:245-256` | 增删排序使 playIndex 平移 | 用 `musicId` 持久化定位 |
| 悬空引用 | `listManage.ts:158-170` | 删歌单不清理关联数据 | 失效标记 + `purgeInvalid()` |
| 字段丢失 | `listManage.ts:31-79` | `createUserList`/`updateList` 显式枚举字段 | 全链路透传 `isAudioNovel` |
| sync 丢字段 | `plugins/sync/listEvent.ts:6-15` | `buildUserListInfoFull` 显式枚举 | 加入 `isAudioNovel` |
| 重复注册 | `event/Event.ts:10-14` | `on` 不去重 | 模块级 `inited` guard + teardown |
| 分片边界 | `storage.ts:19` | 整倍数长度多写空片（读回无损） | 既有行为，不处理 |

---

## 14. 变更记录

| 日期 | 变更内容 | 原因 | 影响范围 |
|------|----------|------|----------|
| 2026-09-25 | Spec v1.0 生成 | Phase 1 三文档 + 五轮 P0/P1 迭代完成（P0/P1 全归零） | 全部 |
