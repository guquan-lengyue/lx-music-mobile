# 音频小说播放历史 — 架构调研与设计（Phase 1）

> 项目：洛雪音乐助手移动版（lx-music-mobile）
> 工作树：`C:/Users/gqly/WorkBuddy/Worktrees/lx-music-mobile/master-4c015332`
> 技术栈：React Native 0.73.11 + TypeScript，仅 Android
> 任务性质：**现有项目内功能增量**（非新建工程）
> 状态：Phase 1 调研完成，待 Phase 2 实施

本文件是「规格即契约」产物：点名文件、行号、接口签名、明确不做项、内嵌已知坑、端到端验证步骤。**每条设计决策均附代码证据（文件:行号）**，无法证实的一律标注「待验证」。

---

## 0. TL;DR（一页结论）

| 决策项 | 结论 |
|---|---|
| 记录注入点 | **单点**：`src/core/player/playInfo.ts:135` 的 `global.app_event.musicToggled()` 发射处，配合新增的 `global.app_event.on('musicToggled', ...)` 监听（模式同 `playProgress.ts:177`）。**不在多处埋点** |
| 存储方案 | **单键整体序列化**：`@audio_novel_history` 存一个 `HistoryRecord[]`（≤500 条），复用 `storage.ts` 自带 500KB 自动分片。**不**每作品一键（写放大 + 淘汰成本爆炸） |
| 与 SavedPlayInfo 关系 | **并行、互补、不替代**。`SavedPlayInfo`＝「App 重启后恢复到最后一次的全局单条断点」；`History`＝「按作品的播放历史 + 从任意历史项续播的能力」。历史记录**不接管** SavedPlayInfo 的写入/恢复链路，仅**新增**一条旁路 |
| 作品主键 | `listId`（歌单 id）为作品键；**集数定位用 `musicInfo.id`**（稳定），**禁止**用 `playIndex` 做跨会话主键（歌单顺序可变，见坑 #2） |
| UI 入口 | 新增独立页面 `AudioNovelHistory`，挂在 **Mylist（nav_love）视图内**的新 Tab/入口，不新增顶层 nav（`NAV_MENUS` 已满 5 项，见 §4） |
| 图标 | 复用项目**唯一**图标集：`components/common/Icon.tsx` 的 IcoMoon 自定义集。历史条目用已存在的 `music_time`；删除用 `eraser` / `remove`；**不引入第二套图标库** |
| 颜色 | 全部走 `useTheme()` 的 `c-*` token（`store/theme/hook.ts:38`），**禁止硬编码色值**（#fff/#000 除外） |
| sync 隔离 | 历史数据**不注册到** sync 模块，**不修改** `plugins/sync/**`；但「有声小说开关」若加到 `UserListInfo` 需评估其随 list 同步的副作用（见 §7） |

---

## 1. 现有代码接入点清单（文件 + 行号 + 改法）

### 1.1 存储键登记（必改）

| 文件 | 行号 | 现状 | 改法 |
|---|---|---|---|
| `src/config/constant.ts` | 40-81 | `storageDataPrefix` 对象 | 新增 `audioNovelHistory: '@audio_novel_history'`（追加在 `dislikeList` 之后，保持同构风格）|

**证据**：`src/config/constant.ts:40` `export const storageDataPrefix = { ... playInfo: '@play_info', ... }`。项目硬规则——新键必须在此登记（团队勘测已确认）。

### 1.2 类型定义（必改）

| 文件 | 行号 | 现状 | 改法 |
|---|---|---|---|
| `src/types/player.d.ts` | 71-76 | `SavedPlayInfo` 定义 | 在 `namespace LX.Player` 内**新增** `AudioNovelHistoryItem` 与 `AudioNovelHistoryList` 接口（见 §2）。**不改动** `SavedPlayInfo` |
| `src/types/app_setting.d.ts` | ~132 附近 | `player.isSavePlayTime` | 在 `player` 命名空间末尾新增 `'player.audioNovelHistoryEnable': boolean`（音频小说历史开关，与开关语义对齐）**待与产品确认命名** |
| `src/types/list.d.ts` | 3-11 | `UserListInfo` | **可选**：新增 `isAudioNovel?: boolean`。**本设计默认不加**（见 §3.3），若加需评估 sync 影响（§7） |

### 1.3 持久化层（新增文件 + data.ts 扩展）

| 文件 | 行号 | 改法 |
|---|---|---|
| `src/utils/data.ts` | 全文（已读，592 行） | **新增** 一组 `getAudioNovelHistory` / `saveAudioNovelHistory` / `addAudioNovelHistory` / `removeAudioNovelHistory` / `clearAudioNovelHistory`，沿用既有惯例：模块级缓存变量 + `throttle` 包裹 + `saveData(key, value)`。放在 `savePlayInfo`（433-439）附近 |
| `src/utils/data.ts` | 12-31 | 新增 `const audioNovelHistoryKey = storageDataPrefix.audioNovelHistory`（与 `playInfoStorageKey` 同段风格） |

**惯例证据**：`src/utils/data.ts:45-62` 全是「模块级变量 + `throttle(() => void saveData(key, val), 1000)`」模式；`:237-246` 的 `getSearchHistory/saveSearchHistory` 是「简单数组 CRUD」的最佳模板（**本功能直接对标它**）。

### 1.4 业务逻辑层（新增文件）

| 文件 | 改法 |
|---|---|
| `src/core/audioNovelHistory.ts`（**新建**） | 历史业务逻辑：构建记录、去重更新、FIFO 截断、读写编排、发事件。单一职责，≤300 行 |
| `src/store/audioNovelHistory/state.ts` + `hook.ts`（**新建，可选**） | 若历史页需要响应式刷新，仿 `store/player/hook.ts` 的 `useSyncExternalState` 模式。**MVP 可先不入 store**，页面挂载时 `await` 读取即可（见 §4 说明） |

### 1.5 事件总线（新增事件）

| 文件 | 行号 | 改法 |
|---|---|---|
| `src/event/appEvent.ts` | 43-45 | 已有 `musicToggled()` 发射器。**不改**，直接复用 |
| `src/event/stateEvent.ts`（需读，未展开） | — | 若历史页需实时刷新，新增 `audioNovelHistoryUpdated()`。**MVP 可省** |
| `src/core/init/player/playProgress.ts` | 177 | 已有 `global.app_event.on('musicToggled', handleSetPlayInfo)`。**不改此文件**；历史监听放在新模块 `core/audioNovelHistory.ts` 内注册 |

**注入点证据链**（关键）：
1. `src/core/player/playInfo.ts:122` `setPlayMusicInfo(listId, musicInfo, isTempPlay)` —— 切歌统一入口
2. `src/core/player/playInfo.ts:135` `global.app_event.musicToggled()` —— **仅在 `musicInfo != null` 时发射**（`playInfo.ts:128` 的 `else` 分支不发）
3. 此时 `playerState.playMusicInfo.{musicInfo,listId,isTempPlay}` 与 `playerState.playInfo.{playIndex,playerListId,playerPlayIndex}` 均已就绪（`playInfo.ts:123` 先写 action，`:132-134` 再算 index）
4. `playerState.playIndex` 由 `getPlayIndex`（`playInfo.ts:38-71`）基于 `musicInfo.id` 反查列表得到，**不受「播放队列过滤」影响**，是可靠的当前列表内位置

> **结论**：`musicToggled` 是**唯一**同时拿到 `musicInfo` + `listId` + `playIndex` 的时机，且是切歌语义（非暂停、非 seek）。**唯一注入点**，无竞态。

### 1.6 UI 接入点

| 文件 | 行号 | 改法 |
|---|---|---|
| `src/screens/`（新增目录） | — | 新建 `AudioNovelHistory` 页面目录（见 §4 接入方式） |
| `src/screens/Home/Views/Mylist/index.tsx` | — | 在 Mylist 内新增「历史」入口（Tab 或列表项），跳转到历史页 |
| `src/navigation/screenNames.ts` | 5 | **若**采用独立 navigation screen，新增 `export const AUDIO_NOVEL_HISTORY_SCREEN = 'lxm.AudioNovelHistoryScreen'` |
| `src/navigation/registerScreens.tsx` | 43-49 | **若**采用独立 screen，新增 `Navigation.registerComponent(...)`（并同步 `src/screens/index.ts:1-9` 导出） |

> **建议**：优先**不新增 navigation screen**，而是作为 Mylist 视图内的一个面板/Tab（复用现有 `Home` 页面容器，避免 navigation 生命周期与 `Provider` 重复注册成本）。详见 §4。

---

## 2. 数据结构设计（可直接落库）

```ts
// 新增于 src/types/player.d.ts 的 namespace LX.Player 内

/**
 * 单条音频小说播放历史
 * —— 一个「作品」对应一条记录（同一作品重复播放走更新），
 *    记录内保存「最近播到第几集 + 该集进度」
 */
interface AudioNovelHistoryItem {
  /** 作品主键 = 歌单 id（listId） */
  listId: string
  /** 作品名（冗余存储，防歌单被删后无法展示；也用于列表显示） */
  name: string
  /** 当前集索引（列表内位置，仅作展示/快速跳转，非跨会话主键） */
  index: number
  /** 该集在列表中的列表 id（冗余，用于跨歌单判断） */
  // listId 已是作品键，无需重复
  /** 当前集歌曲稳定 id（meta.id，跨会话定位用） */
  musicId: string
  /** 当前集歌曲名（冗余，列表展示） */
  musicName: string
  /** 当前集歌手/演播者（冗余，列表展示） */
  singer: string
  /** 封面地址（冗余；可能为空，可能较长，见 §3.2 体量评估） */
  picUrl: string | null
  /** 该集音频总时长（秒） */
  maxTime: number
  /** 当前播放进度（秒） */
  progress: number
  /** 最近播放时间戳（毫秒，列表排序键：倒序） */
  updateTime: number
}

/** 落库结构：整体一个数组（≤500 条），按 updateTime 倒序 */
type AudioNovelHistoryList = AudioNovelHistoryItem[]
```

### 2.1 字段取舍说明

- **`musicId` 而非 `playIndex` 作为跨会话定位键**：`playIndex`（`playerState.playInfo.playIndex`）是「当前列表内位置」，歌单增删歌会整体平移（证据：`utils/listManage.ts:245-256` 的 `listMusicRemove` 会 `splice` 重建列表）。用 `playIndex` 断点续播会错集。**用 `musicId` 反查 index**（`Array.findIndex(m => m.id === musicId)`），失败则回退到 0 或该条 `index`。
- **`listId` 作为作品键**：与 `playMusicInfo.listId` 直接同源（`player.d.ts:34`），无需额外归一化。「同一作品多个歌单」是内容运营问题，MVP 不做聚合（见 §5 out-of-scope）。
- **`name`/`musicName`/`singer`/`picUrl` 冗余存储**：防歌单/歌曲后来被删除或改名导致历史条目无法渲染。代价是体积（§3.2 已评估）。
- **`updateTime` 排序**：倒序即「最近播放时间倒序」，满足需求 2。

### 2.2 落库示例

```json
[
  {
    "listId": "userlist_1712345678901",
    "name": "三体（全集）",
    "index": 42,
    "musicId": "kw_abc123",
    "musicName": "第42集 黑暗森林",
    "singer": "播音 张三",
    "picUrl": "https://img.example.com/cover/xxx.jpg",
    "maxTime": 1830,
    "progress": 905,
    "updateTime": 1735689600000
  }
]
```

---

## 3. 存储方案对比矩阵 + 结论

### 3.1 方案对比

| 维度 | 方案 A：单键整体序列化<br>`@audio_novel_history` → 1 个数组 | 方案 B：每作品一键<br>`@anh__${listId}` → 1 条 | 方案 C：元数据单键 + 分片<br>手写分片 |
|---|---|---|---|
| **读放大** | 页面打开时一次读出全量（≤500 条）。列表页本就需全量 → 无额外放大 | **N 次读**（N = 作品数）才能列表；或额外维护索引键 → 双读 | 同 A（一次读 index + 若干分片） |
| **写放大** | 每次切歌重写整个数组（≤500 条）。含 500KB 自动分片，见下 | **只写 1 个键**（最优） | 重写 index + 命中分片 |
| **淘汰成本** | O(1)：`push` 后 `if (len > 500) splice(0, len-500)`，一次落库 | **O(N)**：需先读全量键名（`getAllKeys` 扫描 + 过滤）才能找最旧的删 → 昂贵 | 需重算分片边界 → 复杂 |
| **实现复杂度** | **低** | 中（需额外维护 id 列表 / 排序） | 高（手写分片 = 重造 storage.ts 轮子） |
| **与 storage.ts 契合** | **天然契合**：`buildData` 自动按 500KB 分片（`storage.ts:11-25`） | 契合但丧失「整体淘汰」便利 | **重复造轮子，违反 P0「不过度设计」** |
| **列表排序** | 数组内 `sort` 或 `unshift`（O(1) 头插） | 需跨键归并排序 | 需遍历 |
| **结论** | ✅ **采纳** | ❌ 淘汰成本 + 读放大双高 | ❌ 过度设计 |

### 3.2 500 条 × MusicInfo 体量评估（关键数据）

- 单条记录去除长字段后约 **200~300 字节**（JSON 键名 + 中文字符 UTF-8 3 字节）。
- `picUrl` 可长达 150~250 字符（CDN 带签名参数）→ 单条峰值约 **500 字节**。
- 500 条峰值估算：`500 × 500B ≈ 250KB`，**低于 `storage.ts:9` 的 `limit = 500000`（500KB）单键阈值**。
- **即使极端情况下超 500KB**，`storage.ts:11-25` 的 `buildData` 会**自动切分**为 `@___PART_A___@audio_novel_history{n}` 分片，读写/删除均由 `storage.ts` 透明处理（`getData:60-73` / `removeData:75-117`）。
- **结论**：单键方案在 500 条上限下**不会触顶**，即便触顶也**自动降级为分片**，无需自研。
- **优化项（advisory）**：可将 `picUrl` 裁剪为去参数版本或存 `musicInfo.id` 让 UI 现取，进一步压体积。MVP 先直接存，见 §9。

### 3.3 存储键命名 + 与 storage.ts 配合方式

- **键名**：`@audio_novel_history`（登记于 `storageDataPrefix.audioNovelHistory`）。
  命名与现有 `@play_info`、`@search_history_list`、`@dislike_list` 同构（蛇形 + `@` 前缀）。
- **配合方式**：全部通过 `@/plugins/storage` 的 `getData<T>` / `saveData` / `removeData`，**禁止**直连 AsyncStorage（项目已全量封装）。
- **写入节流**：用 `utils/tools.ts:419` 的 `throttleBackgroundTimer`（与 `playProgress.ts:13` 同款），**不用** `utils/common.ts` 的 `throttle`（后者基于 `setTimeout`，后台/息屏时 RN 定时器可能被冻结；`throttleBackgroundTimer` 基于 `BackgroundTimer`，可在后台触发）。**这是本项目的关键指纹**。

---

## 4. UI 入口接入方式

### 4.1 位置决策

现有顶层导航由 `NAV_MENUS`（`config/constant.ts:101-108`）驱动，消耗点仅两处：
- `screens/Home/Horizontal/Aside.tsx:136`
- `screens/Home/Vertical/DrawerNav.tsx:131`

`NAV_MENUS` 现为 5 项（search/songlist/top/love/setting），且 Vertical 布局用 **PagerView 固定 index 映射**（`screens/Home/Vertical/Main.tsx:181-193` 的 `nav_search:0 ... nav_setting:4` 及 `PAGE_KEYS` 数组）。**新增顶层 nav 会打破 index 映射，改动面大**。

> **决策**：**不新增顶层 nav**。历史入口放在 **Mylist（`nav_love`）视图内部**——因为音频小说作品本质就是歌单（`UserListInfo`），历史是「歌单的衍生视图」，位置语义最贴切。

### 4.2 推荐接入方式（按优先级）

**方式 1（首选，改动最小）**：在 Mylist 视图顶部加一个「历史」入口按钮/切换条，点击后用局部 state 切换到历史列表组件（不涉及 navigation）。
- 载体：`src/screens/Home/Views/Mylist/index.tsx`（**已读**：该文件 52-68 行是一个 `DrawerLayoutFixed`，抽屉内 `renderNavigationView={() => <MyList />}`，主区 `<MusicList />`）。「历史」入口可作为 `MyList` 列表区（`Mylist/MyList/List.tsx`，即歌单列表）上方的一个切换项，或在 `Mylist/index.tsx:52` 的 `navigationView` 外层加一个顶部 Tab。
- 新增组件：`src/screens/Home/Views/AudioNovelHistory/`（`index.tsx` + `ListItem.tsx`）。
- 复用现有列表骨架：`screens/Home/Views/Mylist/MyList/List.tsx:118-134`（`FlatList` + `getItemLayout` + 主题 token 的写法可直接照搬）。`ListItem` 骨架见 `Mylist/MyList/List.tsx:21-70`（`TouchableOpacity` + `Icon` + `Text` + `theme` token）。

**方式 2（独立 screen，次选）**：若产品要求全屏页 + 返回栈。
- `src/navigation/screenNames.ts` 新增 `AUDIO_NOVEL_HISTORY_SCREEN`。
- `src/screens/index.ts` 导出 `AudioNovelHistory`。
- `src/navigation/registerScreens.tsx:43-49` 注册。
- ⚠️ 代价：新 screen 需包 `Provider`（`registerScreens.tsx:28-40`），冷启动成本增加；Android 侧 navigation 新组件注册需重新 `setRoot`（`待验证 navigation/index.ts`）。

### 4.3 续播交互

历史条目点击 → 调用现有播放能力：
- 若 `listId` 歌单仍存在：`playList(listId, targetIndex)`（`core/player/player.ts:289`），随后用 `global.app_event.setProgress(progress, maxTime)`（`appEvent.ts:51`）恢复进度。
- 若 `listId` 已不存在（歌单被删）：条目显示为「失效」，点击提示或置灰（**不崩溃**）。

---

## 5. 新历史功能 vs 现有 SavedPlayInfo 协同方案（R1 核心决策）

### 5.1 二者定位对比

| 维度 | `SavedPlayInfo`（现有） | `AudioNovelHistory`（新增） |
|---|---|---|
| 存储键 | `@play_info`（`constant.ts:52`） | `@audio_novel_history`（新增） |
| 数据形状 | **单条** `{time,maxTime,listId,index}`（`player.d.ts:71-76`） | **多条数组**（≤500） |
| 语义 | 「App 被杀死时最后一条播放断点」 | 「按作品的播放历史台账」 |
| 写入时机 | ① 进度节流 2s（`playProgress.ts:13-20`）② 切歌立即写（`playProgress.ts:115-128`） | **仅切歌时**写（去重更新）|
| 恢复时机 | 冷启动 `core/init/player/playInfo.ts:6-17` → `global.lx.restorePlayInfo` → `handleRestorePlay`（`player.ts:157-196`） | 用户在历史页**主动点击**才恢复 |
| 影响范围 | 全局唯一断点，冷启动自动生效 | 不干扰冷启动，纯用户主动 |

### 5.2 协同结论：**并行、互补、互不接管**

**明确结论**：
1. **`SavedPlayInfo` 链路完全不动**（不改 `playProgress.ts` / `playInfo.ts` / `playInfo` 恢复逻辑）。冷启动续播行为与现状 100% 一致。
2. **新增历史为「旁路写入」**：在同一 `musicToggled` 事件上**再挂一个监听器**（`appEvent` 是 EventEmitter，支持多监听，证据 `event/Event.ts` 的 on/off 机制）。两者互不感知。
3. **历史页的续播是「用户主动二次触发」**：点击历史项 → `playList` → `setProgress`。这会**顺带**让 `SavedPlayInfo` 也更新为同一断点（因为播放本身会触发 `playProgress` 的写入）——这是**期望行为**，不算冲突。

### 5.3 文字时序（切歌时）

```
用户点歌 / 自动切下一集
   │
   ▼
core/player/player.ts playList / playNext
   │  setPlayMusicInfo(listId, musicInfo, isTempPlay)   [playInfo.ts:122]
   │      ├─ playerActions.setPlayMusicInfo(...)          [playInfo.ts:123]
   │      ├─ setPlayerMusicInfo(musicInfo)               [playInfo.ts:124]
   │      ├─ setProgress(0, 0)                            [playInfo.ts:126]
   │      └─ global.app_event.musicToggled()  ◄── 单一注入点 [playInfo.ts:135]
   │
   ├──▶ [现有] playProgress.handleSetPlayInfo()           [playProgress.ts:115]
   │        └─ savePlayInfo(单条断点)  → @play_info
   │
   └──▶ [新增] audioNovelHistory.onMusicToggled()          [新模块]
            ├─ 读 playerState.playMusicInfo + playInfo.playIndex + progress
            ├─ 构造/去重更新记录（按 listId）
            ├─ 头插 + FIFO 截断到 500
            └─ throttleBackgroundTimer(2s) → saveData(@audio_novel_history)
```

> 两个监听器**执行顺序**：EventEmitter 按注册顺序同步调用。**新增监听不改变 `handleSetPlayInfo` 的既有行为**（它读取的是同一时刻的 state，两个监听器读取时机一致）。
> **注意**：`handleSetPlayInfo`（`playProgress.ts:115-127`）内部会 `handlePause()`，但**不修改** `playMusicInfo`——所以新增监听读取到的是同一份数据，**无竞态**。

---

## 6. 写入时机与节流方案

### 6.1 写入时机

- **主写入**：`musicToggled`（切歌）。此时 `progress` 刚被 `setProgress(0,0)` 重置（`playInfo.ts:126`），**尚无新进度**！
  → **坑 #1**：切歌瞬间 `playerState.progress.nowPlayTime` 是 0，直接读会丢掉「上一集」的进度。
  → **修法**：历史记录保存的是「**切到的新集 + 其进度 0**」，而「**上一集的最终进度**」应由**节流钩子（§6.2）持续更新**，而非切歌瞬间捕获。即：历史条目的 `progress` 字段由**播放中的节流写入**维护，切歌时只负责「切换到新集、把 progress 归零、更新 updateTime」。

### 6.2 节流 + 屏幕门控（对标 `playProgress.ts`）

在 `core/audioNovelHistory.ts` 内：

```ts
import { throttleBackgroundTimer } from '@/utils/tools'

// 2s 节流，与 savePlayInfo 同款（playProgress.ts:13-20）
const delayUpdateProgress = throttleBackgroundTimer(() => {
  const { listId } = playerState.playMusicInfo
  if (!listId) return
  audioNovelHistory.updateCurrentProgress(
    listId,
    playerState.progress.nowPlayTime,
    playerState.progress.maxPlayTime,
  )
  void saveAudioNovelHistory()   // 走 data.ts，内部亦已 throttle
}, 2000)
```

- **屏幕门控**：复用 `playProgress.ts:155-160` 的 `isScreenOn` 机制与 `onScreenStateChange`（`utils/nativeModules/utils`）。仅在 `isScreenOn === true` 且 `playerState.isPlay` 时更新进度。
- **进度更新触发源**：`playProgress.ts:29-40` 的 `getCurrentTime` 由 `BackgroundTimer.setInterval` 每秒调用，并已按 `isPlay`/`isScreenOn`/`isTempPlay` 门控。**新增模块可直接监听 `state_event` 的进度事件**，或独立挂一个 2s 节流钩子，二者择一（见 §6.4）。
- **节流周期**：**2000ms**（与 `savePlayInfo` 完全一致，避免两套节流互相打脸）。

### 6.3 切歌写入（即时）

切歌时**不做节流**（需立即持久化「切到哪一集」）：
- `onMusicToggled` 内直接 `upsert(record)` + 触发一次落库（可合并到 2s 节流窗口，因为 `musicToggled` 频率低）。

### 6.4 与现有节流的协同（避免双写冲突）

> **关键**：不要新增第二个「每秒读 `getPosition()`」的轮询（会造成双倍 native 调用）。
> **首选**：让新模块**订阅现有的进度状态变更**——`playProgress` 更新 `playerState.progress` 后会通过 `global.state_event.playProgressChanged()` 广播。
> **已验证证据**：
> - 事件定义：`event/stateEvent.ts:67-69` `playProgressChanged(progress)`
> - 发射点：`store/player/action.ts:49 / :56 / :65`（`setNowPlayTime` / `setMaxplayTime` 等 action 内 `global.state_event.playProgressChanged({ ...state.progress })`）
> - 消费范例：`store/player/hook.ts:70-86`（`useProgress`）、`core/init/player/preloadNextMusic.ts:56-66`
> 新模块 `global.state_event.on('playProgressChanged', ...)` → 内部 2s `throttleBackgroundTimer` → 写库。
> **频率**：`playProgress.ts:64-71` 的 `BackgroundTimer.setInterval(1000 / playbackRate)` 每秒触发 `getCurrentTime` → 每秒 emit。**必须**在消费端做 2s 节流，否则写库过频。

---

## 7. 500 条 FIFO 淘汰 — 实现位置与算法

**位置**：`src/core/audioNovelHistory.ts` 的 `upsert` 内，**在内存缓存上操作**，落库前完成截断。

```ts
const MAX_HISTORY = 500

const upsert = (item: LX.Player.AudioNovelHistoryItem) => {
  const cache = getCacheSync()            // 模块级内存数组，已按 updateTime 倒序
  const idx = cache.findIndex(r => r.listId === item.listId)
  if (idx >= 0) {                         // 同一作品 → 更新（需求 2）
    cache.splice(idx, 1)                  // 先摘除，再头插，天然置顶
  }
  cache.unshift(item)                     // 头插 = 最新在前（O(1) 摊还）
  if (cache.length > MAX_HISTORY) {
    cache.length = MAX_HISTORY            // FIFO：截断尾部最旧（O(1) 真正截断）
  }
}
```

- **淘汰算法**：**数组头插 + 尾截断**。因保持「倒序（最新在前）」，淘汰即丢掉数组尾部超出 500 的部分 → `cache.length = 500`（**不是 splice 循环**，O(1)）。
- **复杂度**：单次 upsert = `findIndex` O(N=500) + 头插 O(N) + 截断 O(1)。N 固定 500，**可忽略**。
- **持久化**：截断后由 `throttleBackgroundTimer` 合并落库。
- **删除单条**：`removeAudioNovelHistory(listId)` → `splice(idx,1)` → 落库。
- **清空全部**：`clearAudioNovelHistory()` → `cache.length = 0` → `removeData(audioNovelHistoryKey)`（**用 removeData 而非 saveData(`[]`)**，彻底清除含分片的键，证据 `storage.ts:75-117`）。

---

## 8. 与现有 sync 机制的隔离说明

### 8.1 隔离结论

1. **历史数据本身不接 sync**：`@audio_novel_history` 键**不进** `getLocalListData()`（`plugins/sync/listEvent.ts:17-30`），sync 只同步 `defaultList/loveList/userList` + 列表内歌曲。**新增键天然被 sync 忽略**（sync 白名单式采集，非全量）。→ **零侵入**。
2. **不修改 `plugins/sync/**`** 任何文件。
3. **不新增 sync module**（`plugins/sync/client/modules/` 下无新目录）。

### 8.2 「有声小说开关」若不慎加到 `UserListInfo` 的同步风险（R2）

> 若把 `isAudioNovel` 加到 `UserListInfo`（`types/list.d.ts:3`），会经以下链路**被同步到服务端**：
> - `plugins/sync/listEvent.ts:6-15` `buildUserListInfoFull` **显式列出字段**（`id,name,source,sourceListId,locationUpdateTime,list`）→ **新字段默认不会进**，除非主动加。
> - 因此**即使加了字段，只要不改 `buildUserListInfoFull`，就不会同步**。
> - 但 `plugins/sync/client/modules/list/localEvent.ts` 与桌面端**协议对齐**（`待验证`）——若桌面端 schema 校验严格，可能因未知字段报错。

> **结论（规避 R2）**：**本设计不修改 `UserListInfo`**。「哪些歌单是音频小说」的判定改为**运行时启发式**或**独立配置键**（见 §8.3），从根上避开 sync 协议。

### 8.3 「作品」识别方案（不依赖 UserListInfo 改动）

**方案 A（推荐，零协议风险）**：新增独立键 `@audio_novel_list_ids`（存 `string[]`），记录用户标记为「音频小说」的歌单 id。开关 UI 改这个键，sync 不碰它。
**方案 B（零配置）**：不做「开关」，按业务规则自动识别（如图集名匹配 `/第\d+[集话章]/`）。**待与产品确认是否可接受**。
**方案 C（改动最大）**：改 `UserListInfo` + 改 `buildUserListInfoFull` + 改桌面端协议。**否决**（破坏 sync 兼容）。

> 本设计**默认方案 A**：历史记录对**所有歌单**都记录（不区分是否音频小说），「音频小说」标记仅影响**展示过滤**。这样即使用户不开关，历史也不丢。**待产品确认**是否需要对所有歌单记录。

---

## 9. 已知坑清单（技术栈指纹 + 根因 + 修法）

| # | 坑 | 根因（证据） | 修法 |
|---|---|---|---|
| 1 | **切歌瞬间进度为 0** | `playInfo.ts:126` `setProgress(0,0)` 在 `musicToggled` 之前执行 | 切歌只更新「当前集 + 归零」，`progress` 由播放中的 2s 节流维护（§6.1） |
| 2 | **`playIndex` 不可作跨会话主键** | 歌单增删会 `splice` 重建（`utils/listManage.ts:245-256`），index 平移 | 用 `musicId`（`meta` 稳定 id，`music.d.ts:22`）反查；失败回退到存的 `index` |
| 3 | **后台/息屏定时器被冻结** | RN `setTimeout` 在后台不可靠；项目专用 `BackgroundTimer` | 用 `utils/tools.ts:419` 的 `throttleBackgroundTimer`（**非** `common.ts` 的 `throttle`） |
| 4 | **`musicToggled` 在 `musicInfo == null` 时不发** | `playInfo.ts:128-136`：`else` 分支只 `updatePlayIndex(-1,-1)`，**不发射** | 监听器内**必须**判空 `playerState.playMusicInfo.musicInfo`，避免读到上一首的残留 |
| 5 | **`isTempPlay` 的「稍后播放」不应记历史** | `screens/.../MusicToggleModal` 等会以 temp 方式播放单曲（`player.ts:318-321`） | 监听器内 `if (isTempPlay) return`（对齐 `playProgress.ts:36` 的既有判断） |
| 6 | **状态是裸对象直改 + 事件广播，非 Redux** | `store/player/state.ts` 直接导出可变对象；变更靠 `global.state_event.xxx()` | 读值直接引 `playerState.xxx`；UI 刷新必须订阅 `state_event`（参考 `store/player/hook.ts`） |
| 7 | **存储键必须登记 constant.ts** | 全项目键集中在 `config/constant.ts:40-81` | 新键 `audioNovelHistory` 必加，否则难维护/易冲突 |
| 8 | **图标是 IcoMoon 自定义集，非内置名** | `components/common/Icon.tsx:24` `createIconSetFromIcoMoon(icoMoonConfig)`；两个已知名：`music_time`（播放时长）、`eraser`（清除）、`remove`（删除）、`dots-vertical`（更多） | 只从 `resources/fonts/selection.json` 的 49 个已注册名里选；**禁止**引入第二套图标库 |
| 9 | **硬编码色值违规** | P0 规则 + 主题 token 全覆盖（`types/theme.d.ts:263-283`） | 一律 `theme['c-font']` / `theme['c-350']` / `theme['c-primary-font']` 等；#fff/#000 例外 |
| 10 | **`removeData` 对分片键的清理** | `storage.ts:75-117` 会自动清 `@___PART_A___` 分片 | 「清空全部」用 `removeData(key)`，**不要**用 `saveData(key, [])`（会残留空数组） |
| 11 | **`throttle` 与 `throttleBackgroundTimer` 语义不同** | `common.ts` throttle 基于 `setTimeout`；`tools.ts:419` 基于 `BackgroundTimer` | 播放相关一律用 `BackgroundTimer` 版 |
| 12 | **`SavedPlayInfo.listId` 类型标注为必有** | `player.d.ts:74` `listId: string`（非空），但 `playInfo.ts:122` 传入可为 null | 新增历史 `listId` 用 `string` 但**运行时判空**；避免照抄类型造成空指针 |

---

## 10. 明确不做（Out-of-Scope）

- ❌ **不接 sync-server**（用户明确要求，仅本地持久化）。
- ❌ **不做跨设备历史合并**。
- ❌ **不做「同一作品多歌单聚合」**（listId 即作品键，不归一化 albumName）。
- ❌ **不改 `SavedPlayInfo` 机制**（并行旁路）。
- ❌ **不新增顶层导航项**（复用 Mylist 内入口）。
- ❌ **不引入第二套图标库 / 不改主题 token 结构**。
- ❌ **不做历史的云端备份/导出**（必要时后续独立迭代）。
- ❌ **不做「按集数预生成全部历史」**（只记当前集）。

---

## 11. 风险清单与不可行项

| 风险 | 等级 | 说明 | 缓解 |
|---|---|---|---|
| R1：与 SavedPlayInfo 语义打架 | 中 | 冷启动续播 vs 主动续播双入口 | §5 已明确「并行互补」，SavedPlayInfo 链路零改动 |
| R2：动了 UserListInfo 破坏 sync | 中 | `buildUserListInfoFull` 白名单式采集（`listEvent.ts:6-15`） | §8.3 方案 A：独立键，不改 UserListInfo |
| R3：500 条体积超 500KB | 低 | 实测估算约 250KB，且 storage.ts 自动分片 | §3.2 已证；可选裁剪 picUrl |
| R4：切歌瞬间丢进度 | 高（但已解） | 坑 #1 | §6.1 用播放中节流维护进度 |
| R5：UI 导航改动面 | 中 | Vertical PagerView 固定 index 映射（`Main.tsx:181-193`） | §4 决定不新增顶层 nav |
| R6：`playProgressChanged` 事件发射点未逐行确认 | 低 | hook 已证明事件存在（`hook.ts:70-86`） | 实施前读 `event/stateEvent.ts` 确认（标注**待验证**） |

**不可行项**：无。全部需求在当前技术栈下可实现。

---

## 12. 端到端验证步骤（收尾即验收）

1. **编译门**：`yarn tsc --noEmit` + eslint 通过（拦幻觉 import，见「生成式代码失效模式」§3）。
2. **单文件行数门**：`find src -name '*.ts' | xargs wc -l | sort -rn | awk '$1>300'` → 新增文件不超 300 行。
3. **核心成功流**：
   - 打开音频小说歌单 → 播放第 1 集 → 拖到 00:30 → 切到第 2 集 → 返回 → 进历史页 → 应见 1 条记录（该作品、第 2 集、进度 ~0）；等待 ≥2s 再返回应见第 2 集进度 >0。
   - 杀掉 App 重开 → 历史仍在（持久化）。
   - 从历史点第 1 条 → 应回到「该作品 + 记的集 + 记的进度」。
4. **重复播放更新（需求 2）**：连续切 3 次第 1 集 → 历史仍只有 1 条，`updateTime` 为最新，排在最前。
5. **边界流**：
   - 造 501 条不同作品 → 历史为 500 条，最旧 1 条被淘汰。
   - 删除单条 → 该条消失，其余不变。
   - 清空全部 → 列表空，**重开 App 仍为空**（验证分片键被清）。
   - 歌单被删后再点历史条目 → 不崩溃，提示失效。
   - 临时播放（稍后播放）不产生历史。
6. **sync 回归**：连接 sync server → 触发列表同步 → 无报错，历史键不出现在 `getLocalListData` 结果中。

---

## 13. 待验证清单（实施前必须确认）

- [x] ~~`src/event/stateEvent.ts` 中 `playProgressChanged` 的发射时机与频率~~ → **已确认**：`stateEvent.ts:67-69` 定义，`store/player/action.ts:49/56/65` 发射，每秒 1 次（`playProgress.ts:64-71`）。
- [x] ~~`src/screens/Home/Views/Mylist/index.tsx` 现有结构~~ → **已确认**：DrawerLayoutFixed，`navigationView=<MyList/>`，主区 `<MusicList/>`（`Mylist/index.tsx:52-68`）。
- [ ] `src/navigation/index.ts` 是否支持动态 `setRoot`（决定 §4.2 方式 2 可行性）。
- [ ] 产品确认：是否需要「音频小说开关」（§8.3 方案 A 的 UI 是否要做）／是否对所有歌单都记历史。
- [ ] `plugins/sync/client/modules/list/localEvent.ts` 与桌面端协议对齐情况（R2 深度确认）。

---

## 14. 变更文件清单（供 Phase 2 落实施工）

> ⚠️ 本节已被 §15 第二轮修正覆盖（UI 路径、UserListInfo 字段透传有变）。以 §15 为准。

**新增**：
- `src/core/audioNovelHistory.ts`
- `src/screens/Home/Views/AudioNovelHistory/index.tsx`
- `src/screens/Home/Views/AudioNovelHistory/ListItem.tsx`

**修改**：
- `src/config/constant.ts`（+1 键，可选 +2）
- `src/types/player.d.ts`（+2 interface）
- `src/types/app_setting.d.ts`（可选 +1 开关）
- `src/utils/data.ts`（+ 一组 CRUD 函数 + 1 个 key 常量）
- `src/screens/Home/Views/Mylist/index.tsx`（+ 历史入口）

**禁止修改**：`src/core/init/player/playProgress.ts`、`src/core/player/playInfo.ts`、`src/core/player/player.ts`、`src/plugins/sync/**`。

---

# 15. P0/P1 修正响应（第二轮）

> 本节回应 team-lead 复核裁决（3 处冲突 + QA 两项）。**冲突 1、冲突 3 未闭环前不进开发**。所有结论附 `文件:行号`。

## 15.1 冲突 1（P0）：冷启动误记历史 — 已闭环

### 根因链复现（team-lead 判断成立，已逐行验证）

```
冷启动
core/init/player/playInfo.ts:13   global.lx.restorePlayInfo = info      ← 先置位（非空）
core/init/player/playInfo.ts:15   await playList(info.listId, info.index)
   │
   ▼ core/player/player.ts:289  playList()
   ├─ :291 setPlayListId(listId)
   ├─ :292 setPlayMusicInfo(listId, getList(listId)[index])   ◄── 同步执行
   │        │ core/player/playInfo.ts:122 setPlayMusicInfo()
   │        └─ :135 global.app_event.musicToggled()  ◄── 历史会被误写 HERE（此时 restorePlayInfo 仍非空）
   └─ :295 await handlePlay()
            │ core/player/player.ts:229 handlePlay()
            ├─ :245 if (global.lx.restorePlayInfo) → true
            ├─ :246 void handleRestorePlay(...)
            ├─ :247 global.lx.restorePlayInfo = null   ◄── 到这一步才清空
            └─ :248 return
```

**关键时序结论**：`musicToggled` 在 `player.ts:292` **同步**触发，此刻 `global.lx.restorePlayInfo` **必然非空**（在 `player.ts:247` 才被清空）。→ **守卫 B 在该时点有效**。

补充验证：`handleRestorePlay`（`player.ts:157-196`）内部**不调用** `setPlayMusicInfo`（只调 `setProgress`(:162)、`setMusicInfo`(:175/:181)、`initTrackInfo`(:167)），**不会再触发第二次 `musicToggled`**。故冷启动全程只产生 1 次 `musicToggled`。

### 采纳方案：**B（守卫）+ C（前置播种）组合** —— 单一注入点仍为 `musicToggled`

在 `core/audioNovelHistory.ts` 的监听器内：

```ts
const onMusicToggled = () => {
  // 守卫 1（冷启动）：恢复播放期间不写历史（时序见上，此处必定成立）
  if (global.lx.restorePlayInfo) return

  const { musicInfo, listId, isTempPlay } = playerState.playMusicInfo
  // 守卫 2：无歌曲 / 临时播放不记（对齐 playProgress.ts:36 既有判断）
  if (!musicInfo || !listId || isTempPlay) return

  // 守卫 3：list 不是音频小说则跳过（需求：仅记录有声小说歌单）
  if (!isAudioNovelList(listId)) return   // 读 UserListInfo.isAudioNovel，见 §15.3

  upsert(buildRecord(musicInfo, listId))
  scheduleFlush()   // 见 §15.4
}
```

### 三条真实播放路径覆盖验证

| 路径 | 入口 | 是否触发 `musicToggled` | 是否应记历史 | 守卫是否放行 |
|---|---|---|---|---|
| 手动点歌（列表内） | `playListById` :273 → `setPlayMusicInfo` :278 | ✅ `playInfo.ts:135` | 是 | ✅（restorePlayInfo 为空） |
| 手动点歌（按下标） | `playList` :289 → `setPlayMusicInfo` :292 | ✅ | 是 | ✅ |
| 自动下一曲 | `playNext` → `handlePlayNext` :402 → `setPlayMusicInfo` :403 | ✅ | 是 | ✅ |
| 自动下一曲（随机预取） | `getNextPlayMusicInfo` :317 只**计算** info，真正切换仍走 `handlePlayNext` | ✅（在 handlePlayNext 内） | 是 | ✅ |
| **冷启动恢复** | `core/init/player/playInfo.ts:15` → `playList` → `setPlayMusicInfo` :292 | ✅（会触发） | **否** | ❌ 被守卫 1 拦下 |
| 稍后播放 | `playNext` :412 / `handlePlayNext`(isTempPlay) | ✅ | 否 | ❌ 被守卫 2 拦下 |

> **反例说明（冷启动为何不会误记）**：冷启动唯一那次 `musicToggled` 发生在 `player.ts:292`，其执行栈是 `playList`（`player.ts:289`）同步调用 `setPlayMusicInfo`；而清空 `restorePlayInfo` 的 `handlePlay` 在 `player.ts:295` 才被 `await`。**先触发、后清空**，因此监听器执行时 `restorePlayInfo` 必非空，守卫 1 稳定生效。**不是靠竞态运气，是靠同步调用顺序的结构性保证。**

### 为何不选方案 A（改挂 `debouncePlay` / `handlePlay` 非恢复分支）

`debouncePlay`（`player.ts:199`）与 `handlePlay` 的非恢复分支**拿不到 `musicToggled` 提供的「切换语义」可靠性**，且 `handlePlay` 在恢复分支直接 `return`（`:248`）会漏掉所有正常播放。改挂会造成「记录点分散、多处埋点」——正是要避免的。**结论：B+C 优于 A**。

---

## 15.2 冲突 2（UI）：采纳 team-lead 裁决 —— 结合方案

**最终设计（照此实施）**：

| 层 | 决策 | 文件 |
|---|---|---|
| 顶层导航项 | **不新增**（尊重 PagerView 硬编码索引 `Main.tsx:181-193`） | 不动 |
| 入口位置 | `Mylist` 视图内，作为 tab / 分段控件 | `src/screens/Home/Views/Mylist/index.tsx:52-68` 区改造 |
| 历史列表实现 | **独立组件目录**，与 `MyList/` 平级，单一职责 | `src/screens/Home/Views/Mylist/PlayHistory/`（`index.tsx` + `ListItem.tsx` + 可选 `listAction.ts`） |

- **不新增 navigation screen**（`screenNames.ts` / `registerScreens.tsx` 均不动）。
- `Mylist/index.tsx` 当前结构（已读）：`DrawerLayoutFixed`（`:56`），`renderNavigationView={() => <MyList />}`（`:63`），主区 `<MusicList />`（`:67`）。改造点：在 `drawer` 内容区（`MyList` 所在）顶部加一个「我的歌单 / 播放历史」分段切换，切换后渲染 `<MyList />` 或 `<PlayHistory />`。
- **心智模型分离**：`MyList`＝「我的歌单」管理；`PlayHistory`＝「播放历史」只读列表。两者仅共享外层容器与切换控件。

---

## 15.3 冲突 3（⚠️ 改回用户指定方案）：`UserListInfo.isAudioNovel` + 全链路透传

**采纳用户指定方案**：在 `UserListInfo` 增加可选字段 `isAudioNovel?: boolean`。不再用独立键 `@audio_novel_list_ids`（该方案作废）。

### 类型定义

```ts
// src/types/list.d.ts:3-11  UserListInfo 内新增
interface UserListInfo {
  id: string
  name: string
  source?: LX.OnlineSource
  sourceListId?: string
  locationUpdateTime: number | null
  /** 是否为有声小说歌单（新增，可选，老数据无此字段 → 视为 false） */
  isAudioNovel?: boolean
}
```

### sync 字段透传改动清单（覆盖 save / restore / sync 三条链路）

> team-lead 的判断正确：`buildUserListInfoFull`（`sync/listEvent.ts:6-15`）是**显式枚举字段**，新字段默认不会进同步包，必须显式加。

| # | 链路 | 文件:行号 | 现状 | 改动 |
|---|---|---|---|---|
| 1 | **本地保存** | `src/utils/listManage.ts:31-55` `createUserList` | 显式列举 `{name,id,source,sourceListId,locationUpdateTime}`（`:39-45` / `:47-53` 两处） | 两处对象均加 `isAudioNovel` |
| 2 | **本地更新** | `src/utils/listManage.ts:57-79` `updateList` | `:76` `userLists.splice(index,1,{...userLists[index], name, source, sourceListId, locationUpdateTime})` | 加 `isAudioNovel`（保留原值：`...userLists[index]` 已含，但显式覆盖需带上） |
| 3 | **列表创建入口** | `src/utils/listManage.ts:139-156` `userListCreate` | `:148-154` 构造 `newList` | 加 `isAudioNovel` |
| 4 | **overwrite 入口** | `src/core/list.ts:100-121` `overwriteList` | `:110-116` 只透传 `{name,id,source,sourceListId,locationUpdateTime}` | 加 `isAudioNovel` |
| 5 | **sync 打包** | `src/plugins/sync/listEvent.ts:6-15` `buildUserListInfoFull` | 显式返回 6 字段 | **加 `isAudioNovel: listInfo.isAudioNovel ?? false`** |
| 6 | **sync 覆盖落库** | `src/plugins/sync/listEvent.ts:32-34` `setLocalListData` → `list_data_overwrite` | 经 `listEvent.ts:78-93` → `listDataOverwrite`(`listManage.ts:107-137`) → `overwriteUserList`(`:88-90`) | `listDataOverwrite` 里 `userList.map(({list, ...listInfo}) => ...)`（`listManage.ts:110`）已是**展开透传**，新字段自动保留 ✅ |
| 7 | **读取默认值** | 所有消费处 | 无 | 一律 `!!list.isAudioNovel`（老数据 undefined → false），**禁止**直接用可能为 undefined 的值做分支以外的用途 |

> **验证点**：`listDataOverwrite`（`listManage.ts:107-137`）用 `{list, ...listInfo}` 展开，新字段天然透传（第 6 项）；而 `createUserList`/`updateList`/`userListCreate`/`overwriteList`/`buildUserListInfoFull` 都是**显式枚举**（第 1-5 项），必须逐处补字段——**漏一处即丢字段**，这是本改动的头号风险。

### 历史记录本身的 sync 隔离（保留原洞察）

- 历史数据存独立键 `@audio_novel_history`，**不在** `getLocalListData`（`sync/listEvent.ts:17-30`）的采集范围（它只采 `defaultList/loveList/userList 内的歌`），→ 历史零侵入。
- `isAudioNovel` 是**属于歌单的元数据**，随歌单同步是**期望行为**（用户换设备后歌单标记一致）。这与「历史不接 sync」不矛盾。

### 开关 UI

- 在歌单「重命名/更多」菜单（`Mylist/MyList/ListMenu.tsx`）加一项「设为有声小说」复选，调用 `updateUserList([{...info, isAudioNovel: v}])`（`core/list.ts:34-36`）。**待设计师出交互稿**（团队协作点）。
- 颜色/图标：走 theme token + IcoMoon 现有名，见 §9 坑 #8/#9。

---

## 15.4 QA 两项正面回应

### QA P0-2：切歌时必须 cancel pending 节流 + 以切歌时刻进度 flush

**问题确认**：`playProgress.ts:59-63 clearUpdateTimeout` 只 `BackgroundTimer.clearInterval`，**不清** pending 的 `throttleBackgroundTimer`（`tools.ts:419-430` 那个 `setTimeout` 句柄）。若历史节流器照抄，会出现「切歌后旧任务延迟 2s 用新歌状态回写」的脏写。

**对策（历史节流器自持 cancel/flush）**——`core/audioNovelHistory.ts` 内**不用**现成的 `throttleBackgroundTimer`，改为自建可 cancel/flush 的节流器：

```ts
let pendingTimer: number | null = null
let hasPending = false

const flush = () => {                 // 立即落库当前进度缓存
  if (pendingTimer != null) { BackgroundTimer.clearTimeout(pendingTimer); pendingTimer = null }
  const dirty = hasPending
  hasPending = false
  if (dirty) void saveAudioNovelHistory()   // 写 @audio_novel_history
}

const scheduleFlush = () => {         // 2s 节流
  hasPending = true
  if (pendingTimer != null) return
  pendingTimer = BackgroundTimer.setTimeout(() => { pendingTimer = null; flush() }, 2000)
}
```

**切歌时序（`onMusicToggled` 内）**：
1. **先 flush 上一首**：`flushProgressForPrev(prevListId, playerState.progress)` —— 但注意 `playInfo.ts:126` 已在 `setProgress(0,0)` 重置了 progress！**这是坑 #1 的延伸**。
2. **修法**：历史模块**自己缓存**「上一 tick 的 progress」（在 `playProgressChanged` 监听里持续更新 `lastProgress`），切歌时用缓存值，而非读已被重置的 `playerState.progress`。
3. `flush()` 清 pending 并落库；再 `upsert(新记录)` + `scheduleFlush()`。

> 结论：**自持 cancel/flush 节流器 + 独立 progress 缓存**，双管齐下解决「脏写」与「切歌瞬间进度归零」两个问题。

### QA A-4：歌单删除后的历史悬空引用

**级联清理策略（读侧降级 + 写侧清理双保险）**：

1. **读侧降级（必须，防崩溃）**：续播入口先校验 `listId` 是否仍存在 —— 通过 `getListMusicSync(listId)`（`listManage.ts:200-202`，O(1) 查内存 Map）或 `getUserLists()` 判存在。不存在 → 条目置灰 + 点击提示「歌单已删除」，**不调用** `playList`（避免 `getList(...)[index]` 为 undefined 传进 `setPlayMusicInfo` 造成异常）。
2. **写侧清理（可选，保持整洁）**：挂 `global.list_event.on('list_remove', ...)`。发射点证据：`src/event/listEvent.ts:117-125` `list_remove(ids)` → `:121 this.emit('list_remove', ids, isRemote)`。监听回调内对历史缓存 `filter(r => !ids.includes(r.listId))` 并落库。

> 补充：`list_data_overwrite`（`listEvent.ts:78-93`，sync 覆盖场景）会删列表但**不发** `list_remove`。若走写侧清理，需**同时**挂 `'list_data_overwrite'`（`:91` 发射）对比新旧 id 集清理；或**仅依赖读侧降级**（更稳、更省）。**推荐：读侧降级为主（必做），写侧清理为可选优化。**

---

## 15.5 `formatRelativeTime` 工具 — 项目已存在等价实现（重要纠正）

> 设计师提出「项目缺此工具」——**经核查，项目已有**，无需新增。

**证据**：`src/utils/index.ts:174-185` 已实现 `dateFormat2(time)`：
```ts
export const dateFormat2 = (time: number): string => {
  let differ = Math.trunc((Date.now() - time) / 1000)
  if (differ < 60)      return global.i18n.t('date_format_second', { num: differ })
  else if (differ < 3600)  return global.i18n.t('date_format_minute', { num: Math.trunc(differ / 60) })
  else if (differ < 86400) return global.i18n.t('date_format_hour',   { num: Math.trunc(differ / 3600) })
  else return dateFormat(time)   // 超过 1 天显示具体日期
}
```
- i18n 键已备：`zh-cn.json:36-38`（`date_format_hour/minute/second`）、`en-us.json:36-38`、`zh-tw.json` 同构。
- 语义完全匹配需求 2「最近播放时间」的展示。

**结论**：历史条目时间直接用 `dateFormat2(item.updateTime)`（从 `@/utils` 引入）。**不新增工具、不新增 i18n 键**（符合 P0 不过度设计）。若产品要求「今天/昨天」措辞，再评估扩展（当前 out-of-scope）。

---

## 15.6 第二轮变更文件清单（最终版）

**新增**：
- `src/core/audioNovelHistory.ts`（含自持 cancel/flush 节流器 + progress 缓存）
- `src/screens/Home/Views/Mylist/PlayHistory/index.tsx`
- `src/screens/Home/Views/Mylist/PlayHistory/ListItem.tsx`

**修改**：
- `src/config/constant.ts`（+`audioNovelHistory` 键）
- `src/types/player.d.ts`（+`AudioNovelHistoryItem` / `AudioNovelHistoryList`）
- `src/types/list.d.ts`（+`UserListInfo.isAudioNovel?`）
- `src/utils/data.ts`（+历史 CRUD + key 常量）
- `src/utils/listManage.ts`（`createUserList`/`updateList`/`userListCreate` 透传 `isAudioNovel`，共 4 处对象）
- `src/core/list.ts`（`overwriteList` 透传 `isAudioNovel`）
- `src/plugins/sync/listEvent.ts`（`buildUserListInfoFull` +`isAudioNovel`）
- `src/screens/Home/Views/Mylist/index.tsx`（+「播放历史」分段入口）
- `src/screens/Home/Views/Mylist/MyList/ListMenu.tsx`（+「设为有声小说」开关，**待设计师交互稿**）

**禁止修改**：`src/core/init/player/playProgress.ts`、`src/core/player/playInfo.ts`、`src/core/player/player.ts`。

> 注：`src/plugins/sync/listEvent.ts` 由「禁止修改」调整为「**必须修改 1 行**」——这是 team-lead 裁决要求（字段透传），已消除原隔离结论的冲突。

---

## 15.7 第二轮风险更新

| 风险 | 状态 | 说明 |
|---|---|---|
| 冲突 1 冷启动误记 | ✅ 已闭环 | 守卫 1（`restorePlayInfo`）依靠同步调用顺序结构性生效（§15.1） |
| 冲突 3 sync 字段丢失 | ✅ 已闭环 | 7 条链路逐处透传（§15.3）；头号风险＝`createUserList`/`updateList` 等**显式枚举处漏补** |
| QA P0-2 节流脏写 | ✅ 已闭环 | 自持 cancel/flush 节流器 + 独立 progress 缓存（§15.4） |
| QA A-4 悬空引用 | ✅ 已闭环 | 读侧降级（必做）+ 写侧清理（可选）（§15.4） |
| 新增：老数据无 `isAudioNovel` | 低 | 一律 `!!list.isAudioNovel` 真值判断，默认 false |
| 新增：`list_data_overwrite` 不发 `list_remove` | 低 | 写侧清理若做需同时挂两个事件；推荐仅读侧降级 |

---

# 16. 第三轮修正响应（事件异步语义返工）

> **承认错误**：§15.1 的「同步时序结构性保证」结论**错误**。我验证了 `setPlayMusicInfo → musicToggled` 的调用顺序，但**遗漏了 `emit` 内部的 `setImmediate` 这一 macrotask 边界**。QA 的推翻成立，team-lead 的复核成立。本节返工 B-1 / B-2，并回应 R-3 / R-4 / R-7 / R-8。

## 16.0 根因确认（附铁证）

**证据 `src/event/Event.ts:24-33`**：
```ts
emit(eventName: string, ...args: any[]) {
  setImmediate(() => {                    // ← 监听器延迟到下一个 macrotask
    let targetListeners = this.listeners.get(eventName)
    if (!targetListeners) return
    for (const listener of targetListeners) listener(...args)
  })
}
```
- `AppEvent extends Event`（`appEvent.ts:17`），`musicToggled()` 走同一 `emit`（`appEvent.ts:43-45`）。
- `StateEvent extends Event`（`stateEvent.ts:18`）同理——**所有事件监听器都是异步的**。

**修正后的冷启动真实时序（macrotask 边界）**：
```
━━━ 同步栈（macrotask #0）━━━
playInfo.ts:13   global.lx.restorePlayInfo = info        （非空）
playInfo.ts:15   await playList(...)
  player.ts:291  setPlayListId → stateEvent.playInfoChanged → emit → 投递 task-A
  player.ts:292  setPlayMusicInfo
     playInfo.ts:123  playerActions.setPlayMusicInfo → state.playMusicInfo = {新}（同步替换）
     playInfo.ts:126  setProgress(0,0) → action.setProgress:58 → state.progress={0,0}
                       → emit playProgressChanged → 投递 task-B   ◄── 排队早于 task-C
     playInfo.ts:135  global.app_event.musicToggled() → emit → 投递 task-C
  player.ts:295  await handlePlay()
     player.ts:245  命中恢复分支
     player.ts:247  global.lx.restorePlayInfo = null       ◄── 同步栈内已清空
     player.ts:248  return
━━━ 同步栈结束，进入 macrotask 队列 ━━━
task-A 执行：playInfoChanged 监听器
task-B 执行：playProgressChanged 监听器（progress={0,0}）
task-C 执行：musicToggled 监听器 → 此刻 restorePlayInfo==null ◄── §15.1 守卫【失效，误记】
```
**结论**：§15.1 守卫 1 无效，**B-1 必须重建**。且 **task-B 先于 task-C**，意味着 `lastProgress` 已被清 0 —— **B-2 同源洞成立**。

---

## 16.1 B-1【P0】冷启动禁记机制重建 —— 采纳「方案 X 变体：启动恢复窗口 bootGuard」

### 方案对比

| 方案 | 机制 | 覆盖冷启动 | 秒退场景 | 可证明性 |
|---|---|---|---|---|
| §15.1 守卫 1 | `if (restorePlayInfo) return` | ❌ 失效（回调执行时已 null） | — | ❌ |
| Y | 首条记录需 `nowPlayTime > 0` | ⚠️ 部分（恢复到 time>0 时**仍会误记**） | ❌ 秒退丢记录 | ⚠️ |
| **X 变体（采纳）** | **启动恢复窗口 bootGuard** | ✅ | ✅ 与秒退无关 | ✅ |

### 为何否决方案 Y

方案 Y（`nowPlayTime > 0`）有两个硬伤：
1. **误记**：若上次 SavedPlayInfo 的 `time > 0`（用户就是播到一半退出的），冷启动 `handleRestorePlay`（`player.ts:162`）会 `setProgress(restorePlayInfo.time, ...)`，进度**非 0** → 方案 Y 放行 → **仍然误记**。Y 只挡住了 `time==0` 的冷启动。
2. **秒退丢记录**：用户点一集、播 1 秒就退出，进度可能仍未写入 → Y 会丢。权衡后 **Y 不可靠**。

### 采纳方案 X 变体：bootGuard（不依赖 `restorePlayInfo` 生命周期）

**核心**：一个**显式的启动恢复窗口标志**，由**恢复模块自己**在**已知恢复完成**后关闭——不依赖任何事件的同步/异步时序假设。

**注入点（新增可写标志）**：在 `global.lx`（`types/app.d.ts:18-60` `GlobalData`）新增 `isRestoringPlay: boolean`。

```ts
// core/init/player/playInfo.ts（恢复入口，改法示意）
export default async(setting: LX.AppSetting) => {
  const info = await getPlayInfo()
  global.lx.restorePlayInfo = null
  if (!info?.listId || info.index < 0) return

  const list = await getListMusics(info.listId)
  if (!list[info.index]) return
  global.lx.restorePlayInfo = info

  global.lx.isRestoringPlay = true          // ← 开窗（在 playList 之前）
  try {
    await playList(info.listId, info.index)  // 这里会投递 musicToggled（task-C，异步执行）
    // 关键：等一个 macrotask，确保 task-C 已执行完，再关窗
    await new Promise<void>(resolve => setImmediate(resolve))
  } finally {
    global.lx.isRestoringPlay = false        // ← 关窗
  }

  if (setting['player.startupAutoPlay']) setTimeout(play)
}
```

**历史监听器**：
```ts
const onMusicToggled = () => {
  if (global.lx.isRestoringPlay) return      // ← B-1 守卫：窗口内不记
  ... // B-2 / R-7 见下
}
```

### 为何 X 变体在异步语义下**可证明**成立

1. `playList`（`player.ts:289`）在**同步栈内**调用 `setPlayMusicInfo` → `emit` → 投递 task-C（`Event.ts:25 setImmediate`）。此时 `isRestoringPlay===true`。
2. `playList` 返回后，`await new Promise(r => setImmediate(r))` 让出一次回调。由于投递与关窗**走同一 `setImmediate` 实现、同一队列且 FIFO**，先前投递的 task-C **必定先于本次 resolve 回调执行**。
3. task-C 内 `isRestoringPlay` 仍为 `true`（关窗在其后）→ 守卫拦下。✅
4. 之后 `finally` 关窗。用户后续任何真实切歌都 `isRestoringPlay===false` → 正常记录。✅

> **反例覆盖**：① 不重启，用户直接点歌 → `isRestoringPlay` 从未置 true → 正常记。② `startupAutoPlay` 开/关均不影响：`play()`（`player.ts:597-604`）**不触发 musicToggled**（QA 已确认），且开窗/关窗都在 `playList` 前后完成，`setTimeout(play)` 在其后。③ 冷启动 `time>0` 也拦（不依赖进度值）。✅

> **⚠️ 机制更正（见 §17.2 / R-V1-1）**：上文的「让出一个完整 macrotask」表述**不准确**。RN 0.73.11 + Hermes（`android/gradle.properties:41 hermesEnabled=true`）下，`setImmediate` 被 polyfill 为 **`queueMicrotask`**（`Libraries/Core/Timers/immediateShim.js`）——是 **microtask 而非 macrotask**。方案**仍然成立**，正确依据是「`emit` 投递与关窗 `setImmediate` **同一实现、同一队列、FIFO**」，而非 macrotask 语义。**依据的更正不可省略**（结论对依据错最危险）。

---

## 16.2 B-2【P0】`lastProgress` 缓存带「歌曲身份校验」—— 修复同源洞

### 问题复现（macrotask 边界）

`playInfo.ts:126 setProgress(0,0)` → `action.ts:65 emit playProgressChanged`（投递 task-B）**早于** `musicToggled`（task-C）。task-B 执行时，历史监听器若**无条件**用 `{0,0}` 覆盖 `lastProgress`，则 task-C（切歌 flush）读到的是 `0` → **写坏上一首进度**。

### 修复：缓存带身份 + 忽略重置事件

> ⚠️ **本节代码已被 §17.1 修正**：下面 §16.2 初版的身份校验 `if (!curId || curId !== playerState.musicInfo.id) return` 是**恒等死代码**（`curId` 与右值同源），已在 §17.1 删除并改为「`musicToggled` 快照 musicId 作权威身份」。此处保留原始推演仅供追溯，**以实现以 §17.1 为准**。

```ts
// core/audioNovelHistory.ts  —— §16.2 初版（⚠️ 含已废弃的恒等校验，勿直接实现）
let cachedMusicId: string | null = null
let cachedProgress = 0
let cachedMaxTime = 0

// 订阅进度事件（异步，但内部自洽）
global.state_event.on('playProgressChanged', (progress) => {
  const curId = playerState.musicInfo.id        // 当前曲目身份
  // (a) 忽略「重置事件」：setProgress(0,0) 的特征是两者同时为 0
  if (progress.nowPlayTime === 0 && progress.maxPlayTime === 0) return
  // (b) 身份校验：仅缓存与当前曲目一致的进度
  if (!curId || curId !== playerState.musicInfo.id) return   // ⚠️ 恒等死代码，§17.1 已删
  cachedMusicId = curId
  cachedProgress = progress.nowPlayTime
  cachedMaxTime = progress.maxPlayTime
})
```

> ⚠️ 仔细推敲 (a)/(b) 与 task 顺序的交互：
> - 冷启动 task-B（`{0,0}`）→ 被 (a) 忽略 → `cachedMusicId` 保持上一轮值（或 null）。**但此时不 flush，无副作用**。
> - 真实播放中，task-B 携带递增进度 → 正常缓存。
> - **关键陷阱**：`setProgress(0,0)` 后，若新歌是**同一 id**（单曲循环/重播），(b) 无法区分「同曲重播重置」与「正常进度」。此时 (a) 兜底忽略 → 正确（重置不应覆盖）。

### 切歌 flush 用缓存 + 身份

```ts
const onMusicToggled = () => {
  if (global.lx.isRestoringPlay) return
  // 先 flush 上一首：用【缓存身份】而非 playerState（后者已被新歌替换）
  if (cachedMusicId && cachedProgress > 0) {
    flushProgress(cachedMusicId, cachedProgress, cachedMaxTime)  // 写 @audio_novel_history
  }
  const { musicInfo, listId, isTempPlay } = playerState.playMusicInfo  // ← R-7：这里仍需快照，见 §16.4
  ...
  cachedMusicId = null; cachedProgress = 0; cachedMaxTime = 0   // 复位
}
```

> **诚实标注**：此方案对「**同一曲目在 `musicToggled` 前被 `setProgress(0,0)` 重置**」的区分，依赖 (a) 的「双零」特征。若某曲真实时长为 0（`maxPlayTime==0`）且进度也为 0，会误判为重置而忽略 —— **极端但无害**（0 进度本就不值得记）。**待验证**：是否存在 `maxPlayTime` 长期为 0 的音频小说集（建议 QA 覆盖「加载中切歌」场景）。

---

## 16.3 R-7【P1】监听器必须快照上下文（架构级修正）—— 采纳「扩展 musicToggled 携带参数」

### 问题确认

`action.ts:20` `state.playMusicInfo = { listId, musicInfo, isTempPlay }` —— **同步整体替换**。因 `emit` 异步，同一同步栈内连续两次 `setPlayMusicInfo(A)`→`setPlayMusicInfo(B)`，会投递 task-C1/C2；两回调执行时读到的 **都已是 B** → **A 漏记**。

### 调用面评估（证明改动可控）

`musicToggled` 发射点**全项目仅 1 处**：`playInfo.ts:135`（无参）。监听点 4 处（`lyric.ts:62` / `playerEvent.ts:137` / `playProgress.ts:177` / `preloadNextMusic.ts:64`），**全部为无参处理器**（`stop` / `handleSetPlayInfo`）。因 `emit` 用 `...args` 透传，**新增参数向后兼容**——老监听器忽略多余实参即可。

### 采纳方案：扩展事件签名携带快照

```ts
// src/event/appEvent.ts:43-45  改法
musicToggled(snapshot?: LX.Player.PlayMusicInfo & { playIndex: number }) {
  this.emit('musicToggled', snapshot)
}

// src/core/player/playInfo.ts:135 附近  改法（唯一调用点）
global.app_event.musicToggled({
  musicInfo: playerState.playMusicInfo.musicInfo!,
  listId: playerState.playMusicInfo.listId!,
  isTempPlay: playerState.playMusicInfo.isTempPlay,
  playIndex: playerState.playInfo.playIndex,   // 此时已由 :132-134 算好
})
```

历史监听器改用**事件参数快照**，**不再读全局 state**：
```ts
global.app_event.on('musicToggled', (snapshot?: Snapshot) => {
  if (global.lx.isRestoringPlay) return
  if (!snapshot) return
  const { musicInfo, listId, isTempPlay, playIndex } = snapshot   // ← 快照，免疫 R-7
  if (!musicInfo || !listId || isTempPlay) return
  ...
})
```

**时序证明（R-7）**：快照在 `emit` **调用点同步构造**（`playInfo.ts:135` 实参），随 `setImmediate` 闭包**按值捕获**（对象引用）。两次连续切歌 → 两个独立快照对象 → task-C1/C2 各自拿到 A/B 的**正确快照**。✅

> **影响面**：仅新增 1 个可选参数、改 1 个调用点、改 1 个事件签名；4 个既有监听器无需改（忽略多余参数）。**不改变 `handleSetPlayInfo` 等既有行为**（它们仍用 `playerState`）。
> **待验证**：`playInfo.ts:135` 处 `playInfo.playIndex` 是否 100% 就绪（`playInfo.ts:132-134` `updatePlayIndex` 在 `musicToggled()` 之前同步执行——**已确认同步，成立**）。musiInfo 可能为 null（`:128` 分支不 emit），故快照仅在有 musicInfo 时构造。

---

## 16.4 R-3【P1】降级行为的可断言契约

### 契约定义（续播入口）

```
入口：onPressHistoryItem(record)

1. 判定存在性：
   const list = getListMusicSync(record.listId)     // listManage.ts:200-202，O(1)
   const music = list.find(m => m.id === record.musicId)  // 以 musicId 定位（跨会话稳定）

2. 三种结果（可断言的返回结构）：
   type ResumeResult =
     | { ok: true }                                          // 正常进入
     | { ok: false, reason: 'list_missing' }                 // 歌单已删
     | { ok: false, reason: 'music_missing' }                // 集已从歌单移除

   • list.length === 0            → { ok:false, reason:'list_missing' }
   • music == undefined           → { ok:false, reason:'music_missing' }
   • 否则                          → playList(listId, list.indexOf(music))
                                    + setProgress(record.progress, record.maxTime)  // appEvent.ts:51
                                    → { ok:true }

3. 失败分支 UI：
   • toast(global.i18n.t('audio_novel_history_item_invalid'))    // 新增 i18n key
   • 条目保持展示但置灰 + 显示失效标记（见 R-4）
   • 不删除历史记录（删除交给用户主动操作，见 R-4）
```

### 需新增的 i18n key（3 语言）

| key | zh-cn | en-us | zh-tw |
|---|---|---|---|
| `audio_novel_history_item_invalid` | `作品或章节已删除` | `Work or chapter removed` | `作品或章節已刪除` |
| `audio_novel_history_empty` | `暂无播放历史` | `No play history yet` | `暫無播放歷史` |
| `audio_novel_history_clear_confirm` | `确定清空全部播放历史？` | `Clear all play history?` | `確定清空全部播放歷史？` |

> 位置：与现有键同段追加于 `src/lang/zh-cn.json` / `en-us.json` / `zh-tw.json`。

### 是否删除历史记录？

**默认：不自动删**（避免用户「暂时删歌单又加回」时丢失历史）。删除能力交给 R-4 的显式清理入口。

---

## 16.5 R-4【P1】悬空引用：失效可视标记 + 清理入口（补强 A-4）

QA 裁定正确：仅读侧降级会让死条目**永久置灰、无限累积**。补两块：

### (1) 失效可视标记

- 渲染期判定：`const isValid = getListMusicSync(r.listId).some(m => m.id === r.musicId)`
- 失效条目：文字降透明度（`theme['c-font-label']`）+ 图标后缀（IcoMoon 现有名 `help` 或 `remove`，见 §9 坑 #8）+ 文案 `audio_novel_history_item_invalid`
- 点击失效条目：不播放，仅 toast 提示（§16.4）

### (2) 清理入口

- 历史页顶部操作区提供「清理失效条目」按钮 → `audioNovelHistory.purgeInvalid()`：
  ```ts
  const purgeInvalid = () => {
    const cache = getCacheSync()
    for (let i = cache.length - 1; i >= 0; i--) {
      const r = cache[i]
      if (!getListMusicSync(r.listId).some(m => m.id === r.musicId)) cache.splice(i, 1)
    }
    scheduleFlush()
  }
  ```
- **可选增强（写侧，非必须）**：挂 `global.list_event.on('list_remove', ids => ...)`（发射点 `event/listEvent.ts:121`）级联删除。**但注意** `list_data_overwrite`（`:91`，sync 覆盖）删列表**不发** `list_remove`，故写侧不完整——**主推读侧标记 + 手动清理**，写侧仅作可选优化（此结论与 §15.4 一致）。

> **性能**：渲染期 `getListMusicSync` 为 O(1) Map 查（`listManage.ts:200-202`），再对每个条目 O(list) 扫描；500 条 × 列表长度，可接受。若列表超大，可改为渲染时只查 `listId` 存在性、点击时再查 `musicId`（**advisory**）。

---

## 16.6 R-8【P2】自持节流器的单次注册 guard + teardown

### 问题确认

`Event.on` **不去重**（`Event.ts:10-14`：`targetListeners.push(listener)`）——模块若被重复初始化，会重复注册监听 + 各持一份 timer → 重复写库/泄漏。

### 修复：模块级 inited guard + teardown

```ts
// core/audioNovelHistory.ts
let inited = false
let pendingTimer: number | null = null
const progressListener = (progress) => { /* §16.2 缓存逻辑 */ }
const toggledListener = (snapshot) => { /* §16.1/16.3 守卫+快照逻辑 */ }

export const initAudioNovelHistory = () => {
  if (inited) return                 // ← 单次注册
  inited = true
  global.state_event.on('playProgressChanged', progressListener)
  global.app_event.on('musicToggled', toggledListener)
}

export const destroyAudioNovelHistory = () => {   // teardown（对齐 playProgress.ts:99-112 的 clear 惯例）
  if (!inited) return
  inited = false
  global.state_event.off('playProgressChanged', progressListener)
  global.app_event.off('musicToggled', toggledListener)
  if (pendingTimer != null) { BackgroundTimer.clearTimeout(pendingTimer); pendingTimer = null }
}
```

- **注册点**：`src/core/init/player/index.ts:20-21`，在 `initPlayProgress()` **之后**新增一行 `initAudioNovelHistory()`（已确认该文件是 `core/init/` 的播放模块初始化链）。
- **teardown**：应用退出（`core/common.ts:53-65 exitApp`）或热重载时调用，防泄漏。
- **参照**：`playProgress.ts:59-63`（clearInterval 惯例）、`preloadNextMusic.ts:66`（`state_event.on` 注册范例）。

---

## 16.7 第三轮端到端验证补充（供 QA 复验）

在 §12 基础上新增**异步语义专测**：

1. **B-1 冷启动禁记**：
   - 先播 A 歌单第 3 集 → 杀 App → 冷启动（**且上次进度 time>0**）→ 断言 `getAudioNovelHistory()` **不含 A**（验证 bootGuard 而非进度值）。
   - 冷启动后**再手动切一集** → 断言历史**正常出现**（验证关窗生效）。
2. **B-2 切歌 flush**：
   - 播 A 第 1 集到 00:30 → 切到第 2 集 → 断言历史里**第 1 集 progress≈30**（非 0）。
3. **R-7 连续切歌**：
   - 同一同步栈内（如批量点歌 / 自动化脚本）连续 `playList(A)` → `playList(B)` → 断言历史**A、B 均正确各自记录**（A 不漏不串）。
4. **R-3 降级**：删除歌单后点其历史 → 断言返回 `reason:'list_missing'` + toast + 不崩溃。
5. **R-4 清理**：制造失效条目 → 点「清理失效条目」→ 断言列表相应减少。
6. **R-8 注册**：调用 `initAudioNovelHistory()` 两次 → 断言监听器仅 1 份（可临时打点计数）。

---

## 16.8 第三轮诚实标注（待验证项）

| 项 | 状态 | 验证方式 |
|---|---|---|
| `setImmediate` FIFO（B-1 关窗顺序） | **待验证** | §16.7-1；RN JSTimers 同队列 FIFO 为预期行为，但需运行时断言 |
| 曲目真实时长长期为 0 的集（B-2 双零误判） | **待验证** | 造「加载中切歌」场景 |
| `musicToggled` 加参数对 4 个既有监听器无副作用 | **待验证** | 现有监听器均无参（已读 `lyric.ts:62`/`playerEvent.ts:137`/`playProgress.ts:177`/`preloadNextMusic.ts:64`），编译期无报错即证；运行时回归播放/歌词/预加载 |
| 模块初始化调用点位置 | **已确认** | `src/core/init/player/index.ts:20-21`（`initPlayProgress()` 之后），新增 `initAudioNovelHistory()` |

## 16.9 第三轮变更文件清单（差异部分）

在 §15.6 基础上**新增/变更**：
- `src/event/appEvent.ts:43-45` —— `musicToggled(snapshot?)` **改签名**（新增，R-7）
- `src/core/player/playInfo.ts:135` —— **改调用点**（传快照参数；这是 §15.6「禁止修改」的**豁免**，因 R-7 强制要求）
- `src/core/init/player/playInfo.ts:6-17` —— **改恢复入口**（开关 bootGuard 窗口 + `setImmediate` 等待；§15.6「禁止修改」的**豁免**）
- `src/types/app.d.ts:18-60` `GlobalData` —— 新增 `isRestoringPlay: boolean`
- `src/core/init/player/index.ts:20-21` —— 新增 `initAudioNovelHistory()` 调用（R-8 注册点）
- `src/lang/{zh-cn,en-us,zh-tw}.json` —— 新增 3 个 i18n key
- `src/core/audioNovelHistory.ts` —— 补 inited guard / teardown / 身份缓存 / 快照消费 / purgeInvalid

> **注**：§15.6 原「禁止修改 `core/init/player/playProgress.ts`、`core/player/playInfo.ts`、`core/player/player.ts`」中，**`core/player/playInfo.ts` 与 `core/init/player/playInfo.ts` 本次豁免**（B-1/R-7 强制）。`playProgress.ts`、`player.ts` 仍禁止修改。

---

# 17. 第四轮收尾修正

> 回应 team-lead 转达的 QA 第三轮 3 项 P1 + R-V1-1。**P0 已归零，本节为进开发前最后收尾**。所有结论附 `文件:行号`。

## 17.1 P1-1【必改】B-2 身份校验是恒等死代码 —— 已修正

### 问题确认（我复核属实）

§16.2 代码 `ARCHITECTURE.md:833/837`：
```ts
const curId = playerState.musicInfo.id                // :833
if (!curId || curId !== playerState.musicInfo.id) return   // :837  ← 自己和自己比，恒 false
```
`curId` 与右值同为 `playerState.musicInfo.id` → 比较恒假 → **校验永不触发 = 伪装成防御的死代码**。QA 复刻用例（旧歌 A 进度事件晚到、当前已是 B）实测 `cached 最终 = B @ 31`，校验没拦住。**确认成立，必须删除。**

### 方案选择：采纳 ②（删死校验 + 配 `musicToggled` 快照 musicId + 覆盖 `setMaxplayTime` 缺口）

**否决 ①**（扩展 `playProgressChanged` 带 musicId）：需侵入 `store/player/action.ts` 的 `setNowPlayTime`(:44) / `setMaxplayTime`(:51) / `setProgress`(:58) **三处**，且 `playProgressChanged` 有既有消费者（`preloadNextMusic.ts:56-66`、`hook.ts:79`），改签名回归面更大。**收益低、成本高，否决。**

**采纳 ② 的核心洞察**：**缓存不依赖「进度事件自带身份」，而是用 `musicToggled` 快照的 musicId 作为权威身份**，进度只做「配对数值」。

### 修正后的 B-2 实现

```ts
// core/audioNovelHistory.ts
let cachedMusicId: string | null = null   // 权威身份：来自 musicToggled 快照
let cachedProgress = 0
let cachedMaxTime = 0

// 进度事件只更新【数值】，不承担身份判定（避免恒等死代码）
global.state_event.on('playProgressChanged', (progress) => {
  // (a) 忽略 setProgress(0,0) 重置事件（playInfo.ts:126 切歌前重置的特征）
  if (progress.nowPlayTime === 0 && progress.maxPlayTime === 0) return
  // (b) 无当前曲目时不缓存（避免给 null 身份挂数值）
  if (!cachedMusicId) return
  cachedProgress = progress.nowPlayTime
  cachedMaxTime = progress.maxPlayTime
})

// musicToggled 快照提供权威身份；切歌时先 flush 上一首
const onMusicToggled = (snapshot) => {
  if (global.lx.isRestoringPlay) return
  // 先 flush 上一首：身份用 cachedMusicId（权威），进度用 cachedProgress/maxTime
  if (cachedMusicId && cachedProgress > 0) flushProgress(cachedMusicId, cachedProgress, cachedMaxTime)
  // 切到新曲：刷新权威身份，进度归零等待新事件
  cachedMusicId = snapshot.musicInfo?.id ?? null
  cachedProgress = 0
  cachedMaxTime = 0
  ...
}
```

### 依赖的真实既有守卫（如实说明，不冒充自研防御）

§16.2 所述「身份校验」实际由 `playProgress.ts` 的既有逻辑承担：
- `playProgress.ts:30` `getCurrentTime` 内 `let id = playerState.musicInfo.id` + `:32` `if (!position || id != playerState.musicInfo.id) return` —— **挡住 `setNowPlayTime` 的越界写入**。证据：`playProgress.ts:29-39`。
- **缺口（QA 指出，成立）**：`getMaxTime`（`playProgress.ts:41-57`）调用 `setMaxplayTime(await getDuration())`（`:42`）**无 id 守卫**。若切歌后旧歌的 `getDuration()` promise 才 resolve，会写入**新歌**的 `maxPlayTime`。

**方案需覆盖该缺口**：由于 `setMaxplayTime`→`playProgressChanged` 携带非零 `maxPlayTime`（`getDuration` 返回时长），(a) 的「双零」拦不住它。**补救**：在 (b) 之后，仅接受 **`maxPlayTime` 与 `nowPlayTime` 组合合理**的事件——但更干净的做法是**依赖 flush 的进度数值本身短时容忍**（`getDuration` 是切歌后一次性调用，旧歌 duration 到达时 `cachedMusicId` 已被新歌覆盖，会把旧歌时长配给新歌身份）。

> **诚实标注（待验证）**：`getMaxTime` 无守卫导致的「旧歌 maxTime 写入新歌身份」在**极端竞态**下可能污染 `cachedMaxTime`，但 **`cachedProgress` 不受影响**（`nowPlayTime` 有守卫），而 `progress` 是需求核心字段、`maxTime` 仅用于进度条比例。**建议 QA 覆盖「切歌瞬间并发 `getDuration` resolve」场景**；若实测污染明显，升级方案 := 在 `playProgress.ts:42` 加 id 守卫（属 §15.6「禁止修改」的**第三处豁免**，需 team-lead 批准）。

---

## 17.2 P1-2【必改】§16.1 机制表述与运行时事实不符 —— 已更正

### QA 的运行时证据（我采纳）

- RN 0.73.11 Hermes 下 `setImmediate` 由 `Libraries/Core/setUpTimers.js` polyfill 为 `immediateShim.setImmediate`
- `Libraries/Core/Timers/immediateShim.js` 实现为 **`global.queueMicrotask(cb)`** → **microtask，不是 macrotask**
- `android/gradle.properties:41 hermesEnabled=true` —— **我已独立验证属实**
- ⚠️ 本地 `node_modules` 未安装（`ls node_modules` 返回 0 项），无法复读 RN 源码；**采信 QA 引用的权威源码路径 + 已确认的 `hermesEnabled=true`**。

### 更正后的机制表述

> **原（错误）**：「让出一个完整 macrotask、靠 macrotask 队列 FIFO」。
> **正（正确）**：`Event.emit` 的投递（`Event.ts:25 setImmediate`）与关窗的 `await new Promise(r => setImmediate(r))` **走同一个 `setImmediate` 实现**（Hermes 下即同一 `queueMicrotask` 队列）；且 `emit` 投递**严格在前**（`playList` 同步栈内投递，关窗 `setImmediate` 在其后注册），**同队列 FIFO** ⇒ 监听器必先于关窗执行 ⇒ bootGuard 命中。

**结论不变、依据已更正**（这正是 team-lead 强调的「结论对但依据错最危险」——已修正）。

### 关窗处加注释锁定依赖

```ts
global.lx.isRestoringPlay = true
try {
  await playList(info.listId, info.index)
  // ⚠️ 依赖锚定：此处必须用 setImmediate（与 Event.ts:25 emit 的投递同实现/同队列），
  //    保证已投递的 musicToggled 监听器先于本回调执行。
  //    【禁止】改为 setTimeout(...,0)：那会进入不同队列（timer vs microtask/immediate），顺序可能反转，导致守卫失效。
  await new Promise<void>(resolve => setImmediate(resolve))
} finally {
  global.lx.isRestoringPlay = false
}
```

### R-V1-1 复核（team-lead 要求我表态）

**无异议，完全同意**：方案正确性**绑定**于「emit 投递与关窗用同一 `setImmediate` 实现」，因此：
1. **加注释锁定**（如上）——已在 §17.2 落实。
2. **加值守测试**（guard test）：设计一条**能感知顺序反转**的测试（例：冷启动恢复后断言历史不含启动曲；若有人把 `setImmediate` 改成 `setTimeout(...,0)` 或改用别的关窗方式，该测试应转红）。测试归属 §16.7-1，标注为**必跑**。

---

## 17.3 P1-3【需改】teardown 挂点措辞不准 —— 已更正

### 问题确认（QA 实读，我复核属实）

§16.6 我写「已确认 teardown 点」，但 `src/core/common.ts:53-65 exitApp` **只调** `hideDesktopLyric()` / `destroyPlayer()` / `hideDesktopLyricView()`（`:58-60`），**无任何播放模块 teardown 惯例**。正确表述应是「**需在 exitApp 新增调用**」。**QA 正确，确认成立。**

### 更正后的措辞 + 新增调用位置

在 `src/core/common.ts:57-61` 的 `Promise.all([...])` 中**新增** `destroyAudioNovelHistory()`：

```ts
void Promise.all([
  hideDesktopLyric(),
  destroyPlayer(),
  hideDesktopLyricView(),
  destroyAudioNovelHistory(),   // ← 新增（§16.6）
]).finally(() => { ... })
```

### 顺序论证：应在 `destroyPlayer()` **之后**（并列执行，逻辑上视为后置）

- 依据：`destroyAudioNovelHistory()` 的职责是 **① off 监听 + ② clearTimeout +（可选）③ 最后一次 flush 落库**。
- ③ 的 flush 依赖「当前进度缓存」而非播放器实例；但**在 `destroyPlayer()` 之后执行**更安全：避免「历史 flush 读取进度」与「播放器销毁重置状态」并发竞争。
- 因 `Promise.all` 是**并列**的，严格先后无法通过排列保证；**建议**：把 `destroyAudioNovelHistory()` 放在 `Promise.all(...)` **之后**单独调用（在 `.finally` 之前），或在其内部**不依赖播放器状态**（只 flush 已有缓存）。**采纳后者**：`destroyAudioNovelHistory()` 内部只做 off/clear + 用缓存 flush，**不读 `playerState`**，从而与销毁顺序**解耦**。

### 是否有更合适的 teardown 时机？

**结论：exitApp 足够，无需额外挂点。** 理由：
- 历史模块的监听器是**长生命周期**的，正常 App 生命周期内**不应**卸载（一旦卸载就不再记录历史，违背功能目标）。
- `AppState` 变化（`playProgress.ts:163` 有先例）用于「息屏/后台」**暂停写入**，**不用于销毁** —— 历史模块无需在后台销毁，仅需在「写库节流」里复用 `isScreenOn` 门控（§6.2）。
- `destroyAudioNovelHistory()` 的**真实价值**在**热重载 / 开发期**防重复注册（R-8），而非运行时常态。故仅挂 `exitApp` 即可。

---

## 17.4 第四轮变更文件清单（差异部分）

在 §16.9 基础上：
- `src/core/audioNovelHistory.ts` —— B-2 **删除恒等死校验**，改为「`musicToggled` 快照 musicId 作权威身份 + 进度事件只更新数值」（§17.1）
- `src/core/init/player/playInfo.ts:6-17` —— 关窗处**加注释锁定 `setImmediate` 依赖**（§17.2）
- `src/core/common.ts:57-61` —— **新增** `destroyAudioNovelHistory()` 到 `Promise.all`（§17.3；措辞由「已有挂点」更正为「新增调用」）
- **潜在第三处豁免（待 QA 实测后决定）**：`src/core/init/player/playProgress.ts:42` 加 id 守卫，覆盖 `getMaxTime` 无守卫缺口（§17.1）

## 17.5 第四轮诚实标注（待验证项）

| 项 | 状态 | 验证方式 |
|---|---|---|
| `getMaxTime` 无守卫导致 `cachedMaxTime` 污染 | **待验证** | 覆盖「切歌瞬间并发 `getDuration` resolve」；若明显则加 `playProgress.ts:42` 守卫（需 team-lead 批准第三处豁免） |
| `setImmediate`=microtask 的 FIFO 依赖（R-V1-1） | **待验证** | §16.7-1 值守测试必跑（改关窗实现应转红） |
| `cachedProgress` 不受 `getMaxTime` 缺口影响 | **已推理成立** | `playProgress.ts:32` 对 `nowPlayTime` 有 id 守卫，`cachedProgress` 仅由带守卫的事件更新 |

## 17.6 给 QA 的收尾确认

三项 P1 均已按要求修正（P1-1 删死代码 + 优化方案、P1-2 更正机制表述 + 加锁定注释、P1-3 更正措辞 + 明确新增调用点）。R-V1-1 我**无异议**并已落实（注释锁定 + 值守测试）。**唯一遗留待验证**：`getMaxTime` 无守卫的 `maxTime` 污染（已给验证方式与升级路径，不阻塞开发——因为 `progress` 核心字段不受影响）。

---

# 18. 第五轮：第三处豁免实施（`getMaxTime` id 守卫）

> team-lead 已批准第三处豁免（`src/core/init/player/playProgress.ts:41-57`）。本节记录实施、QA 实测依据与附加收益验证。

## 18.1 豁免范围（精确边界）

**仅修改 `getMaxTime` 函数（`playProgress.ts:41-57`）**，**不动**该文件其余任何代码（`:13-39` 的进度节流、`:59-181` 的其它逻辑一律不改）。

```ts
// src/core/init/player/playProgress.ts:41-57  改法（镜像既有范式 :30/:32）
const getMaxTime = async() => {
  const id = playerState.musicInfo.id            // ← 新增：快照身份（镜像 :30）
  const duration = await getDuration()
  if (id != playerState.musicInfo.id) return     // ← 新增：越界丢弃（镜像 :32）
  setMaxplayTime(duration)                       // 原 :42 语义不变
  // ... 原 :44-56 完全不变
}
```

> 范式镜像：`playProgress.ts:30`（`let id = playerState.musicInfo.id`）+ `:32`（`if (!position || id != playerState.musicInfo.id) return`）——同一「快照 id → await → 越界丢弃」模式，保持代码风格一致。

## 18.2 QA 第四轮实测依据（team-lead 已独立验证，我采纳）

QA 三场景实测，结论「**非自愈且用户可见**」：

| 场景 | 描述 | 后果 |
|---|---|---|
| A（基础） | `getMaxTime:42` 无守卫写 `maxTime` | 错误值 → 历史缓存 → 持久化 |
| B（滞后污染） | A 的 stale duration 在 B 已累积进度后到达 → 覆盖正确值 | 切 C 时 flush 落库错误 maxTime |
| C（最现实窗口） | 切 B 后仅 1 tick，A stale duration 到达即落库 | 同上 |

**用户可见链条（我复核成立）**：
`getMaxTime:42` 无守卫写 `maxTime` → 历史缓存 → 切歌 flush 持久化 → **重启后**续播 `player.ts:162 setProgress(restorePlayInfo.time, restorePlayInfo.maxTime)` **用错误分母** → 进度条比例错误**且重启仍在**。
- 证据：`player.ts:162` `global.app_event.setProgress(..., restorePlayInfo.maxTime)`；`maxTime` 写入点 `playProgress.ts:42`。

## 18.3 附加收益验证（team-lead 要我确认）—— **结论：成立** ✅

team-lead 指出：`getMaxTime:44-56` 的 `updateListMusics` 会把 **A 的 interval 写到 B 的歌单**。

**验证**（逐行）：
- `playProgress.ts:44` 条件用 `playerState.playMusicInfo.musicInfo`（**当前**歌，切歌后已是 B）
- `:48-49` `updateListMusics([{ id: playerState.playMusicInfo.listId, ... }])` —— 用**当前** listId（B 的）
- `:52` `interval: formatPlayTime2(playerState.progress.maxPlayTime)` —— 用 `maxTime`

**守卫插在 `getMaxTime` 函数体最前（`setMaxplayTime` 之前），`.44-56` 整块在其后** ⇒ 当 `id != playerState.musicInfo.id`（stale）时 **`return` 直接跳过 `:42 setMaxplayTime` 与 `:44-56 updateListMusics` 整块**。

**结论：附加收益成立** —— 该 id 守卫**同时消除**「A 的 interval 被写到 B 歌单」的同类隐患（不仅是 `maxTime` 污染）。

> **精确性说明**：守卫置于 `await getDuration()` **之后**、`setMaxplayTime` **之前**。因此 `getDuration()` 仍会被调用（无法取消已发出的 native promise），但**其后所有副作用（setMaxplayTime + updateListMusics）均被跳过**——这正是修复目标。

## 18.4 R-V1-1 状态更新（QA 自我更正，我确认）

QA 第四轮自行推翻了 R-V1-1 原假设：**四种组合（emit/close 各 micro/macro）守卫全部保持有效，无一反转**（Hermes 下 microtask 恒先于 macrotask 排空）。**R-V1-1 降级为「无实际问题」**。

- **我方处置**：§17.2 的**注释锁定保留**（有文档价值，勿删）；**值守测试不再覆盖「队列反转」场景**（QA 已交付 `guard-setimmediate-order.test.js`，team-lead 实跑通过、退出码 0）。
- **诚实标注**：我此前的「macrotask」表述虽错，但**结论（守卫有效）经 QA 四组合实测仍成立**——即「结论对、依据错」在修正依据后依然稳固。

## 18.5 变更文件清单（第五轮差异）

在 §17.4 基础上：
- `src/core/init/player/playProgress.ts:41-57` —— **第三处豁免，仅 `getMaxTime` 函数**：新增 `const id = playerState.musicInfo.id` + 在 `await getDuration()` 后新增 `if (id != playerState.musicInfo.id) return`；**该文件其余部分（:13-39 / :59-181）一律不动**

> **豁免范围声明**：`playProgress.ts` 的「禁止修改」约束**仅豁免 `getMaxTime` 函数体（:41-57）**。`screens/`、`core/player/player.ts` 等仍维持原约束。

## 18.6 P0/P1 归零声明

| 项 | 状态 |
|---|---|
| B-1 冷启动禁记（bootGuard） | ✅ 闭环（§16.1/§17.2） |
| B-2 lastProgress 缓存（身份+数值分离） | ✅ 闭环（§16.2/§17.1） |
| **B-3 `getMaxTime` 无守卫** | ✅ 闭环（§18.1-18.3，第三处豁免已批准并实施） |
| R-3 降级契约 | ✅ 闭环（§16.4） |
| R-4 悬空引用 | ✅ 闭环（§16.5） |
| R-7 连续切歌快照 | ✅ 闭环（§16.3） |
| R-8 注册 guard + teardown | ✅ 闭环（§16.6/§17.3） |
| P1-1/2/3 | ✅ 闭环（§17） |
| R-V1-1 | ✅ 降级为「无实际问题」（§18.4） |

**结论：P0/P1 全部归零**，架构设计就绪，进入 Phase 1.5（Spec 生成）。
