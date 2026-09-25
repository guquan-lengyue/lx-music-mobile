# 有声小说播放历史 — 测试策略与前置风险审查报告（TEST-PLAN）

> 版本：v0.1（前置审查阶段，开发未开始）
> 项目：洛雪音乐助手移动版（React Native 0.73.11 + TS，仅 Android）
> 审查人：严过关（QA / 独立验证视角）
> 审查对象：architect 勘测结论 + 设计方案
> 纪律声明：**本报告所有风险均附 `文件:行号` 机械证据；无证据的推断一律显式标注「待验证」。**

---

## 0. 审查结论摘要

| 项 | 值 |
|---|---|
| verdict | **fail**（发现 2 个 P0 阻断项，须先修设计再进入开发） |
| P0 阻断 | 2（索引失效 / 映射键不稳定；异步写竞态覆盖） |
| P1 严重 | 5 |
| P2 一般 | 3 |
| 待验证 | 2 |

**核心判断**：架构方案主体可行（复用 `storage.ts` / `playProgress.ts` 节流范式 / `SavedPlayInfo` 续播链路均成立），但**「集数/断点」的记录键选择**与**「切歌并发写」**两处若不修正，将直接导致断点续播错集、历史被脏写——这两条是需求核心（需求 2 断点续播），必须 P0 处理。

---

## 1. 前置风险审查报告

> 格式：`{风险 | 证据(文件:行号) | 严重级 | 期望}`

### A-1【P0】以 `playIndex`（数组下标）作为「集数」记录键 → 歌单增删/排序后必错位

- **证据**：
  - `src/utils/listManage.ts:200-202` `getListMusicSync` 直接返回 `allMusicList.get(id)`，其内部顺序即**可变的数组下标**；
  - `src/utils/listManage.ts:245-256` `listMusicRemove` 删除后 `targetList.splice` 重排，后续元素下标**整体前移**；
  - `src/utils/listManage.ts:287-317` `listMusicUpdatePosition` 与 `listMusicAdd`（`:220-243`）均可改变下标；
  - `src/core/player/playInfo.ts:38-71` `getPlayIndex` 返回的 `playIndex = list.findIndex(m => m.id == currentId)`，**index 是下标语义**；
  - `src/core/player/playInfo.ts:57-64`：`if (playIndex < 0) { playerPlayIndex = ... }` —— 当歌曲已不在列表中时 `playIndex` 返回 **-1**，不抛错、不提示，静默错位。
- **严重级**：**P0**。需求 2「从历史进入跳到对应集」若用 `playIndex` 定位，用户在播放期间对歌单做任意增删/排序，历史里存的 index 就指向**另一集**而非原集，属"沉默逻辑错误"（无报错、结果错）。
- **期望**：历史记录**必须存稳定的 `musicId`（作品集唯一 id）+ `listId`**，续播时用 `musicId` 反查（`list.findIndex(m => m.id == musicId)`）。`playIndex` 只能作为**写入瞬间的辅助字段**，**不得作为持久化定位键**。若查不到（`findIndex < 0`）必须有**显式降级**（见 A-4/用例 T-B-04），禁止沿用 `playInfo.ts:59-60` 的静默兜底逻辑。

### A-2【P0】切歌时「历史写入」与「SavedPlayInfo 写入」并发 → 重复触发 / 互相覆盖 / 旧进度覆盖新进度

- **证据**：
  - `src/core/init/player/playProgress.ts:13-20` `delaySavePlayInfo` = `throttleBackgroundTimer(fn, 2000)`，内部读 `playerState.progress.nowPlayTime` / `playerState.playInfo.playIndex` 并调 `savePlayInfo`（写 `@play_info`）；
  - `src/core/init/player/playProgress.ts:115-128` `handleSetPlayInfo` **无节流**，直接同步调 `savePlayInfo(...)`，同样写 `@play_info`；
  - `src/core/init/player/playProgress.ts:177` `global.app_event.on('musicToggled', handleSetPlayInfo)`；
  - `src/core/player/playInfo.ts:135` `setPlayMusicInfo` 内 `global.app_event.musicToggled()` 在**切歌路径**触发；
  - `src/utils/data.ts:433-435` `savePlayInfo` 最终落 `saveData(playInfoStorageKey, playInfo)`；`src/plugins/storage.ts:46-58` `saveData` 内部流程是 `await removeData(key)` → `await AsyncStorage.multiSet(datas)`（**先删后写，非原子**）。
- **严重级**：**P0**。若在新方案里把「历史写」也挂在 `musicToggled` 或同一节流器上：
  1. `throttle` 与 `handleSetPlayInfo` 的**立即写**会竞争同一个存储 key（若共用）→ 后写覆盖先写，可能出现「新歌的 SavedPlayInfo 被 2 秒前的定时器用旧 `nowPlayTime` 覆盖」；
  2. `saveData` 先 `removeData` 再 `multiSet` 的两步非原子窗口，两路并发写同一 key 时可能产生**读到半删状态**；
  3. `throttleBackgroundTimer` 的 pending 调用**不会在切歌时被 flush/cancel**（`:59-63 clearUpdateTimeout` 只清 interval，不清 `delaySavePlayInfo`）。
- **期望**：
  - **历史存储 key 必须独立**（如 `@audio_novel_history`），**不得复用 `@play_info`**；
  - 历史写入与 `SavedPlayInfo` 写入**解耦到各自的队列/节流器**，且写入前必须**快照当前 `musicId` + `nowPlayTime`**，写完后校验 `musicId` 未变（参考 `playProgress.ts:32` 已有的 `id != playerState.musicInfo.id` 乐观校验范式）；
  - 切歌时必须 **cancel pending 的历史节流任务**并**以切歌时刻的进度为准 flush 一次**（否则丢失最后一段进度 / 旧进度污染新记录）。

### A-3【P1】同一作品重复播放「更新」逻辑：必须按稳定作品键去重，且更新后要重排到列表头

- **证据**：
  - 需求 3 明确「同一作品重复播放更新已有记录 → 列表按最近播放时间倒序」；
  - 现有列表去重范式参考 `src/utils/listManage.ts:223-229` `listMusicAdd` 用 `Set` 按 `id` 去重；历史若按「作品」去重，需定义**作品键**；
  - 项目内 `musicInfo.id` 是「集」级别的 id（每集一个 id），**不是作品级**（见 `src/types/list.d.ts:4` `id: string` 与 `src/core/player/playInfo.ts:57` 所有查找均用 `m.id`）。
- **严重级**：**P1**。若误用 `musicInfo.id`（集 id）当作品键，则「同一作品第 3 集 → 第 5 集」会**生成两条记录**而非更新一条 → 违反需求 3；反之若作品键设计过粗会把不同作品合并。
- **期望**：明确「作品」定义（如 `albumName` + `singer` 组合，或歌单 `listId` 视为一部作品）。审查意见：**以「歌单（listId）≈ 作品」为去重键更稳**，因为有声小说通常整部作品就是一个歌单，且 `listId` 稳定（`src/utils/listManage.ts:31-55` 创建后不变）。此点**须 architect 拍板定义**（→ 待验证项 V-1）。

### A-4【P1】歌单被删除后，历史记录成为悬空引用 → 脏数据 + 续播崩溃风险

- **证据**：
  - `src/core/list.ts:27-29` `removeUserList` → `global.list_event.list_remove(ids)`；
  - `src/event/listEvent.ts:117-125` `list_remove`：`userListsRemove(ids)` → `removeListMusics(ids)` → 广播 `list_remove` / `myListMusicUpdate(changedIds)`；
  - `src/utils/listManage.ts:158-170` `userListsRemove`：只清 `allMusicList` / `listPosition` / `listUpdateInfo`，**无任何"清理关联历史"的钩子**；
  - `src/utils/data.ts:328-340` `removeListMusics`：仅删 `listPrefix + id`，**不触碰任何历史 key**；
  - `src/core/init/player/playInfo.ts:11-12`：续播时 `const list = await getListMusics(info.listId); if (!list[info.index]) return` —— 即**已有代码对"列表已空"做了防御**，但**仅返回不提示**。
- **严重级**：**P1**。历史会残留指向已删歌单的记录；若续播逻辑未防御 `getListMusicSync(deletedListId)` 返回 `[]`（`listManage.ts:200-202` 对不存在 key 返回 `[]`），`list.findIndex` → -1 → 触发 A-1 的静默错位分支。且 UI 会展示已删歌单的历史项，点击无响应/报错。
- **期望**：
  - 监听 `list_remove` 事件（`listEvent.ts:121` 已 emit），**级联清理或标记**对应 `listId` 的历史记录；
  - 续播入口必须校验 `listId` 对应的歌单仍存在且 `musicId` 仍在列表内，否则**显式**降级（提示"作品已不存在，已移除历史" + 从历史删除），禁止静默 `findIndex(-1)`。

### A-5【P1】`UserListInfo` 增加「有声小说开关」字段 → 同步/反序列化向后兼容性

- **证据**：
  - `src/types/list.d.ts:3-11` `UserListInfo` 现有字段：`id / name / source / sourceListId / locationUpdateTime`（均非可选的是 `id`/`name`/`locationUpdateTime`）；
  - `src/utils/data.ts:282-291` `getUserLists`：直接 `getData<UserListInfo[]>` 反序列化，**只对 `sourceListId` 做 `.0` 兼容修复，无字段白名单校验** → 老数据缺新字段会得到 `undefined`（TS 类型不保证运行时）；
  - `src/utils/listManage.ts:57-79` `updateList` / `:31-55` `createUserList`：**显式枚举字段**重建对象（`{ name, id, source, sourceListId, locationUpdateTime }`）→ **新增字段若不在此处透传，会被静默丢弃**（写入后即时丢失！）；
  - `src/event/listEvent.ts:24-27` `updateUserList` → `saveUserList(userLists)` 整体落盘；
  - `src/core/syncSourceList.ts` 与 `src/plugins/sync/listEvent.ts` 存在同步链路（待细读，见 V-2）。
- **严重级**：**P1**。两个具体雷：
  1. **运行时兼容**：老用户数据无 `isAudioNovel` 字段，读取处若 `if (list.isAudioNovel)` 直接判断为假即可（需用真值判断，不能 `=== false` 取反误判）；
  2. **写入丢失**：`listManage.ts:74-76` `userLists.splice(index, 1, { ...userLists[index], name, source, sourceListId, locationUpdateTime })` —— 用 `...userLists[index]` 展开**能保留新字段**（好），但 `createUserList`（`:39-53`）/`updateList` 的**解构参数**（`:57-64` 只解构已列字段）会**丢弃**传入的新字段 → 新建/更新列表时开关可能丢失。
- **期望**：
  - 新字段**必须**在 `listManage.ts` 的 `createUserList` / `updateList` / `userListsUpdatePosition` 全链路显式透传（评审重点）；
  - 定义**默认值**（老数据 = false），读取处用 `!!list.isAudioNovel`；
  - 若走 sync，确认 `src/types/list_sync.d.ts` 的同步 schema 是否需同步扩展（→ V-2）。

### A-6【P1】写入"不阻塞播放"要求 vs `saveData` 先删后写非原子

- **证据**：
  - 需求 5 明确「写入不阻塞播放」；
  - `src/plugins/storage.ts:46-58` `saveData`：`await removeData(key)` → `await AsyncStorage.multiSet(datas)` 两步，大 key 分片时 `multiSet` 会写多片；
  - `src/plugins/storage.ts:75-117` `removeData`：分片场景要先 `getItem` 再 `multiRemove` 多片，**两次 IO**；
  - 现有进度写入用 `throttleBackgroundTimer`（`playProgress.ts:13`）已在后台线程节流，说明团队有意规避主线程阻塞。
- **严重级**：**P1**。500 条历史（估算见 §5）单次全量重写，若落在主线程会阻塞；且"先删后写"窗口期内 App 被杀 → **历史全丢**（比 `@play_info` 单条丢失更严重）。
- **期望**：历史写入沿用 `throttleBackgroundTimer` 范式（≥2s 节流 + 屏幕亮灭门控，参考 `playProgress.ts:36-38`），并评估是否需要**增量落盘**（仅追加/改写单条）以避免每次全量重写 500 条。App 被杀容错见 §4 人工用例。

### A-7【P2】存储容量：500 条是否触碰 `storage.ts` 500KB 分片阈值

- **证据**：
  - `src/plugins/storage.ts:9` `const limit = 500000`（500KB，按 **UTF-16 字符数** 计，非字节）；
  - `src/plugins/storage.ts:11-25` `buildData`：`valueStr.length > limit` 时按 `substring` 切片。
- **实测（本机 node 验证，见 §5）**：单条典型记录 ≈ **373 字节**；500 条 ≈ **187KB**（`JSON.stringify` 计 161001 字符）→ **低于 500KB 阈值，不触发分片**。
- **严重级**：**P2**。正常不触发；但**若单条误存整段歌词等大字段**（`playerState.musicInfo.lrc` 可达数 KB），500 条可轻易越过 500KB → 触发分片，读写变 `multiGet`/`multiRemove` 多片，性能与 `saveData` 非原子风险上升。
- **期望**：历史记录**只存展示必需的最小字段**（`id/name/singer/albumName/picUrl` 短预览 + `musicId/listId/time/maxTime/updateTime`），**严禁存 lrc/rawlrc 等大字段**。设定单条体积上限断言（如 < 2KB）。

### A-8【P2】`buildData` 分片循环 `i <= Math.floor(len/limit)` 的边界

- **证据**：
  - `src/plugins/storage.ts:19` `for (let i = 0, len = Math.floor(valueStr.length / limit); i <= len; i++)`；
  - 当 `valueStr.length` 恰为 `limit` 整数倍时（如 =limit），`len=1`，循环产生 i=0 与 i=1 两片，其中 i=1 片为空串 → 多写一个空分片键。
- **实测**：本机验证 `161001` 字符（<limit）时 `len=0`，仅 1 片，`substring` 重组 `total === valueStr` 为 `true`（无损）。
- **严重级**：**P2**。极端边界会多 1 片空 chunk（轻微冗余），**但不影响读回正确性**（`handleGetData` 会 `join('')` 空串）。
- **期望**：非本需求引入的既有行为，**不作为本需求阻断项**，登记为已知问题，测试用例覆盖"整倍数长度"验证读回无损（用例 T-C-03）。若本需求会构造长数据，需回归验证。

### A-9【P2】播放中「同一作品不同集」快速连续切换 + 节流窗口 → 丢失中间集记录

- **证据**：
  - `playProgress.ts:13-20` 2s 节流；连续切歌时 pending 写入被合并；
  - `playProgress.ts:115-128` `handleSetPlayInfo` 每次 `musicToggled` 触发即时写（无节流）—— 若历史写也挂这里，快速切歌会**只留最后一次**。
- **严重级**：**P2**（可接受，取决于产品预期：连续切歌是否要每集都记）。
- **期望**：明确产品预期。默认可接受"保留最后停留集"，但需在 TEST-PLAN 用例 T-B-05 固化断言，避免后续误判为 bug。

### 待验证项

- **V-1**：作品去重键定义（`listId` vs `albumName+singer`）—— 需 architect 拍板（关联 A-3）。
- **V-2**：**已由本审查闭环 → 升级为 P1（A-10）**。见下。

### A-10【P1】同步链路 `buildUserListInfoFull` 字段枚举 → 新增字段被静默丢弃

- **证据**：
  - `src/plugins/sync/listEvent.ts:6-15` `buildUserListInfoFull` **显式枚举** `{ id, name, source, sourceListId, locationUpdateTime, list }` 构建同步载荷；
  - `src/plugins/sync/listEvent.ts:17-30` `getLocalListData` → `userList: userLists.map((l, i) => buildUserListInfoFull({ ...l, ... }))`，虽入参 `...l` 带了新字段，但**返回值只含被枚举的字段** → 新字段在**上传同步时丢失**；
  - `src/plugins/sync/listEvent.ts:32-34` `setLocalListData` → `list_data_overwrite(listData, true)`；`src/event/listEvent.ts:78-93` `list_data_overwrite` → `fixListIdType` + `listDataOverwrite`（`src/utils/listManage.ts:107-137`）重建 `newUserListInfos` 时 `({ list, ...listInfo })` **保留其余字段**（好），但**下行数据源自上游已丢字段**。
  - `src/types/list_sync.d.ts:17` 存在 `SyncAction<'list_data_overwrite', LX.List.ListActionDataOverwrite>`（注意源码该行 `LX.Sync.List.` 后有可疑语法，另见 P2 备注）。
- **严重级**：**P1**。需求虽"不接 sync-server"，但**一旦用户曾开启同步，历史相关的列表开关字段会在同步往返中丢失**，且 `list_data_overwrite` 会用远端数据**覆盖本地** → 本地开关被抹。
- **期望**：`buildUserListInfoFull` **必须**同步透传新字段；若产品明确"历史开关不参与同步"，则需**显式**在同步层剥离并文档说明，禁止"忘了枚举"式的静默半同步。

---

## 2. 验收标准（EARS 格式）

> 每条需求至少 1 条可断言标准；`While/When/Where/If` 为 EARS 触发词。

### 需求 1：自动记录
- **EARS-1.1**：`When` 用户在播放某有声小说集且播放进度发生变化，`the system shall` 记录一条历史，含：作品标识、集标识（稳定 musicId）、进度时间点（秒）、最近播放时间（epoch ms）。
- **EARS-1.2**：`While` `player.isSavePlayTime` 为 false（默认，`src/config/defaultSetting.ts:...` 该默认为 false），系统**不得**记录进度时间点写入历史（或按产品定义记录 time=0）。
- **EARS-1.3**：`When` 处于"稍后播放"（`isTempPlay === true`），系统**不得**产生历史记录（对齐 `playProgress.ts:120` 既有约束）。

### 需求 2：断点续播
- **EARS-2.1**：`When` 用户从历史记录点击某个作品，`the system shall` 播放该记录对应的**集（按稳定 musicId 定位）**，并将播放位置 seek 到记录的进度时间点。
- **EARS-2.2**：`If` 该集已不在其歌单中（`findIndex(musicId) < 0`），`then` 系统**必须显式**提示并降级（不得静默跳到错误集）。
- **EARS-2.3**：`If` 该历史对应的歌单已被删除，`then` 系统必须提示"作品不存在"并移除该历史。

### 需求 3：同作品更新 + 倒序
- **EARS-3.1**：`When` 用户播放同一作品（同一去重键）的另一集，`the system shall` **更新**该作品的已有历史记录（而非新增），更新 `musicId`/`time`/`updateTime`。
- **EARS-3.2**：`While` 历史列表渲染，`the system shall` 按 `updateTime` **倒序**排列（最新在前）。
- **EARS-3.3**：`When` 更新一条已存在记录，`the system shall` 将其移动到列表头部。

### 需求 4：删除 / 清空 / 上限
- **EARS-4.1**：`When` 用户删除单条历史，`the system shall` 仅移除该条，其余不变。
- **EARS-4.2**：`When` 用户清空全部，`the system shall` 移除所有历史记录（列表为空）。
- **EARS-4.3**：`When` 新增导致总数将超过 500，`the system shall` 按 FIFO 淘汰**最旧（updateTime 最小）**的一条，保持总数 = 500。

### 需求 5：本地持久化 / 不阻塞
- **EARS-5.1**：`When` App 冷启动，`the system shall` 从**本地存储**恢复历史（**不调用 sync-server**）。
- **EARS-5.2**：`While` 播放进行中写入历史，`the system shall` 不阻塞播放线程（写入采用节流/异步，UI 与音频不卡顿）。
- **EARS-5.3**：`When` 写入历史节流触发，`the system shall` 写独立存储 key（不得覆盖 `@play_info`）。

---

## 3. 测试用例清单

> 分层：Unit（纯逻辑）/ Integration（storage + player store）/ E2E（真机旅程）。标注 ⚠️ 的必须变异加固。

### 3.1 Happy Path（正常流）

| ID | 用例 | 断言 | 层 |
|---|---|---|---|
| T-A-01 | 播放有声小说第 3 集 30s 后切换 | 历史存在该作品 1 条，`musicId`=第3集，`time`≈30 | Integration |
| T-A-02 | 从历史点击作品 | 跳到记录集 + seek 到 time | E2E |
| T-A-03 | 同一作品播第 3 集后播第 5 集 | 历史仍 1 条，`musicId`=第5集，`updateTime` 更新 | Integration ⚠️ |
| T-A-04 | 播放 A、B 两个作品 | 列表 2 条，B 在前（倒序） | Integration |
| T-A-05 | App 冷启动 | 历史完整恢复 | E2E(人工) |
| T-A-06 | 删除单条 | 该条消失，其余不变 | Integration |
| T-A-07 | 清空全部 | 列表长度 0 | Integration |

### 3.2 边界流（Boundary）

| ID | 用例 | 断言 | 层 |
|---|---|---|---|
| T-B-01 | 预置 499 条，新增第 500 条 | 总 500，无淘汰 | Unit ⚠️ |
| T-B-02 | 预置 500 条，新增第 501 条 | 总 500，**`updateTime` 最小者被淘汰**，新条入列 | Unit ⚠️（变异点：`>` vs `>=`，FIFO 比较方向） |
| T-B-03 | 同作品重复播放（去重键命中） | 不新增，仅更新 + 置顶 | Unit ⚠️ |
| T-B-04 | **歌单被删后从历史点击** | 显式提示 + 移除脏历史，**不静默跳错集** | Integration ⚠️（P0 关联 A-4） |
| T-B-05 | 快速连续切 3 集（每集 <2s） | 断言产品预期（默认保留最后停留集） | Integration |
| T-B-06 | 进度为 0（刚开始播） | 记录 time=0 的行为符合 EARS-1.2 | Unit |
| T-B-07 | 单集播完（time == maxTime） | 行为符合产品定义（建议：保留 maxTime 或标记已完） | Unit |
| T-B-08 | **播放中删除该作品歌单** | 历史被级联清理或标记失效 | Integration ⚠️（A-4） |
| T-B-09 | **播放中增删/重排歌单后再续播** | 仍定位到**原集**（musicId），非错位集 | Integration ⚠️⚠️（**P0 关联 A-1，最高优先级**） |
| T-B-10 | 历史存储 key 与 `@play_info` 隔离 | 读 `@play_info` 不受历史写入影响 | Integration（A-2） |

### 3.3 异常 / 边界存储

| ID | 用例 | 断言 | 层 |
|---|---|---|---|
| T-C-01 | 单条含大字段（误存 lrc）体积 | 触发单条体积上限告警；生产禁存 | Unit |
| T-C-02 | 500 条 JSON 体积估算 | ≤ 500KB（不触发分片）；实测 ≈187KB | Unit（已预验证） |
| T-C-03 | 数据长度恰为 `limit` 整数倍 | `getData` 读回与原值严格相等 | Unit（A-8） |
| T-C-04 | 老数据（无新字段）反序列化 | 读取不抛错，默认 false | Unit ⚠️（A-5） |
| T-C-05 | 新建/更新列表带开关字段 | 开关**不丢失**（createUserList/updateList 透传） | Unit ⚠️（A-5） |
| T-C-06 | 写入过程中 App 被杀（真机） | 重启后历史不损坏（旧值或新值，非空） | E2E(人工) |
| T-C-07 | 存储写入失败（模拟 IO 异常） | 捕获、log.error，不 crash | Integration |

---

## 4. 不可自动化 / 必须人工验证的部分

1. **真机冷启动持久化**（T-A-05）：RN 的 AsyncStorage 行为、进程被杀后落盘时序，模拟器不可靠，**必须真机 Android**。
2. **写入不阻塞播放**（EARS-5.2）：需真机播放音频，主观+客观（音频无卡顿、UI 无掉帧）验证；可辅以 `console.time` 打点但以真机体感为准。
3. **App 被杀容错**（T-C-06）：后台强杀进程，验证历史不损坏。
4. **屏幕亮灭门控下写入**（对齐 `playProgress.ts:155-160`）：熄屏/亮屏时历史写入是否符合预期，需真机。
5. **列表倒序 + UI 渲染**：视觉倒序、空态、加载态，需人眼确认（P2 视觉项）。
6. **emoji 图标合规**（团队 P0 规则）：历史列表 UI 若新增图标，需用脚本 + 人眼双验（见 §6）。

---

## 5. 测试数据构造方案（如何造 500 条历史测淘汰）

**方案 A：直接注入存储（推荐，最快）**
```js
// 在 dev 环境通过 storage 插件直接写入 500 条合成历史
import { saveData } from '@/plugins/storage'
const KEY = '@audio_novel_history'
const list = Array.from({ length: 500 }, (_, i) => ({
  key: `novel_${i}`,            // 作品去重键
  listId: `userlist_seed`,      // 全部指向同一测试歌单
  musicId: `music_${i}`,        // 集 id
  name: `测试作品 第${i+1}集`,
  singer: '测试演播',
  albumName: '测试作品（全集）',
  picUrl: 'https://example.com/p.jpg',
  time: 12.3,
  maxTime: 1200,
  updateTime: Date.now() - (500 - i) * 60000,  // i=0 最旧，i=499 最新
}))
await saveData(KEY, list)
```
> `updateTime` 刻意构造为递增，验证 FIFO 淘汰时被淘汰的必须是 `i=0`（最旧）。

**方案 B：脚本循环调用历史 API**
通过测试桩直接调用历史的 `addHistory()` 500 次，每次不同作品键，最后再加 1 条 → 断言总数 500 且第 1 条被淘汰。用于验证真实写入链路（含节流）。

**体积预估（本机 node 实测）**：
| 项 | 值 |
|---|---|
| 单条典型记录 | **373 字节** |
| 500 条总量 | **187,001 字节 ≈ 187KB** |
| `storage.ts` 分片阈值 | 500,000（**不触发分片**） |
| 单条建议上限 | < 2KB（禁含 lrc/pic 大字段） |

**数据隔离**：测试用 `listId` 使用专用 seed id，避免污染真实用户歌单；测试后清理 key。

---

## 6. 独立复核要点（verifier-critic / 反作弊）

依据 `test-integrity-anti-gaming.md`：本需求落地后，测试门禁须检查——
- [ ] 实现 diff 与测试 diff **分开评审**；新增断言是否被删/弱化。
- [ ] 无新增 `skip`/`xfail`/`.only`。
- [ ] 断言的期望值来自 **EARS 验收标准**，而非实现的返回值（防同义测试）。
- [ ] 核心断言（FIFO 淘汰 / 去重更新 / musicId 定位）为**留出集**验证，作者不可改。
- [ ] 团队 P0 视觉规则扫描：
  ```bash
  # emoji 功能图标（P0）
  grep -rP '[\x{1F300}-\x{1F9FF}\x{2600}-\x{26FF}\x{2700}-\x{27BF}]' src/ --include='*.tsx' --include='*.jsx'
  # 紫粉渐变（P1）
  grep -rn 'purple.*pink\|from-purple.*to-pink' src/
  # AI 模板味（P1）
  grep -rn 'Welcome to\|Lorem ipsum' src/
  ```

---

## 7. 给 architect 的返工要求（阻断项）

1. **[P0] 定位键**：历史定位**禁止**用 `playIndex`，必须用稳定 `musicId`；`findIndex < 0` 必须有显式降级（关联 A-1、A-4）。
2. **[P0] 写入隔离与并发**：历史存独立 key；历史写与 `SavedPlayInfo` 写解耦；切歌时 flush + cancel pending + 校验 musicId（关联 A-2）。
3. **[P0 待拍板] 作品去重键**：明确 `listId` 或 `albumName+singer`（V-1）。
4. **[P1] 删除级联**：挂钩 `list_remove` 清理悬空历史（A-4）。
5. **[P1] 字段透传**：`UserListInfo` 新字段在全链路显式透传 + 默认值 + 读取真值判断（A-5）。
6. **[P1] 写入不阻塞**：沿用节流范式，评估增量落盘（A-6）。
7. **[P1] 同步透传**：`src/plugins/sync/listEvent.ts:6-15` `buildUserListInfoFull` 必须同步透传新字段，或显式剥离并文档化（A-10）。

---

## 8. 附：本次审查的关键证据链（文件:行号）

| 编号 | 文件:行号 | 说明 |
|---|---|---|
| E1 | `src/plugins/storage.ts:9` | `limit = 500000` 分片阈值 |
| E2 | `src/plugins/storage.ts:11-25` | `buildData` 分片逻辑与 `i<=floor` 边界 |
| E3 | `src/plugins/storage.ts:46-58` | `saveData` 先删后写（非原子） |
| E4 | `src/core/init/player/playProgress.ts:13-20` | `delaySavePlayInfo` 2s 节流写 `@play_info` |
| E5 | `src/core/init/player/playProgress.ts:115-128` | `handleSetPlayInfo` 无节流即时写 |
| E6 | `src/core/init/player/playProgress.ts:177` | `musicToggled` 绑定 `handleSetPlayInfo` |
| E7 | `src/core/player/playInfo.ts:38-71` | `getPlayIndex`，`playIndex<0` 静默分支 |
| E8 | `src/core/player/playInfo.ts:135` | 切歌触发 `musicToggled` |
| E9 | `src/core/player/player.ts:157-196` | `handleRestorePlay` 续播入口 |
| E10 | `src/core/player/player.ts:245-248` | `restorePlayInfo` 消费路径 |
| E11 | `src/core/init/player/playInfo.ts:6-17` | 启动恢复：`info.index<0` / `!list[index]` 仅静默 return |
| E12 | `src/utils/data.ts:433-439` | `savePlayInfo` / `getPlayInfo` → `@play_info` |
| E13 | `src/utils/data.ts:282-299` | `getUserLists` / `saveUserList` 反序列化 |
| E14 | `src/event/listEvent.ts:117-125` | `list_remove` 删除链路 |
| E15 | `src/utils/listManage.ts:158-170` | `userListsRemove` 无历史清理钩子 |
| E16 | `src/utils/listManage.ts:31-79` | `createUserList`/`updateList` 字段枚举（透传风险） |
| E17 | `src/utils/listManage.ts:200-202` | `getListMusicSync` 返回可变数组/空数组 |
| E18 | `src/utils/listManage.ts:245-256` | `listMusicRemove` 删除后下标前移 |
| E19 | `src/core/list.ts:27-29` | `removeUserList` 入口 |
| E20 | `src/types/list.d.ts:3-11` | `UserListInfo` 现有字段 |
| E21 | `src/types/player.d.ts:71-76` | `SavedPlayInfo` 结构 |
| E22 | `src/config/defaultSetting.ts` | `player.isSavePlayTime` 默认 false |
| E23 | `src/plugins/sync/listEvent.ts:6-15` | `buildUserListInfoFull` 字段枚举（同步丢字段） |
| E24 | `src/plugins/sync/listEvent.ts:17-34` | `getLocalListData`/`setLocalListData` 同步往返 |
| E25 | `src/types/list_sync.d.ts:17` | 同步 Action schema（`list_data_overwrite`） |

---

# 16. 第二轮复核结论（复核 architect §15 P0 闭环）

> 复核对象：`ARCHITECTURE.md` §15（703 行）。纪律不变——**只认机械证据，所有结构性论证必须自己复现**。
> 本轮**推翻了 architect 与 team-lead 均认可的 P0-2「结构性闭环」**，并发现架构师「自缓存 lastProgress」方案存在同源缺陷。

## verdict: **fail**（P0-2 未真正闭环，须再返工）

| 待复核项 | 架构师结论 | 我的复核结论 |
|---|---|---|
| #1 冷启动守卫（P0-2 核心） | ✅ 已闭环（靠同步时序） | ❌ **不成立**（emit 是异步派发，见 R-1） |
| #2 三路径覆盖 + 自动下一曲 | ✅ 覆盖 | ✅ 成立（三条路径均触发并放行，见 R-2） |
| #3 P0-1 索引 vs 主键 | 用 musicId + 回退 | ⚠️ 部分成立，回退可断言性不足（见 R-3） |
| #4 A-4 悬空引用 | 仅读侧降级 | ⚠️ 建议补失效标记（见 R-4） |
| #5 切歌 flush 进度为 0 | 自缓存 lastProgress | ❌ **方案有洞**（缓存被 setProgress(0,0) 清零，见 R-5） |
| #6 formatRelativeTime | 已存在 `dateFormat2` | ✅ 成立（见 R-6） |
| #7 新增风险 | — | 发现 2 项（见 R-7/R-8） |

---

## R-1【P0，推翻闭环】`Event.emit` 用 `setImmediate` 异步派发 → `restorePlayInfo` 守卫在冷启动路径**失效**

### 我的独立复现（团队纪律要求：不沿用 team-lead 结论）

**反方证据链（关键）**：
- `src/event/Event.ts:24-33` `emit()`：`setImmediate(() => { ...listener(...args) })` —— **所有事件监听器都是下一个 macrotask 才执行，不是同步！**
- `src/event/appEvent.ts:17` `AppEvent extends Event`；`:43-45` `musicToggled()` → `this.emit('musicToggled')` → 继承上面的异步 `emit`；
- `src/core/init/player/playInfo.ts:122-136` `setPlayMusicInfo`：`:126 setProgress(0,0)`（同步）→ `:135 global.app_event.musicToggled()`（**投递到 setImmediate 队列**，立即返回）；
- `src/core/player/player.ts:289-296` `playList`：`:292 setPlayMusicInfo(...)`（其中 `musicToggled` 被投递）→ `:295 await handlePlay()`；
- `src/core/player/player.ts:229-249` `handlePlay`：`:245 if (global.lx.restorePlayInfo)` → `:246 handleRestorePlay()` → `:247 global.lx.restorePlayInfo = null` → `:248 return`。**在 `:245-248` 之间无 await**，故 `restorePlayInfo` 在**同一个同步调用栈内**被清空。

**时序判定**：
```
同一 macrotask 内（同步）：
  playInfo.ts:13  restorePlayInfo = info        (非空)
  playInfo.ts:15  playList() →
    player.ts:292   setPlayMusicInfo() →
      playInfo.ts:135  musicToggled()  ─► [排队 setImmediate]  ← 仅排队，未执行
    player.ts:295   await handlePlay() →
      player.ts:247  restorePlayInfo = null      ← 先执行，清空！
  ── 同步栈结束 ──
下一个 macrotask：
  [setImmediate] musicToggled 监听器执行 → 读 restorePlayInfo == null → 守卫放行 → ❌ 误记
```

**本机 node 忠实模拟（复刻 `Event.emit` 的 setImmediate 语义）实测输出**：
```
[player] restore branch, clearing restorePlayInfo
restorePlayInfo after coldStart: null
[history] RECORDED: { id: 'song_3' }      ← 监听器在清空之后才跑 → 误记
```

**结论**：架构师 §15.1 与 team-lead 的「先触发、后清空，靠同步调用顺序结构性保证」**前提错误**——`emit` 不是同步的。守卫 `if (global.lx.restorePlayInfo) return` 在冷启动**不会生效**，冷启动仍会**误记一条历史**（正是 P0-2 要消灭的现象）。

- **严重级**：**P0**（P0-2 核心目标未达成）。
- **期望**（可落地修法，任一）：
  1. **改为进程内同步标志**：不要在监听器里读 `global.lx.restorePlayInfo`（它会被异步语义击败），而是在 `playInfo.ts` 触发点**同步**置一个 `isRestoring=true` 标志并**在 emit 前**设置、在**恢复完成后由监听器自己清理**——但侵入 `playInfo.ts` 与"禁止修改"冲突，不可取；
  2. **推荐：事件透传语义**：让注入点携带"是否恢复播放"信息。但 `musicToggled()` 无参数且 emit 异步，最稳的**非侵入**做法是——历史模块在**冷启动窗口期**显式禁记（App 启动 → 恢复流程结束后再开启记录），例如在历史模块初始化时读取一次 `getPlayInfo()`，若存在待恢复信息则**延迟注册监听器/设 `bootGuard=true`**，待首帧后清。
  3. 或：不改注入点，改为在**首条 `playProgressChanged` 且 `nowPlayTime>0`** 时才允许首次记录（天然排除冷启动 0 值瞬间），但仍需覆盖 R-5。
- **附**：此结论 100% 可机械复现（见上方 node 脚本逻辑），实施时**必须**有一条集成测试：冷启动（含/不含 startupAutoPlay）后断言历史**零新增**。用例已加至 T-D-01。

---

## R-2【通过】三路径覆盖 + 自动下一曲

**独立验证**（实读触发点）：
- `musicToggled` 唯一发射点 `src/core/player/playInfo.ts:135`；其调用方 `setPlayMusicInfo` 仅被以下 5 处调用（grep 全仓）：
  - `playListById` `player.ts:278`；`playList` `player.ts:292`；`handlePlayNext` `player.ts:403`；`activeList` 清空 `player.ts:301`（`null,null`，`playInfo.ts:128` 分支**不触发** musicToggled）。
- **自动下一曲**：`playNext`（`player.ts:411`）→ `handlePlayNext`（`:402-403`）→ `setPlayMusicInfo(:403)` → `musicToggled`。有声小说"听完整集自动跳下一集"走此路径，**会触发且会被记录**（`isTempPlay:false`，`restorePlayInfo:null`）✅
- **稍后播放**：`handlePlayNext` 传 `isTempPlay:true`（来自 `tempPlayList`），守卫 2 拦下 ✅
- **冷启动**：见 R-1 ❌（守卫失效）。

**结论**：路径覆盖矩阵**属实**（除冷启动守卫本身失效）✅。但"每集自动跳会都记"是否与 P0-3 单作品去重冲突，需 architect 再确认（同一作品换集应 upsert，不新增）。

---

## R-3【部分成立】P0-1 回退策略可断言性

架构师称：集数定位用 `findIndex(m => m.id == musicId)`，失败回退且"显式降级"。
- 证据支持：`src/utils/listManage.ts:200-202` `getListMusicSync(已删/不存在 id)` 返回 `[]`（非 undefined），故 `findIndex < 0` 稳定。
- **但**："显式降级"目前只有措辞，**未定义具体行为与可断言输出**（是 toast？置灰？删除记录？返回什么？）。
- **严重级**：P1（可断言性缺口）。**期望**：定义降级契约——返回 `{ ok:false, reason:'music_not_found' }` + UI 提示文案 key + 是否删除该历史，供测试断言（用例 T-B-04/T-D-02）。

---

## R-4【建议补强】A-4 仅读侧降级是否足够

架构师的"读侧降级必做 + 写侧可选 + 推荐仅读侧"**方向正确**（我认同其复杂度权衡，证据：`list_data_overwrite` 走 `listEvent.ts:91` 不发 `list_remove`，写侧需挂两事件确易漏）。
- **但"仅读侧降级"有体验缺口**：悬空记录**永久留在列表**里持续展示，用户反复点击都置灰，且无自愈——列表会越积越多"死条目"。
- **严重级**：P1（体验/数据整洁）。**裁定**：**至少加"失效标记"**——解析历史时按 `listId` 做一次存在性校验，将失效条目**在 UI 标记为"作品已删除"**（非静默置灰），并提供"清理失效记录"入口或自动剔除。纯读侧不过滤会让脏数据无限累积。
- **期望**：读侧降级 + **失效可视标记**（最低要求）。写侧清理可作为后续优化。

---

## R-5【P0-2 同源洞】"自缓存 lastProgress" 会被 `setProgress(0,0)` 清零

架构师 §15.4 方案：历史模块在 `playProgressChanged` 监听里持续更新 `lastProgress`，切歌 flush 时用缓存值。
**独立证伪**：
- `src/store/player/action.ts:58-66` `setProgress()` → `:65 global.state_event.playProgressChanged({ ...state.progress })`；`:44-50 setNowPlayTime` 同样 emit（`:49`）；`:51-57 setMaxplayTime`（`:56`）。
- `src/core/player/playInfo.ts:126` 在 `musicToggled`（`:135`）**之前同步调用** `setProgress(0, 0)` → 投递 `playProgressChanged({nowPlayTime:0, maxPlayTime:0})`。
- `stateEvent` 同样 `extends Event`（`stateEvent.ts:18`），故 `playProgressChanged` 也是 **setImmediate 异步**，且**排队早于** `musicToggled` → 先执行。
- ⟹ 历史监听器处理 `musicToggled` 时，`lastProgress` **已被置为 0**。缓存策略**读到的就是 0**，切歌 flush 会写入 `time=0`——**丢失上一首的真实进度**。
- **严重级**：**P0**（P0-2 的"以切歌时刻进度 flush"目标未达成）。
- **期望**：缓存**必须带"当前歌曲身份"**：仅在 `playProgressChanged` 且 `playerState.musicInfo.id === cachedMusicId` 时更新缓存；切歌瞬间先按 **prev musicId** 取缓存再清零。或**忽略 `nowPlayTime===0 && maxPlayTime===0` 的重置事件**（该组合仅出现在切歌/stop 重置，非真实进度）。二者需有定向测试（用例 T-D-03）。

---

## R-6【通过】`formatRelativeTime` 已存在

- 证据：`src/utils/index.ts:174-185` `dateFormat2(time)` 实现 N秒/分/小时前 + 超1天 `dateFormat`；i18n 键 `src/lang/zh-cn.json:36-38` `date_format_hour/minute/second` 存在 ✅。
- **行动**：TEST-PLAN 原表述未出现"新增工具"字样，本轮**明确更正**——测试用例引用 `dateFormat2`，**不写"新增工具"测试**。✅

---

## R-7【新发现·P1】`event.emit` 的 setImmediate 语义对**所有**历史监听器一致生效 → 连带放大 R-1/R-5

- 由 R-1 已证 `emit` 全部异步。这不仅是守卫问题：历史模块**任何**依赖"事件处理时读取 `playerState` 当下值"的逻辑，都会读到**事件投递后、处理前又被后续同步代码改写**的状态。
- 典型受害：`onMusicToggled` 里读 `playerState.playMusicInfo`（`ARCHITECTURE.md:511`）——在快速连续切歌（A/B 两首在同一 tick 连续 `setPlayMusicInfo`）时，两次 `musicToggled` 都投递，但处理时读到的 `playMusicInfo` **都已是 B** → A 会被漏记/错记。
- **严重级**：P1。**期望**：历史监听器**必须**在事件投递时**快照**所需上下文（或在注入点快照），不能延迟到监听器执行时读全局 state。建议 architect 为 `musicToggled` 事件**补参数**或在历史模块内对齐"快照-处理"模式。

---

## R-8【新发现·P2】自持节流器与现有节流器并存的资源/生命周期

- 架构师 §15.4 自建 `pendingTimer/hasPending` 节流器（合理，因 `tools.ts:419-430 throttleBackgroundTimer` **无 cancel/flush API**，证据确认）。
- **风险**：若历史模块在**测试/热重载**中重复初始化，`global.app_event.on('musicToggled', onMusicToggled)` 会**重复注册**（`Event.on` 仅 push，不去重，`Event.ts:10-14`），且模块级 `pendingTimer` 与旧实例的 timer 可能**双份并存** → 重复写库/泄漏。
- **严重级**：P2（生产单例初始化下低概率；测试环境高概率导致用例间污染）。**期望**：历史模块**保证单次注册**（模块级 `inited` 标志 guard），或注册前 `off` 同名监听；并在 App 卸载/测试 teardown 时 `clearTimeout(pendingTimer)`。用例 T-D-04 覆盖"重复初始化只注册一次"。

---

## 16.9 第二轮 blocking / advisory 汇总

**blocking（P0，未归零，须返工）**：
| # | 问题 | 证据 | 期望 |
|---|---|---|---|
| B-1 | 冷启动守卫失效（P0-2 未闭环） | `event/Event.ts:24-33`(setImmediate 异步 emit) + `playInfo.ts:126/135` + `player.ts:245-248` | 改用不依赖 `restorePlayInfo` 的冷启动禁记机制（见 R-1 修法），并有冷启动零新增的集成测试 |
| B-2 | 自缓存 lastProgress 被 `setProgress(0,0)` 清零（P0-2 同源洞） | `store/player/action.ts:58-66` + `playInfo.ts:126` + `stateEvent.ts:18` | 缓存按 musicId 归属 + 忽略 0/0 重置事件（见 R-5），有切歌进度不丢失的定向测试 |

**advisory**：
| # | 建议 | 理由 |
|---|---|---|
| A-1 | P0-1 回退**定义可断言契约**（返回结构+提示 key+是否删记录） | 现仅"显式降级"措辞，测试无法断言（R-3） |
| A-2 | 悬空历史**至少加失效可视标记**，别只读侧静默置灰 | 死条目无限累积（R-4） |
| A-3 | 历史监听器**快照上下文**，不延迟读 `playerState` | emit 异步致快速切歌错记（R-7） |
| A-4 | 历史模块**单次注册 guard + teardown 清 timer** | 防重复注册/泄漏（R-8） |
| A-5 | 自动下一曲 upsert 语义确认（同作品换集不新增） | 用例 T-B-03 一致性 |

**evidence（本轮新增关键证据）**：
- `src/event/Event.ts:24-33`（setImmediate 异步 emit，**推翻闭环的根本证据**）
- `src/event/appEvent.ts:17,43-45` / `src/event/stateEvent.ts:18`（两个 Event 子类均异步）
- `src/core/init/player/playInfo.ts:122-136`（setProgress(0,0) 先于 musicToggled）
- `src/core/player/player.ts:229-249,289-296`（恢复分支同步清空 restorePlayInfo）
- `src/store/player/action.ts:44-66`（playProgressChanged 三个发射点）
- `src/utils/tools.ts:419-430`（throttleBackgroundTimer 无 cancel/flush）
- `src/utils/index.ts:174-185` + `src/lang/zh-cn.json:36-38`（dateFormat2 已存在）
- 本机 node 复现脚本输出（见 R-1）

## 16.10 新增测试用例（第二轮）

| ID | 用例 | 断言 | 层 |
|---|---|---|---|
| T-D-01 | **冷启动（含 startupAutoPlay）零新增历史** | 恢复播放后历史条数 = 启动前（**必须为 0 新增**） | 集成 ⚠️（B-1） |
| T-D-02 | 悬空历史点击 | 返回可断言的降级结果 + UI 显示"作品已删除"标记 | 集成 ⚠️（A-1/A-2） |
| T-D-03 | 切歌时上一首进度保留 | 切歌前停了 45s，切歌后历史里上一首 `time≈45`（≠0） | 单元 ⚠️（B-2） |
| T-D-04 | 历史模块重复初始化 | 仅注册 1 次监听；无 timer 泄漏 | 单元（A-4） |
| T-D-05 | 同一 tick 连续切 A→B | 记录中 A、B 的 musicId 与实际快照一致（不都记成 B） | 集成 ⚠️（A-3） |

---

# 17. 第三轮复验结论（复验 architect §16 返工）

> 复验对象：`ARCHITECTURE.md` §16（1061 行）。**重点：V-1 必须给运行时证据。**
> 环境事实（本机实测）：`node_modules` 缺失、无 Jest/测试脚本 → **无法在本机跑 RN 单测**；故 V-1 采用「**运行时权威源码 + 忠实复刻脚本实测**」双证据。

## verdict: **pass（有条件）**

B-1/B-2 的**核心逻辑经我独立复现成立**，但发现 **1 项 P1 代码笔误（B-2 身份校验恒等，死代码）** 与 **2 项 advisory**；其中笔误**不阻断**（当前调用面有既有保护），但必须修，否则是"假防御"。

| 复验项 | 架构师结论 | 我的复验结论 | 证据类型 |
|---|---|---|---|
| V-1 setImmediate FIFO / bootGuard 有效性 | 待验证（依赖 FIFO） | ✅ **成立（两运行时均成立）**，但**理由与架构师不同** | 运行时源码 + 复刻实测 |
| V-2 双零过滤误判 | 极端但无害 | ✅ 基本成立（仅 `{0,0}` 漏记，语义无害） | 复刻实测 |
| V-3 `musicToggled(snapshot?)` 副作用 | 向后兼容 | ✅ 成立（4 监听器全零参签名） | 源码实读 |
| B-1 方案 X 变体覆盖 | 覆盖 | ✅ 覆盖（不重启/startup 开关/time>0 均拦） | 复刻实测 |
| B-2 身份校验 | 逻辑正确 | ❌ **恒等笔误（`curId !== playerState.musicInfo.id`），死代码** | 源码实读 + 复刻实测 |
| R-3 ResumeResult 三态 | 可断言 | ✅ 契约清晰，i18n 3 键齐 | 源码实读 |
| R-4 失效标记 + purgeInvalid | 成立 | ✅ 成立 | 源码实读 |
| R-8 inited guard + teardown | 注册点已确认 | ⚠️ 注册点✅；**exitApp 无现成 teardown 挂点，需新增调用** | 源码实读 |

---

## V-1【✅ 成立，但推翻架构师的"FIFO macrotask"论证】运行时证据

### ★ 运行时权威源码证据（RN 0.73.11，本项目 `hermesEnabled=true`）

**证据 R-V1-a：`setImmediate` 的实现在本项目的运行时下不是 macrotask，而是 microtask。**
RN `Libraries/Core/setUpTimers.js`（v0.73.11，raw GitHub）：
```js
const hasHermesPromiseQueuedToJSVM =
  global.HermesInternal?.hasPromise?.() === true &&
  global.HermesInternal?.useEngineQueue?.() === true;
...
if (hasPromiseQueuedToJSVM) {
  polyfillGlobal('setImmediate', () => require('./Timers/immediateShim').setImmediate);
}
```
本项目 `android/gradle.properties:41` `hermesEnabled=true` → Hermes 默认 `useEngineQueue()` 返回 true → 走 `immediateShim`。

**证据 R-V1-b：`immediateShim.setImmediate` 基于 `queueMicrotask`（即 microtask，非 macrotask）。**
RN `Libraries/Core/Timers/immediateShim.js`（v0.73.11，raw GitHub）：
```js
function setImmediate(callback, ...args) {
  const id = GUIID++;
  global.queueMicrotask(() => {
    if (!clearedImmediates.has(id)) callback.apply(undefined, args);
    else clearedImmediates.delete(id);
  });
  return id;
}
```
⟹ **本项目 `Event.emit` 的 `setImmediate` = `queueMicrotask` = 微任务**。架构师 §16.1 称"让出一个完整 **macrotask**、靠 **macrotask 队列 FIFO**"的描述**与该运行时事实不符**（但结论侥幸成立，见下）。

### ★ 忠实复刻实测（本机 node，两条运行时路径）

我按 §16.1 的代码逻辑 + `Event.emit` 语义写了复刻脚本，分别在 **microtask 路径**（Hermes）与 **macrotask 路径**（Node 原生 setImmediate，对应非 Hermes/bridgeless）下运行：

```
[microtask 路径]  toggled-listener: isRestoringPlay=true → GUARD blocked
[macrotask 路径]  toggled-listener: isRestoringPlay=true → GUARD blocked
```
**两条路径均守卫生效。** 并针对 team-lead 提示的"Promise 微任务 vs setImmediate 混合第二层坑"做了专项复刻（在 `playList` 前置插入 `await Promise.resolve()` 引入微任务跳跃）：
```
[microtask] listener ran, isRestoring=true | window closed
[macrotask] listener ran, isRestoring=true | window closed
```
两种语义下，`listener ran` 均**严格早于** `window closed`。

### 为何成立（正确理由，供 architect 存档）

关键不是"macrotask FIFO"，而是：**`emit` 的投递与 `await new Promise(r=>setImmediate(r))` 的关窗投递，走的是同一个 `setImmediate`（=同一 microtask 队列在 Hermes 下），且 `emit` 的投递严格发生在前**。同一队列的 FIFO（microtask 与 macrotask 各自都保证 FIFO）⇒ 监听器先于关窗 resolve 执行 ⇒ 窗口内守卫命中。**结论成立，但架构师对机制的表述（macrotask）错误，务必在文档中更正**（否则未来若 RN 升级改变 `setImmediate` 实现，依据错误的"macrotask FIFO"会误导判断）。

### 剩余风险（advisory）

- **R-V1-1【P1 advisory】**：方案正确性**绑定于"`emit` 与关窗用同一 `setImmediate` 实现"**这一隐式契约。若未来有代码把关窗改成 `setTimeout(…,0)`（可能进**另一**队列，Node/Hermes 下 `setTimeout` 是 macrotask、与 microtask 队列不相同）→ 顺序可能反转。**期望**：`playInfo.ts` 关窗处加显式注释锁定"必须与 `Event.emit` 同用 `setImmediate`"，并加一条集成测试值守（T-E-01）。
- **R-V1-2【P2】**：Hermes 微任务路径下，`setImmediate` 的**优先级高于 setTimeout**，可能影响其它依赖"setTimeout 让位"的代码——非本需求引入，登记。

---

## B-2【❌ P1 代码笔误：身份校验是恒等死代码】

架构师 §16.2 代码（`ARCHITECTURE.md:833-837`）：
```ts
const curId = playerState.musicInfo.id        // 当前曲目身份
if (progress.nowPlayTime === 0 && progress.maxPlayTime === 0) return
if (!curId || curId !== playerState.musicInfo.id) return   // ← 恒等！
```
**`curId` 就是 `playerState.musicInfo.id`，第 837 行比较恒为 false，`return` 永不触发 → 身份校验完全失效（死代码）。**

- **实读证据**：`ARCHITECTURE.md:833` 与 `:837` 两处同为 `playerState.musicInfo.id`，无第三方变量。
- **复刻实测（对抗用例）**：构造"A 的进度事件晚到、此时当前歌已是 B"：
  ```
  cached 最终 = B @ 31   （本属 A 的进度被贴上 B 的身份缓存）
  ```
  即校验未拦截污染。
- **严重级**：**P1**（**当前不阻断**：`playProgress.ts:32` 的 `id != playerState.musicInfo.id` 已挡住时移位的 `setNowPlayTime`；但 `setMaxplayTime`（`playProgress.ts:41-42` `getMaxTime`）**无 id 守卫**，仍可能污染；且此"假防御"会误导后续维护）。
- **期望（正确逻辑）**：身份校验应比对**事件归属歌曲**与**缓存归属歌曲**，但 `playProgressChanged` 事件**只带 `progress` 不带 musicId**，监听器又只能在"延迟执行时"读 `playerState`——**信息不足**。正确修法二选一：
  1. 扩展 `playProgressChanged` 携带 musicId（改 `action.ts:49/56/65`，侵入三处，成本高）；**或**
  2. **接受现状**：删除无效的 (b) 校验，改为**只靠**「flush 时用 `musicToggled` 快照的 musicId + 缓存进度配对」（此时需保证 flush 用**上一首的 musicId**，见 §16.2 `cachedMusicId`），并在注释中**如实说明**"进度事件无身份，依赖 `playProgress.ts:32` 的既有守卫"。**禁止保留一条恒等假校验冒充防御。**
- 已加用例 **T-E-02**（加载中切歌不得污染缓存）。

---

## V-2【✅ 基本成立】双零过滤的漏记边界

复刻实测四种进度形态：
| progress | 被(a)过滤 | 是否缓存 |
|---|---|---|
| `{0,0}` 加载中(位置也未就绪) | ✅ 过滤 | ❌ 不缓存 |
| `{0,120}` 正常起点 | 否 | ✅ 缓存 |
| `{5,0}` 位置有值时长未就绪 | 否 | ✅ 缓存 |
| `{12.3,0}` 已播12s时长始终0 | 否 | ✅ 缓存 |

**结论**：只有**位置真正为 0**（`nowPlayTime===0`）的 `{0,0}` 被过滤。只要位置 >0（哪怕 maxTime=0）**都会被记录**。唯一"漏记"是"始终停在 0 的集"——**语义上无害**（进度 0 无续播价值）。架构师"极端但无害"**成立**。用例 T-E-03 固化。

---

## V-3【✅ 成立】`musicToggled(snapshot?)` 对 4 个既有监听的副作用

**实读 4 处监听器签名，全部为零参**：
- `src/core/init/player/lyric.ts:62` → `stop`，定义 `src/core/lyric.ts:65` `export const stop = () => {`（**零参**）
- `src/core/init/player/playerEvent.ts:137` → `handleSetPlayInfo`，定义 `:117` `() => {`（**零参**）
- `src/core/init/player/playProgress.ts:177` → `handleSetPlayInfo`，定义 `:115` `() => {`（**零参**）
- `src/core/init/player/preloadNextMusic.ts:64` → `handleSetPlayInfo`，定义 `:44` `() => {`（**零参**）

JS 对多余实参宽容 ⇒ 新增可选 `snapshot` **行为零影响** ✅。发射点唯一 `playInfo.ts:135`（grep 全仓确认）✅。**"自建专用事件"备选无实质收益（仍需改 `playInfo.ts:135`）——取舍合理** ✅。

---

## B-1 覆盖性 + R-3/R-4/R-8

- **B-1 覆盖（复刻实测）**：① 不重启直接点歌 → `isRestoringPlay` 从未置 true → 正常记；② `startupAutoPlay` 开/关 → `play()`（`player.ts:597-604`）**不触发 musicToggled**，且开关窗都在其前，无影响；③ 冷启动 `time>0` → 拦（不依赖进度值）✅。
- **R-3**：`ResumeResult = {ok:true} | {ok:false,reason:'list_missing'|'music_missing'}` 契约清晰、可断言（`ARCHITECTURE.md:925-934`）；3 个 i18n 键（`:944-948`）齐。✅
- **R-4**：失效标记 `isValid = getListMusicSync(listId).some(m => m.id === musicId)` + `purgeInvalid()`（`ARCHITECTURE.md:964-979`）成立。✅
- **R-8**：`Event.on` 不去重（`Event.ts:10-14`）确认；`inited` guard + `destroy` 逻辑正确。**但**：`exitApp`（`src/core/common.ts:53-65`）当前**只**调 `hideDesktopLyric/destroyPlayer/hideDesktopLyricView`，**无模块 teardown 惯例** → `destroyAudioNovelHistory()` 需**新增**调用（架构师"已确认 teardown 点"措辞不准确，实为"需新增挂点"）。注册点 `core/init/player/index.ts:17-18` 确认真实存在 ✅。

## 17.9 第三轮 blocking / advisory 汇总

**blocking（P0）**：**无**。P0-2 的 B-1/B-2 **核心逻辑经独立复现成立**（B-1 冷启动禁记有效；B-2 切歌 flush 在正常路径保留进度）。

**advisory（P1）**：
| # | 建议 | 证据 | 期望 |
|---|---|---|---|
| P1-1 | **修 B-2 恒等笔误**（删死代码或如实注释），按 §16.2 正确逻辑 | `ARCHITECTURE.md:833/837`；复刻输出 `cached 最终 = B @ 31` | 身份校验要么有效、要么删除并注明依赖 `playProgress.ts:32`；用例 T-E-02 |
| P1-2 | 更正 §16.1 "macrotask FIFO" 表述为 "同一 `setImmediate` 队列 FIFO" | RN `immediateShim.js`/`setUpTimers.js` | 文档更正 + 关窗处注释锁定同源 + 值守测试 T-E-01 |
| P1-3 | `destroyAudioNovelHistory()` 需在 `exitApp` **新增调用**（无现成挂点） | `core/common.ts:53-65` | 明确挂点，否则 R-8 teardown 不生效 |

**evidence（第三轮）**：
- RN `Libraries/Core/setUpTimers.js`（v0.73.11）：`setImmediate` → `immediateShim`（Hermes 路径）
- RN `Libraries/Core/Timers/immediateShim.js`（v0.73.11）：`setImmediate` 基于 `queueMicrotask`
- `android/gradle.properties:41` `hermesEnabled=true`
- `src/core/lyric.ts:65` / `playerEvent.ts:117` / `playProgress.ts:115` / `preloadNextMusic.ts:44`（4 监听器零参）
- `src/core/common.ts:53-65`（exitApp 无模块 teardown）
- `src/core/init/player/index.ts:17-18`（注册点）
- 复刻脚本实测输出（V-1 两路径、B-2 对抗用例、V-2 四形态）

## 17.10 新增测试用例（第三轮）

| ID | 用例 | 断言 | 层 |
|---|---|---|---|
| T-E-01 | 冷启动 bootGuard 窗口时序值守 | 恢复播放的 musicToggled 必在关窗前被守卫拦下（不误记） | 集成 ⚠️（V-1/P1-2） |
| T-E-02 | 加载中切歌不污染缓存 | 旧歌晚到进度事件不得被记为新歌进度 | 单元 ⚠️（P1-1） |
| T-E-03 | 时长始终为 0 的集 | 位置>0 仍记录；位置=0 不记录（语义无害） | 单元（V-2） |
| T-E-04 | 双零点边界 | 探到 `{0,0}` 时既不缓存也不写库 | 单元（V-2） |
| T-E-05 | 不重启直接点歌（开/关 startupAutoPlay） | `isRestoringPlay` 全程 false，正常记录 | 集成（B-1 覆盖） |
| T-E-06 | `musicToggled` 带参回归 | 歌词/预加载/进度/SavedPlayInfo 四个既有监听行为不变 | 集成（V-3） |

---

# 18. 第四轮收尾复核（最后一轮）

> 复核对象：`ARCHITECTURE.md` §17（1061→1223 行）。仅验 §17.5 的 2 条待验证项 + 快速确认三项 P1 修正。
> **环境限制**：本机无 `node_modules`/无 Jest（同前）→ V-4/V-5 采用「忠实复刻脚本实测 + 可执行独立测试文件」。

## verdict: **fail（1 项 P1 阻断，须批准并实施第三处豁免）**

V-5 通过；但 **V-4 经我实测**：`cachedMaxTime` 污染存在**非自愈、用户可见**路径，**裁定：批准第三处豁免**（`playProgress.ts:42` 加 id 守卫）。

## V-4【❌ 实测：不自愈且可见 → 批准第三处豁免】

### 实测证据（忠实复刻 §17.1 修正后 B-2 + `playProgress.ts:41-42 getMaxTime`）

**场景 A（普通竞态，自愈）**：A 时长在切歌瞬间晚到、B 尚为 `cachedProgress=0`
```
步骤3(切B)后:  FLUSH A: time=30 maxTime=0   cached=B time=0 max=0
步骤4(A时长=180晚到): cached=B time=0 max=180   ← 污染发生
步骤5(B正常进度): cached=B time=5 max=240       ← 自愈（且因 cachedProgress=0，步骤4的脏值不会 flush）
```

**场景 B（滞后污染，❌ 不自愈、已落库）**：A 的 `getDuration()` **在 B 已累积 `nowPlayTime>0` 之后**才 resolve
```
B 正常中:            cached=B time=50 max=240
A stale duration 到达: cached=B time=50 max=180   ← 污染覆盖了正确 maxTime
再切 C → FLUSH:      FLUSH B: time=50 maxTime=180  ← ❌ 错误 maxTime 已写入 @audio_novel_history
```
**场景 C（最现实窗口，❌ 不自愈）**：切 B 后 B 仅 1 个 tick（1s），A 的 stale duration 到达即落库
```
cached=B time=1 max=180   →  FLUSH B: time=1 maxTime=180
```

### 严重级与用户可见后果

- **严重级：P1（阻断）**。一旦 A 的 `getDuration()`（`TrackPlayer.getDuration()`，`src/plugins/player/utils.ts:159` 原生桥调用）**悬挂跨越到 B 的首个进度 tick 之后**，B 的历史条目被写入 **A 的时长**。
- **用户可见后果**：`maxTime` 是断点续播的进度条分母。用户从历史续播 B 时，`player.ts:162 setProgress(time, maxTime)` 用错误分母 → **进度条比例错误**；且该错误值**持久化**（重启仍在），直到 B 被重新完整播放才可能刷新。非"边缘不可见"。
- **触发概率**：低（需 `getDuration` 桥调用延迟 > B 首个 tick），但**真实存在**（音频初始化解码探测、慢设备、并发 IO 时 `getDuration` 可明显滞后）。
- **`cachedProgress` 是否受影响**：**不受影响**（`playProgress.ts:30,32` 对 `setNowPlayTime` 有 id 守卫）—— 架构师该点判断**成立**。但 `maxTime` 污染**足以单独构成 P1**。

### 裁定：**批准第三处豁免**

- **批准** `src/core/init/player/playProgress.ts:42` 加 id 守卫（第三处豁免），修法（镜像 `getCurrentTime` 既有范式 `:30,32`）：
  ```ts
  const getMaxTime = async() => {
    const id = playerState.musicInfo.id            // ← 新增：快照身份
    const duration = await getDuration()
    if (id != playerState.musicInfo.id) return     // ← 新增：越界丢弃（同时跳过下方 interval 写入）
    setMaxplayTime(duration)
    ...（原 :44-56 interval 写入逻辑不变）
  }
  ```
- **附加收益**：该守卫**同时**修掉下方 `:44-56 updateListMusics` 把 **A 的 interval 写到 B 歌单** 的同类隐患。
- **变更文件清单更新**：`playProgress.ts` 由「禁止修改」→ **豁免第 42 行区域**（新增 1 行快照 + 1 行守卫）。请 architect 在 Spec 中登记。
- **若 architect 坚持不加（走"记入 backlog"）**：则**须**在 §17.5 如实标注为**已知 P1 缺陷**并在 Spec 里显式列为"遗留风险"，不得以"边缘无害"掩盖（实测已证明非自愈、可见、持久）。**我方建议：直接修，成本 2 行。**

## V-5【✅ 通过】FIFO 值守测试 —— 可执行方案

### 交付物（可直接运行）

`docs/design/audio-novel-history/guard-setimmediate-order.test.js`（已创建并实跑）
```
运行：node docs/design/audio-novel-history/guard-setimmediate-order.test.js
退出码 0 = PASS（可进 CI）
实测输出：
  PASS | 用例1 [Hermes: queueMicrotask] 冷启动不误记 | order=listener@window-open>window-closed
  PASS | 用例2 监听器严格早于关窗（FIFO 不变量） | listenerIdx=0 closeIdx=1
  PASS | 用例3 [Node: macrotask] 冷启动不误记 | order=listener@window-open>window-closed
  总体：PASS
```

### 具体断言什么 / 如何构造

- **断言的不变量**（两条）：
  1. **正向**：正确实现下，已投递的 `musicToggled` 监听器**在窗口关闭前**执行 → `isRestoringPlay` 为 true → 不误记（`recorded===false`）。
  2. **顺序**：`listener@window-open` 的下标 **严格小于** `window-closed` 下标（FIFO 不变量）。
- **构造方式**：忠实复刻「开窗 → `playList()`（同步段 emit）→ `await close()`（与 emit 同 primitive）→ 关窗」结构，`emit`/`close` **共用同一队列 primitive 注入**（生产 = `setImmediate`），分别以 `queueMicrotask`（Hermes 语义）与 `setImmediate`（Node macrotask 语义）跑两遍。

### ★ 重要更正：我第三轮的 R-V1-1（"改 setTimeout 会反转"）经实测**不成立**

- 实测四种组合（emit/close 分别为 microtask/macrotask）：**守卫全部保持有效**，无一反转。原因：Hermes 下 `microtask` 总在 `macrotask` 之前排空，且 `await playList()` 的续体也在 microtask 队列中，监听器恒在关窗前执行。
- ⟹ **R-V1-1 由 P1 降级为"无实际问题"**：bootGuard 对 setTimeout/setImmediate 的队列选择**不敏感**。第三轮我的告警**过虑了**，此处如实更正。注释锁定（§17.2）仍有文档价值，保留；但**不再列为风险**。

### 落地方式（开发能做、QA 能验）

| 层 | 方式 | 谁执行 |
|---|---|---|
| **L1 纯逻辑值守**（本交付物） | `node guard-setimmediate-order.test.js`，退出码判定 | 开发提交前 / CI / QA 手工 |
| **L2 RN 集成值守**（§16.7-1 T-E-01） | 真机冷启动（上次进度 time>0 + 开/关 startupAutoPlay）→ 断言 `getAudioNovelHistory()` **不含启动曲** | QA 真机 |
| **L3 变异自检** | 改关窗为 `setTimeout` 后 L1 仍应 PASS（证明已对队列选择不敏感） | 开发 |

> 注：L1 已**放弃**"变异必反转"用例（实测不成立，保留会误报）。若后续 RN 升级改回真 macrotask 语义，L1 的用例 3 仍覆盖。

## 18.9 三项 P1 修正到位确认（快速核对）

| 项 | 结论 | 证据 |
|---|---|---|
| **P1-1** 恒等死代码 | ✅ 已删，改为「`musicToggled` 快照 musicId 作权威身份 + 进度事件只更新数值」；注释**如实说明**依赖 `playProgress.ts:30,32` 既有守卫 | `ARCHITECTURE.md:1088-1127` |
| **P1-2** §16.1 表述 | ✅ 已更正为「同一实现、同一队列、FIFO」，无残留错误依据（仅历史引用保留"原（错误）"字样） | `ARCHITECTURE.md:813,1142-1143`；grep 无 live "macrotask FIFO" |
| **P1-3** teardown | ✅ `destroyAudioNovelHistory()` 已写明**新增**到 `core/common.ts:57-61`；`Promise.all` 并列 + 内部**不读 playerState**（解耦）方案成立 | `ARCHITECTURE.md:1178-1193` |

## 18.10 第四轮 blocking / advisory 汇总

**blocking（1 项）**：
| # | 问题 | 证据 | 期望 |
|---|---|---|---|
| B-3 | `cachedMaxTime` 污染**非自愈且用户可见**（场景 B/C 实测落库错误 maxTime） | 复刻实测输出（§18 V-4）；`playProgress.ts:41-42` 无 id 守卫；`utils.ts:159` 原生桥调用 | **批准并实施第三处豁免**：`playProgress.ts:42` 加 id 守卫（2 行，镜像 `:30,32`）；同时修掉 `:44-56` interval 误写 |

**advisory**：
| # | 建议 | 理由 |
|---|---|---|
| A-6 | 采纳交付的可执行值守测试 `guard-setimmediate-order.test.js` 进 CI | 锁定 bootGuard 顺序不变量（V-5） |
| A-7 | 第三轮 R-V1-1 更正为"无实际问题"，不列入风险清单 | 实测四组合均不反转（V-5） |
| A-8 | 变更文件清单登记 `playProgress.ts` 第三处豁免 | 影响后续 Spec |

## 18.11 新增测试用例（第四轮）

| ID | 用例 | 断言 | 层 |
|---|---|---|---|
| T-F-01 | 切歌瞬间旧歌 `getDuration` 晚到（B 已 tick>0） | 旧歌时长**不得**写入 B 的 `maxTime`；B 历史 maxTime = B 真实时长 | 单元 ⚠️（B-3） |
| T-F-02 | `getMaxTime` id 守卫回归 | 越界返回时既不 `setMaxplayTime` 也不 `updateListMusics` | 单元（B-3） |
| T-F-03 | 顺序不变量值守 | `node guard-setimmediate-order.test.js` 退出码 0 | 纯逻辑（V-5） |
| T-F-04 | 真机冷启动零新增（含 time>0 + 开关 autoPlay） | 历史不含启动曲 | 集成（T-E-01 复跑） |

> **附**：本目录新增可执行测试文件 `guard-setimmediate-order.test.js`（V-5 交付物），README 无需改动。




---

## 19. CI 产物 / `.gitignore` 合规值守（第五轮，只读核查）

> 审查对象：新增 `.github/workflows/ci-build-check.yml` + 仓库 `.gitignore`
> 约束：**全程只读** —— 未执行 `npm ci`/`install`/任何构建命令，未修改任何文件。
> 证据命令：`git check-ignore -v -n --no-index --stdin`、`git ls-files`、`git status`、`ls`、`cat`。

### 19.0 关键前提：CI 本身不会提交产物

| 检查 | 命令 | 结果 |
|---|---|---|
| workflow 是否含提交动作 | `grep -nE 'git (add\|commit\|push)\|upload-artifact\|git-auto-commit' ci-build-check.yml` | **无匹配（grep code=1）** |
| workflow 步骤清单 | 读文件 | checkout → setup → `npm run lint` → `npm run build-test`，**止于此，无 commit/push/upload** |

**结论**：CI 运行在 runner 的临时工作区，产物随 runner 销毁，**不可能**被提交进仓库。
→ 新增 CI 工作流本身的「产物入库」风险 = **无**。

### 19.1 真正的风险面：开发者本地跑 `npm run build-test`

`package.json:16`：
```
"build-test": "react-native bundle --platform android --dev true --entry-file index.js --bundle-output index.android.bundle --assets-dest res"
```
输出落在**仓库根目录**：`./index.android.bundle` + `./res/**`。
`package.json:15` bundle-android 输出：`android/app/src/main/assets/index.android.bundle` + `android/app/src/main/res`。

以下逐条用 `git check-ignore -v -n --no-index --stdin` 权威判定（`::` 前缀 = 未忽略）。

### 19.2 判定表（权威实测）

| # | 路径 | 产出源 | 是否被忽略 | 依据（.gitignore 匹配） | 实测输出 |
|---|---|---|---|---|---|
| 1 | `./index.android.bundle` | `build-test` | ❌ **未忽略** | 无任何规则匹配 | `::\tindex.android.bundle` |
| 2 | `./res/**`（如 `res/drawable-mdpi/foo.ttf`） | `build-test` | ❌ **未忽略** | 无任何规则匹配（`.gitignore` 全文件无 `res` 字串） | `::\tres/drawable-mdpi/foo.ttf` |
| 3 | `android/app/src/main/assets/index.android.bundle` | `bundle-android` | ❌ **未忽略** | 无规则匹配；`assets/` 下仅 `fonts/`、`script/` 被跟踪 | `::\tandroid/app/src/main/assets/index.android.bundle` |
| 4 | `android/app/build/**` | gradle assemble* | ✅ 已忽略 | `.gitignore:27 build/` | `.gitignore:27:build/\tandroid/app/build/outputs/.../app-release.apk` |
| 5 | `node_modules/` | `npm ci` | ✅ 已忽略 | `.gitignore:38 node_modules/` | `.gitignore:38:node_modules/\tnode_modules/` |
| 6 | `android/app/debug.keystore` | 仓库自带 | ⚠️ **被跟踪**（negation 豁免） | `.gitignore:46 !debug.keystore`（反向覆盖 `:45 *.keystore`） | `.gitignore:46:!debug.keystore\tandroid/app/debug.keystore` |
| 7 | `*.keystore`（非 debug，如 `release.keystore`） | 本地签名 | ✅ 已忽略 | `.gitignore:45 *.keystore` | `.gitignore:45:*.keystore\tandroid/app/other.keystore` |

### 19.3 七个待查问题的逐条回答

1. **`index.android.bundle`（根）会否被误提交？** → **会**（风险成立）。无规则忽略（判定表 #1）。本地执行 `build-test` 后 `git status` 会显示 `?? index.android.bundle`。
2. **根目录 `res/` 会否被误提交？** → **会**（风险成立）。`.gitignore` 内**完全没有** `res/` 规则（`grep -n 'res' .gitignore` 无输出；`git show HEAD:.gitignore | grep res` 退出码 1）。判定表 #2。
3. **`android/app/build/` 是否已被覆盖？** → **是，已安全**。`.gitignore:27 build/` 命中。判定表 #4。无风险。
4. **`android/app/src/main/assets/index.android.bundle`（bundle-android 产物）是否被覆盖？** → **否，未忽略**（风险成立）。判定表 #3。同名目录下 `fonts/`、`script/` 是被跟踪的实体文件，故目录本身不能整体忽略。
5. **`debug.keystore` 是否被跟踪/是否错误忽略？** → **被跟踪，且这是设计意图**。`git ls-files | grep keystore` 仅返回 `android/app/debug.keystore`；`.gitignore:46 !debug.keystore` 是对 `:45 *.keystore` 的显式反向豁免（RN 模板标准做法，debug 签名公开无害）。**合规，无风险**。
6. **`node_modules/` 是否被覆盖？** → **是，已安全**。`.gitignore:38 node_modules/`。判定表 #5。
7. **当前工作区是否已被产物污染？** → **否**。`git status --short` 仅 3 项：`?? .github/workflows/ci-build-check.yml`、`?? .workbuddy/`、`?? docs/`，**无任何 bundle/res 产物**。说明核查时点干净。

### 19.4 关于 `git check-ignore` 的"幽灵规则"说明（复现方法学）

初测 `git check-ignore -v <path>`（不带 `--no-index`）对**所有**路径返回 exit=1，包括本应忽略的 `node_modules`。原因：**待查路径在磁盘上几乎都不存在**（`ls` 实测 6 条中 5 条 MISSING），`check-ignore` 对不存在路径的判定受 index 状态影响。

修正方法：改用 `git check-ignore -v -n --no-index --stdin`（`-n` 强制对未匹配项也输出 `::`），得到可复现的权威结果。另观察到 git 2.55.0 在 **worktree + CRLF `.gitignore`** 环境下，对带尾斜杠路径的 `(lineno:pattern)` 报告存在错位（曾报 `.gitignore:66:　res/`，而第 66 行实为空行、全文件无 `res` 规则）——故本表**只采信 `::`/匹配前缀**，不采信报告的行号。

### 19.5 裁决

| 项 | 结果 |
|---|---|
| CI workflow 自身导致产物入库 | ✅ **无风险**（无 commit/push/upload） |
| 依赖目录入库（`node_modules`） | ✅ **无风险**（已忽略） |
| gradle 构建产物入库（`android/app/build`） | ✅ **无风险**（已忽略） |
| **JS bundle 产物入库（根 `index.android.bundle` + 根 `res/`）** | ❌ **风险成立**（未忽略，判定表 #1/#2） |
| **`bundle-android` 产物入库（`assets/index.android.bundle`）** | ❌ **风险成立**（未忽略，判定表 #3） |
| keystore 策略 | ✅ 合规（debug 豁免为有意设计） |
| 当前工作区污染 | ✅ 干净 |

**总判定：`conditional-fail`** —— CI 工作流本身安全，但 `.gitignore` 对两条 JS bundle 产出路径**覆盖不足**，存在开发者本地误提交风险。

### 19.6 最小修复方案（只描述，不实施）

在仓库根 `.gitignore` 追加（建议置于 `# Bundle artifact` 区块，与 `:61 *.jsbundle` 相邻）：
```gitignore
# RN bundle 产物（build-test / bundle-android 输出）
/index.android.bundle
/res/
android/app/src/main/assets/index.android.bundle
```
> 说明：根路径用 `/` 前缀锚定，避免误伤 `assets/` 下被跟踪的 `fonts/`、`script/`；`assets/index.android.bundle` 用完整相对路径精确忽略单文件而非整个 `assets/` 目录。
> 此三条**不改变任何已跟踪文件状态**（三者现均未被跟踪），零回归面。

**验收断言（修复后应满足）**：
```
printf '%s\n' index.android.bundle res/x.png android/app/src/main/assets/index.android.bundle \
 | git check-ignore -v --no-index --stdin   # 三条均须命中，退出码 0 且无 '::' 前缀
git ls-files | grep -E 'index\.android\.bundle|^res/'   # 必须无输出
```
