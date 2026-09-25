# 有声小说播放历史 — UI/UX 设计文档

> 设计师：颜好看 | 模块：本地播放历史（有声小说场景）
> 项目：洛雪音乐助手移动版（React Native / Android）
> **设计原则：复用项目既有 theme Token 与通用组件，不引入新视觉语言。**
> 本文所有 Token 名、组件路径均来自实际代码勘测（附文件路径 + 行号）。

---

## 0. 勘测结论速览（先读这段）

| 维度 | 结论 |
|------|------|
| 颜色体系 | **无 CSS 变量**，走 `useTheme()` 返回的 `LX.ActiveTheme` 对象；Token 是 `c-xxx` 键名的**运行时 JS 字符串值**（不是 CSS var） |
| 主题色来源 | `src/theme/themes/createThemes.js` → 由 primary/font 推导出 300+ 个 `c-*` 色阶 |
| 语义 Token 命名 | 前景 `c-font` / `c-font-label`；主色 `c-primary` / `c-primary-font`；背景 `c-primary-background` / `c-primary-background-hover`；按钮 `c-button-background` / `c-button-font`；内容区 `c-content-background`；边框 `c-border-background` |
| 字号 | **无 Token 常量体系用于运行时**，`<Text size={n}>` 直接传数字（默认 15），内部 `setSpText` 做像素比缩放 |
| 间距 | **无间距 Token**，各组件内联数字（4/5/8/10/12/15/25 混用），节奏 ≈ 4px 网格但未抽象 |
| 图标 | **锁定 `@/components/common/Icon`**，底层是 **IcoMoon 自定义字体**（`src/resources/fonts/selection.json`，共 52 个图标），**非 Ionicons/MaterialIcons** |
| 列表项基线高度 | `ITEM_HEIGHT = scaleSizeH(40)`（`MyList/List.tsx:19`）；音乐列表 `LIST_ITEM_HEIGHT`（`MusicList/ListItem.tsx:13`） |
| 圆角 | 全局约定 `borderRadius: 4`（`ConfirmAlert.tsx:44`、`HistorySearch.tsx:126`、`CreateUserList.tsx:65`） |
| 深色模式 | 由主题 `isDark` 决定，**同一套 `c-*` Token 自动映射**，无需单独写 `data-theme` |

**因此本设计的所有颜色必须写成 `theme['c-xxx']`，绝不允许出现裸 hex 值。**

---

## 1. 视觉主题与氛围

- **关键词**：沉浸、续读、克制、可信
- **氛围**：延续项目既有「内容优先」的紧凑列表风格（对标 `MusicList/ListItem.tsx` 的双行信息结构）。历史页是**工具型页面**（Product Register），动效克制、无装饰性动画。
- **寄存器判断**：Product Register（工具/产品内页）。标杆 = 项目自身的音乐列表页，**不是**营销页。
- **三轴刻度**：Variance=3（列表类页面需可预测）/ Motion=3（仅状态反馈）/ Density=6（信息密度略高于音乐列表，因含进度+时间戳）

### 与「音乐播放列表」的差异化（关键）
有声小说场景下必须让用户**一眼看出「这是第几集、听到哪了」**，而非「这是一首歌」：

| 层级 | 有声小说历史 | 音乐列表（现有） |
|------|-------------|-----------------|
| L1 第一视觉 | **作品名**（书名） | 歌曲名 |
| L2 第二视觉 | **第 N 集**（+ 分卷/章节名，如有） | 歌手 · 专辑 |
| L3 辅助 | **进度 + 相对时间** | 时长 |
| 左侧序号槽 | **保留**，但语义改为「播放状态 / 集数徽标」 | 音轨序号 |

---

## 2. 色彩与角色（Token 全部来自实际代码）

> 来源：`src/theme/themes/index.ts:48-97`（`buildActiveThemeColors`）+ `src/types/theme.d.ts:263-283`（`ActiveTheme` 类型定义）

### 2.1 本模块用到的 Token 映射表

| 设计用途 | Token（`theme['...']`） | 定义位置 | 说明 |
|----------|------------------------|----------|------|
| 页面/列表容器背景 | `c-content-background` | themes/index.ts:93 | 内容区背景 |
| 列表项主文字（作品名） | `c-font` | themes/index.ts:77 | 主前景色 |
| 次级文字（集数/进度） | `c-500` | createThemes.js:47（字体灰阶） | 次级灰 |
| 三级文字（相对时间/元数据） | `c-350` | 同上 | 更浅的灰（现有 `dots-vertical` 图标即用此色，见 `MusicList/ListItem.tsx:73`） |
| 行内极淡文字 | `c-250` | 同上 | 现有 `item.interval` 时间戳用色（`ListItem.tsx:67`） |
| 分割线 / 列表头底边 | `c-border-background` / `c-list-header-border-bottom` | themes/index.ts:94 / :92 | 边框 |
| 强调色（进度条、播放中标记、主按钮） | `c-primary` | themes/index.ts:79 | 品牌主色 |
| 强调色文字（播放中标题） | `c-primary-font` | themes/index.ts:79 | 现有 `active` 态标题色 |
| 进度条填充 | `c-primary` | — | 强调色，全屏仅此 1 处 + 播放中标记 = ≤2 处 |
| 进度条轨道 | `c-primary-light-600-alpha-300` | createThemes.js:22 | 极淡主色轨道 |
| 次级按钮背景（确认弹窗的取消钮） | `c-button-background` | themes/index.ts:88 | 现有 `ConfirmAlert.tsx:115` 用色 |
| 次级按钮文字 | `c-button-font` | themes/index.ts:86 | 同上 |
| 危险操作文字（删除） | `c-primary`（**不新增红色 Token**） | — | 项目**无独立 danger 色 Token**；沿用主题主色或纯文字按钮 |
| 选中态背景（长按选中行） | `c-primary-background-hover` | themes/index.ts:83 | 现有 `MusicList/ListItem.tsx:47` 用色 |
| 输入框背景（开关说明等） | `c-primary-input-background` | themes/index.ts:85 | — |
| Help 图标 | `c-font`（Icon 默认） | `Icon.tsx:47` | `Icon` 组件缺省色 |

### 2.2 [注意] 缺失 Token 标注（诚实声明）
- **项目无 `--danger` / `--success` / `--warn` 语义色 Token。** 删除操作**不**引入红色新色值，改为：
  - 列表项删除 → 走现有的 `MenuItem` 文字按钮 + 二次确认弹窗（沿用 `list_remove_tip` 文案体系）。
  - 这正是项目现有「移除列表」「移除歌曲」的做法（`MyList/listAction.ts:13`、`MusicList/ListMenu.tsx:84`）。
- **项目无间距 Token。** 本设计统一约定：行内间隙用 4/5，列表项左右 padding 用 5（对齐 `MyList/List.tsx:150-152`），图标与文字间隙用 5，块间距用 10/15。

### 2.3 每屏强调色约束
- `c-primary` 仅用于：① 播放中行的标题文字/左标记；② 进度条填充。**同屏可见 ≤2 处**。
- 相对时间、集数、次要信息一律用中性灰阶（`c-500` / `c-350` / `c-250`），**不得用主色**。

---

## 3. 排版

> 来源：项目 `<Text>` 组件（`src/components/common/Text.tsx:32`，`size` 默认 15，内部 `setSpText(size)` 做像素比缩放）。
> **注意：项目不使用粗细字体族做层级（`FontWeights` 常量仅在 `theme/Typography.js` 定义但未被业务组件使用），而是靠「字号 + 颜色灰阶」建立层级。**

### 3.1 字号阶梯（本模块采用，均为整数）

| 用途 | `size` | color Token | 备注 |
|------|--------|-------------|------|
| 作品名（L1） | 15（默认） | `c-font` / 播放中 `c-primary-font` | 与音乐列表歌曲名一致 |
| 集数 · 章节名（L2） | 11 | `c-500` | 对齐 `MusicList/ListItem.tsx:60` 的歌手行 |
| 进度时间点 / 相对时间（L3） | 11–12 | `c-350` / `c-250` | 对齐时间戳用色 |
| 相对时间独立行（可选） | 12 | `c-250` | 参考 `ListItem.tsx:67` |
| 空态标题 | 15 | `c-font` | — |
| 空态说明 | 13 | `c-500` | — |
| 页面标题（分栏 Header） | 16 | `c-font` | 对齐 `Section.tsx:18` |
| 弹窗标题 | Dialog 默认 | — | 复用 `Dialog` 组件 |

### 3.2 字重
- 全部走 `<Text>` 默认字重；`itemInfo` 次级行沿用现有 `fontWeight: '300'`（`ListItem.tsx:135`）。
- **不新增字重层级**（项目 Typography.js 的 `FontWeights` 未被使用，不引入以防破坏主题）。

### 3.3 截断
- 作品名：`numberOfLines={1}`（对齐 `ListItem.tsx:56`）。
- 长集数标题（如「第 128 集 · 大结局（下）」）：`numberOfLines={1}`，超出省略。
- 相对时间：不截断（固定短字符串）。

---

## 4. 组件规范（复用映射，全部来自实际代码）

### 4.1 复用组件清单

| 设计元素 | 复用现有组件 | 路径 | 复用方式 |
|----------|-------------|------|----------|
| 列表容器 + 虚拟滚动 | `FlatList` | RN 内置 | 沿用 `MyList/List.tsx:119` 的 `getItemLayout` + `removeClippedSubviews` 范式，保证 500 条不卡顿 |
| 列表项行 | 仿 `MyList/ListItem.tsx` / `MusicList/ListItem.tsx` 结构 | `src/screens/.../MyList/ListItem.tsx` | **新建 `HistoryListItem`，结构照抄，不修改原组件** |
| 主/次文字 | `Text` | `src/components/common/Text.tsx` | 直接复用，传 `size`/`color` |
| 所有图标 | `Icon` | `src/components/common/Icon.tsx` | 直接复用，`name` 见 §5 |
| 行内徽标（源标识） | `Badge` | `src/components/common/Badge.tsx` | 可复用（如需标注「本地/在线源」） |
| 可点击区域 | `Button`（Pressable 封装，带 Android ripple） | `src/components/common/Button.tsx` | 复用；ripple 色已按主题自动取 `c-primary-light-200-alpha-700` |
| 三点菜单（更多操作） | `Menu` + 现成 `dots-vertical` 范式 | `src/components/common/Menu.tsx` + `MusicList/ListItem.tsx:72` | 复用，菜单项文字走 i18n |
| 二次确认弹窗 | `ConfirmAlert`（内置 Dialog） | `src/components/common/ConfirmAlert.tsx` | **清空全部**用它；或轻量场景用 `confirmDialog()`（`utils/tools.ts:186`，即现有「移除列表」用法） |
| 加载指示 | `Loading` | `src/components/common/Loading.tsx` | 加载态复用 |
| Toast 提示 | `toast()` | `src/utils/tools.ts:107` | 删除成功/清空成功反馈 |
| 设置分组标题 | `Section` | `src/screens/Home/Views/Setting/components/Section.tsx` | 设置项分组（左侧 5px 主色竖条，`Section.tsx:33`） |
| 分段切换控件 | 复用 `SearchTypeSelector` 的横向下划线 tab 范式 | `.../Search/SearchTypeSelector.tsx:38-47` |
| 歌单开关（小说模式） | `Menu` 扁平菜单项（动词短语，点击切换） | `.../MyList/ListMenu.tsx:89-100` + `Menu.tsx:17` |
| 设置分组（如最终采用设置页） | `Section` | `.../Setting/components/Section.tsx:13` |
| 下拉/操作面板 | `DorpDownMenu` / `Popup` | `src/components/common/` | 若菜单需面板形态时可用 |

> **说明**：项目未使用 RN 的 `<Switch>`，设置项统一用 `CheckBox` 范式（`CheckBox/index.tsx:85`）——**因此「有声小说开关」也应用 CheckBox 风格，保持一致**。

### 4.2 新增组件（最小集，遵循既有范式）

| 新组件 | 位置建议 | 说明 |
|--------|----------|------|
| `HistoryListItem` | `src/screens/Home/Views/<History>/ListItem.tsx` | 结构照抄 `MusicList/ListItem.tsx` |
| `HistoryList` | 同上 `List.tsx` | 照抄 `MyList/List.tsx` 的 FlatList 配置 |
| `HistoryMenu` | 同上 `ListMenu.tsx` | 照抄 `MusicList/ListMenu.tsx`，菜单项：重新续播 / 删除该记录 |

---

## 5. 图标语义清单（IcoMoon 图标库，全项目唯一）

> 图标库结论：项目锁定 **IcoMoon 自绘字体**（`src/resources/fonts/selection.json`，52 个图标），通过 `@/components/common/Icon` 调用。
> **结论：禁止 emoji，也禁止引用 Ionicons/MaterialIcons 等外部集**（`Icon.tsx:8-21` 中所有外部图标集导入均已被注释禁用）。
> 尺寸约定：16px（行内）/ 20px（按钮内）/ 24px（独立图标）；项目现状惯用 12–15px 小图标（如 `dots-vertical` size=12），本模块沿用小尺寸以匹配紧凑列表。

| 语义 | IcoMoon 图标名 | 现成可用？ | 尺寸 | 依据 |
|------|---------------|-----------|------|------|
| 历史（模块入口 / 空态） | `music_time` | 是 | 24（独立）/ 15（行内） | 已存在于 52 图标集 |
| 续播 / 播放 | `play-outline` | 是 | 13（列表内，对齐 `ListItem.tsx:51`） | 已用于「播放中」标记 |
| 续播 / 开始播放 | `play` | 是 | 20（按钮内） | 现成 |
| 更多操作（三点） | `dots-vertical` | 是 | 12 | 现成，列表项右侧标准 |
| 删除单条 | `remove` | 是 | 16（菜单项）/ 20 | **优先用 `remove`**（`minus-box` 语义偏「移除框」，`close` 偏「关闭」） |
| 清空全部 | `eraser` | 是 | 14–16 | 现有「清空搜索历史」即用 `eraser`（`HistorySearch.tsx:84`）→ **保持一致** |
| 返回上一级 | `chevron-left` / `back-2` | 是 | 20 | 现成 |
| 右箭头（列表项指示） | `chevron-right` | 是 | 12 | 现成 |
| 加载中 | `Loading` 组件（ActivityIndicator） | [是] | — | `Loading.tsx` |
| 帮助说明（开关旁） | `help` | 是 | 15 | `CheckBox/index.tsx:65` 已用 |

**[注意] 需向架构师确认的缺口**：空态若想要「有声小说」专属语义图标，图标集内**没有**「书本/耳机/章节」类图标（现有 `album`/`music_time` 最接近）。**建议：不新增图标**，空态用 `music_time` + 真实文案引导；若产品坚持要书本图标，需补充 IcoMoon 字体资源并重跑 `npm run build:theme` 流程——**属阻塞项，标记为 advisory**。

---

## 6. 历史列表页布局方案

### 6.1 页面定位
- 作为「我的列表」/侧边栏的一个新入口（或设置内的独立页）。
- 页面复用现有 Home 内容区容器（`c-content-background` 背景）。

### 6.2 列表项线框（单行高度建议 `scaleSizeH(52)`，比音乐列表略高以容纳进度）

```
┌──────────────────────────────────────────────────────────────┐
│ [左槽 38px]  ┌─ itemInfo (flexGrow:1) ────────────────┐  [更多] │
│              │  作品名（size15, c-font / 播放中主色）  │  dots-  │
│  ▶ / 集数    │  ─────────────────────────────────────  │ vertical│
│  徽标        │  第 N 集 · 章节名        〔进度 12:30/45:00〕  │  (12px) │
│              │  size11 c-500           size11 c-250    │         │
│              └─────────────────────────────────────────┘         │
│  ══════════ 进度条（2px，c-primary 填充 / c-primary-light 轨道）══ │  ← 行底部对齐
└──────────────────────────────────────────────────────────────┘
                         ↑ 相对时间「3分钟前」放哪？
```

**相对时间放置决策（3 选 1，推荐 A）**：

- **方案 A（推荐）**：把相对时间放在**第二行右侧**，与进度并列，格式 `3分钟前`，色 `c-250`。
  - 优点：一行容纳全部信息，行高可控（52px），信息密度高，符合项目紧凑列表风格。
  - 布局：`itemInfo` 第二行做 `flexDirection:'row'`，左侧「第 N 集」`flexGrow:1`，右侧相对时间 `flexShrink:0`。
- 方案 B：相对时间独立成第三行 → 行高增至 ~66px，列表变稀，**不推荐**（违背 VISUAL_DENSITY=6）。
- 方案 C：相对时间替换左槽数字 → 丢失播放状态提示，**不推荐**。

### 6.3 左侧槽设计（38px，对齐 `ListItem.tsx:107` 的 `sn` 宽度）
- **正在播放的行**：显示 `play-outline` 图标（13px，`c-primary-font`）——对齐 `MusicList/ListItem.tsx:51`。
- **非播放行**：显示「续播」语义提示？→ **不放图标**，左槽留空或显示集数迷你徽标。**决策：留空**，避免每行两个强调色图标（违反 ≤2 处强调色）。
- 有声小说可考虑左槽显示「集数徽标」如 `第12集`——但会导致文本挤压，**不采用**，集数放第二行左端更清晰。

### 6.4 进度条实现
- 复用项目进度条范式：`src/components/player/ProgressBar.tsx`（参考其填充/轨道色用法）。
- 高度 2px，位于列表项底部整宽，`c-primary` 填充 + `c-primary-light-600-alpha-300` 轨道。
- 若渲染成本敏感：改用「文字百分比」（`45%`）替代横条 → **推荐文字**，减少 500 行渲染压力。**二者二选一，默认文字百分比**（`size11 c-250`，如 `已听 28%`）。
- **数据显示口径（数据层已定）**：进度**存原始时间点（秒）**。文字方案需展示百分比时，由 `已播放秒数 / 该集总时长秒数` 换算；也可直接展示时间点 `12:30 / 45:00`（更直观，不依赖总时长是否准确）。**推荐时间点方案**，避免总时长缺失导致百分比失真。
- **集数标题**：用 `musicInfo.name`（数据层已定）；**相对时间**：用 `dateFormat2(item.updateTime)`（见 §9.1）。

---

## 6.5 页面结构落点（已与 team-lead / 架构师对齐）

### 6.5.1 入口与目录结构（team-lead 已裁决）
- **不新增顶层导航项**（架构师证明 `Main.tsx:181-193` 的 `viewMap` 是硬编码 5 项，新增会破坏 PagerView 索引映射）。
- **入口改造**：`src/screens/Home/Views/Mylist/index.tsx:52-68` 目前是：
  ```tsx
  const navigationView = () => <MyList />      // 抽屉导航栏
  ... <MusicList />                            // 主内容
  ```
  改造为「**我的歌单 / 播放历史**」分段切换：抽屉导航区增加一个分段控件，主内容区按选中段渲染 `MusicList`（歌单）或 `PlayHistory`（历史）。
- **历史列表独立目录**（与 `MyList/` 平级）：
  ```
  src/screens/Home/Views/Mylist/
  ├── MyList/           (现有)
  ├── MusicList/        (现有)
  └── PlayHistory/      (新增)
      ├── index.tsx     (页面容器 + 空/加载态)
      ├── List.tsx      (FlatList，照抄 MyList/List.tsx 范式)
      ├── ListItem.tsx  (行组件，照抄 MusicList/ListItem.tsx 范式)
      └── ListMenu.tsx  (三点菜单：继续听 / 删除该记录)
  ```

### 6.5.2 分段切换控件 —— [注意] 项目无现成分段控件组件（明确声明）
**项目 `src/components/common/` 下没有 segmented/tab/switch 类通用组件**（已实测 `ls` 确认）。但项目**已有该视觉范式的现成实现**，直接照抄即可，**无需发明新组件**：

> **参照 `src/screens/Home/Views/Search/SearchTypeSelector.tsx:38-47`**：
> ```tsx
> <ScrollView horizontal>
>   {list.map(t => (
>     <TouchableOpacity style={styles.button} onPress={...} key={t.id}>
>       <Text
>         style={{ ...styles.buttonText,
>           borderBottomColor: type == t.id ? theme['c-primary-background-active'] : 'transparent' }}
>         color={type == t.id ? theme['c-primary-font-active'] : theme['c-font']}>
>         {t.label}
>       </Text>
>     </TouchableOpacity>
>   ))}
> </ScrollView>
> ```
> 关键样式（`SearchTypeSelector.tsx:59-79`）：`buttonText` 有 `borderBottomWidth: BorderWidths.normal3`（1.4px）+ `paddingTop/Bottom: 3` + 左右 padding 8 → **下划线式 tab**，激活态下划线用 `c-primary-background-active`、文字用 `c-primary-font-active`。

**方案**：把 `SearchTypeSelector` 的「横向 + 下划线激活」范式复用到 `Mylist` 的抽屉导航区，两项 = `我的歌单` / `播放历史`（i18n：复用 `list_name_*` 风格的 `history_title`=`播放历史`，歌单项复用现有歌单项文案）。
- 也可直接抽出一个 `SegmentTab` 组件供两处共用，**但初版建议内联复用样式**，降低改动面（`SearchTypeSelector` 是业务组件，未抽象为通用组件——不擅自重构它）。

### 6.5.3 该结构下的设计自检
- 分段切换用**下划线**（`BorderWidths.normal3`=1.4px），不是药丸/填充块 → 与项目搜索页 tab 完全一致，无新视觉语言。
- 激活色 `c-primary-font-active` / `c-primary-background-active` 均为**主题 Token**，随主题自动变化。
- 抽屉导航区空间有限（`widthPercentage:0.82`，`Mylist/index.tsx:60`），两项下划线 tab 足够容纳，不换行。

---

## 7. 各状态设计

> 依据：项目的 5 态标准（`token-standard.md §9`）+ 项目现有空态/加载态写法。

### 7.1 正常态（Populated）
- FlatList 渲染历史记录，按 `最近播放时间` **倒序**（最新在最上）。
- 每行如上 §6.2，支持点击续播、右侧 `dots-vertical` 打开菜单。

### 7.2 空态（Empty）— 文案必须有真实引导价值
- 项目现有空态参考：`list_select_local_file_empty_tip`、`list_loading` 等 i18n key 风格。
- **不写「暂无数据」**。采用 **图标 + 主文案 + 引导说明**：

```
        [ music_time 图标 24px, c-350 ]

        还没有听过有声小说

   在歌单里打开「有声小说」模式后，
   抓取并播放任意一集，这里会自动记录
   你听到的位置，方便下次接着听。

             [ chevron-left 返回歌单 ]  ← 可选次要操作
```

- 空态标题：`size 15, c-font`
- 空态说明：`size 13, c-500`，`textAlign:center`，左右 padding 15
- 不放置 emoji（`list_error` 现有文案含 emoji (哭脸) 属**既有历史包袱**，本模块新增文案**不允许**含 emoji）

### 7.3 加载态（Loading）
- 复用 `Loading` 组件（`Loading.tsx`），居中显示，颜色自动取 `c-font-label`。
- 可选带 label（`Loading` 支持 `label` prop）：文案「正在读取播放记录…」（新增 i18n key）。
- 首屏（读本地存储）通常极快，可仅显示 ActivityIndicator，不加骨架屏（项目无骨架屏范式）。

### 7.4 删除中态（Deleting）
- 项目现有「移除」是**同步即时**的（`removeListMusics` → 事件刷新，`MyList/listAction.ts`），无 loading 态。
- **保持一致**：删除单条 → 立即从列表移除（乐观更新）+ 可选 `toast('已删除')`；删除失败才回滚（极罕见）。
- 清空全部 → 确认后立即清空 + `toast('已清空播放历史')`。
- **不引入**逐行 spinner（项目无此范式）。

### 7.5 边界态（Edge）
- **超长作品名**：`numberOfLines={1}` 省略号（复用 `ListItem.tsx:56`）。
- **超过 500 条**：见 §10。
- **集数 > 1000**：文本 `第 1024 集` 正常显示，不特殊处理。
- **进度时间异常（>总时长）**：UI 层 clamp 到 100%，不显示负数。

---

## 8. 交互流程

### 8.1 断点续播（从历史进入）
```
用户点击历史记录行
  → 触发 onPress（对齐 MusicList 的 handlePress 范式）
  → 若该「作品」歌单未处于激活态：setActiveList(作品歌单 id)
  → 定位到对应集 index（scrollToIndex，viewPosition:0.3，对齐 List.tsx:92）
  → 播放该集 + seek 到记录进度时间点
  → 播放开始后，该行左槽出现 play-outline（c-primary-font），标题变 c-primary-font
```
- **反馈**：点击即播放（项目现有列表点击即播放，`List.tsx:231` handlePlay），**不加二次确认**。
- 播放中行需要与列表播放态联动：复用 `usePlayIndex()` 逻辑（`List.tsx:34`）。

### 8.2 删除单条
- **决策：三点菜单（`dots-vertical`）+ 菜单项「删除该记录」**，**不做左滑删除**。
  - 理由：全项目列表统一用「三点菜单」范式（`MyList/ListItem.tsx:58`、`MusicList/ListItem.tsx:72`），**项目无左滑删除实现**，引入 swipeable 会破坏交互一致性且需新增手势依赖。
- 菜单结构（照抄 `MusicList/ListMenu.tsx:71-85` 的 menus 数组形态）：
  ```
  [ { action: 'resume',  label: t('history_resume') },   // 重新续播
    { action: 'remove', disabled: false, label: t('delete') } ]  // 删除该记录
  ```
- 点击「删除」→ 立即移除该行（乐观更新）+ toast。

### 8.3 清空全部
- 入口：页面右上角 `eraser` 图标按钮（对齐 `HistorySearch.tsx:83-85` 的「清空搜索历史」）。
- 点击 → `ConfirmAlert`（或 `confirmDialog`）二次确认：
  ```
  ┌────────────────────────────────────┐
  │            清空播放历史              │  ← Dialog title
  │                                    │
  │  将清空全部 128 条播放记录，         │  ← 正文（含真实条数）
  │  清空后无法恢复。                   │
  │                                    │
  │   [   取消   ]      [  清空  ]      │  ← 取消 = c-button-background
  └────────────────────────────────────┘
  ```
- 文案措辞对齐现有 `list_remove_tip`（「你真的想要移除「{name}」吗？」）的语气 → **本项目风格偏口语直给**，故：
  - 标题：`清空播放历史`
  - 正文：`将清空全部 {n} 条播放记录，清空后无法恢复。`
  - 取消按钮：`取消`（复用 i18n `cancel` / `dialog_cancel`）
  - 确认按钮：`清空`（新增 key `history_clear_confirm`）
- 确认后 → 清空 + `toast('已清空播放历史')`。

### 8.4 「有声小说」开关（歌单菜单项 —— 已与架构师对齐）

> **落点（架构师已定）**：`src/screens/Home/Views/Mylist/MyList/ListMenu.tsx`，即**歌单三点菜单**（歌单右键菜单 = 歌单元数据编辑菜单，二者在此项目是同一个菜单）。
> 调用：`updateUserList([{ ...info, isAudioNovel: v }])`。

#### 8.4.1 现有菜单项范式（已读 `ListMenu.tsx` 实测）
菜单是**扁平结构**，由 `handleSetMenu()` 组装一个数组（`ListMenu.tsx:89-100`），每项形如：
```ts
{ action: 'rename', disabled: !rename, label: t('list_rename') }
```
- 类型定义：`Menu.tsx:17` → `{ action: string, label: string, disabled?: boolean }`
- **排序约定**：`new`（新建）→ `rename` → `sort` → ... → `remove`（末尾，且 `disabled: !remove`）（`ListMenu.tsx:90-99`）
- **句柄**：`handleMenuPress` 按 `action` switch 分发（`ListMenu.tsx:103-140`）

#### 8.4.2 关键能力约束（决定交互形态）
**`Menu` 组件不支持「勾选态」**（已读 `Menu.tsx:129-167` 确认）：
- `Menu` 只渲染 3 种行：`disabled`（opacity 0.4、不可点）、`action == activeId`（文字变 `c-primary-font-active`，**仅是文字高亮，无勾选框**）、普通可点行。
- 因此**无法**做成「带 CheckBox 的勾选菜单项」。菜单项一旦关闭即销毁，也不适合放 `CheckBoxItem`（那是设置页的横向布局组件）。

#### 8.4.3 交互设计定案：**动词短语菜单项 + 点击切换 + toast 反馈**
- **形态**：**点击切换**（非勾选）。菜单点击后自动关闭（`Menu.tsx:122` `menuPress` 内 `onHide()`），这是项目既有行为，**不改**。
- **菜单项文案按「当前状态」动态显示动作**（项目无勾选态，故用**动词短语**表达下一步动作，符合项目既有措辞风格：`new`=`列表创建`/`rename`=`重命名`/`list_remove`=`移除`——全是动词短语）：

  | 歌单当前状态 | 菜单项 label | action |
  |--------------|--------------|--------|
  | 未开启有声小说 | **`设为有声小说`** | `toggleAudioNovel` |
  | 已开启有声小说 | **`取消有声小说`** | `toggleAudioNovel` |

  → **命名结论：用「设为有声小说 / 取消有声小说」这组动词短语**，而非静态的「有声小说」名词（静态名词在无勾选态时会让人分不清当前状态）。
  - i18n key：`list_set_audio_novel` = `设为有声小说`；`list_unset_audio_novel` = `取消有声小说`
- **位置**：插在 `rename` 之后（与「元数据/命名」类操作相邻），即数组第 3 项。`disabled` 条件与 `rename` 相同（仅用户歌单可设，`default`/`love` 列表 `disabled: true`）——复用 `handleSetMenu` 里现成的 `userList`/`rename` 判定（`ListMenu.tsx:77-87`）。

#### 8.4.4 toast 反馈（项目惯例核对）
- 项目 `toList` 类操作**有轻提示惯例**：`list_edit_action_tip_add_success`（`listAction.ts` 系列）、`toast()`（`utils/tools.ts:107`）广泛用于操作反馈。
- **定案：需要 toast**：
  - 开启 → `toast('已设为有声小说，播放时会自动记录进度')`
  - 关闭 → `toast('已取消有声小说')`
  - i18n key：`list_audio_novel_on_tip` / `list_audio_novel_off_tip`
- 若架构师认为反馈过重，**降级方案**：仅开启时 toast（关闭时静默），但**不建议完全无反馈**（菜单关闭后无任何状态可见，用户会不确定是否生效）。

#### 8.4.5 与设置页的关系
- 设置页（设置 → 列表，`Setting/settings/List/index.tsx:15` 的 `Section`）**不放**此开关——它是**歌单级属性**，放在全局设置会造成「设置改的是哪个歌单」的歧义。
- 用户如何在列表页**看出**某歌单已开有声小说？→ 复用现成的 `Badge`（`components/common/Badge.tsx`），在 `MyList/ListItem.tsx` 的列表项上加一个 `type="secondary"` 的小徽标 `小说`。**此为可选增强，标记 advisory，不阻塞主链路。**

### 8.5 状态流转图（续播）
```
[历史列表] --点击行--> [续播中: 加载] --> [播放器播放 + 记录进度] 
      |                                          |
      |                                    每隔 N 秒更新进度
      v                                          v
[三点菜单] --删除--> [行消失 + toast]       [历史记录进度被更新(同作品覆盖)]
```

---

## 9. 删除/清空确认文案（全部 i18n key 规划）

> 项目 i18n 文件：`src/lang/zh-cn.json`（520 keys，另有 zh-tw / en-us）。
> 下列 key 为**建议新增**（若架构师已有命名则对齐）。

| key | zh-cn 文案 | 用途 |
|-----|-----------|------|
| `history_title` | `播放历史` | 页面标题 |
| `history_entry` | `播放历史` | 入口菜单项 / 侧栏项 |
| `history_empty_title` | `还没有听过有声小说` | 空态标题 |
| `history_empty_desc` | `在歌单里打开「有声小说」模式后，抓取并播放任意一集，这里会自动记录你听到的位置，方便下次接着听。` | 空态说明 |
| `history_loading` | `正在读取播放记录…` | 加载态 label（可选） |
| `history_resume` | `继续听` | 菜单项：续播 |
| `history_delete_item` | `删除该记录` | 菜单项：删单条 |
| `history_clear_all` | `清空播放历史` | 清空按钮 / 弹窗标题 |
| `history_clear_tip` | `将清空全部 {n} 条播放记录，清空后无法恢复。` | 弹窗正文（`{n}` 为真实条数） |
| `history_clear_confirm` | `清空` | 弹窗确认按钮 |
| `history_clear_success` | `已清空播放历史` | toast |
| `history_delete_success` | `已删除该条记录` | toast |
| `history_episode_label` | `第 {n} 集` | 集数标签（`{n}` 为集数） |
| `history_progress_percent` | `已听 {p}%` | 进度（百分比方案） |
| `history_relative_*` | — | **【已纠偏】不需要新增**：直接复用现成 `dateFormat2()` + 现有 i18n 键（见 §9.1） |
| `list_set_audio_novel` | `设为有声小说` | 歌单菜单项（未开启时显示） |
| `list_unset_audio_novel` | `取消有声小说` | 歌单菜单项（已开启时显示） |
| `list_audio_novel_on_tip` | `已设为有声小说，播放时会自动记录进度` | 开启 toast |
| `list_audio_novel_off_tip` | `已取消有声小说` | 关闭 toast |

### 9.1 【纠偏】相对时间 —— 直接复用项目现成实现

> 初稿曾标注「项目未见 formatRelativeTime，需新增」——**该论断有误，已核实推翻**。
> 项目 `src/utils/index.ts:174-185` 已存在现成函数：
> ```ts
> export const dateFormat2 = (time: number): string => {
>   let differ = Math.trunc((Date.now() - time) / 1000)
>   if (differ < 60) return global.i18n.t('date_format_second', { num: differ })
>   else if (differ < 3600) return global.i18n.t('date_format_minute', { num: Math.trunc(differ / 60) })
>   else if (differ < 86400) return global.i18n.t('date_format_hour', { num: Math.trunc(differ / 3600) })
>   else return dateFormat(time)
> }
> ```
> 对应 i18n 键**中英繁三语齐全**（`src/lang/zh-cn.json` 等）：
> - `date_format_second` = `{num} 秒前`
> - `date_format_minute` = `{num} 分钟前`
> - `date_format_hour` = `{num} 小时前`
>
> **实现口径**：历史记录行的时间直接调 `dateFormat2(item.updateTime)`，**无需新增任何函数或 key**。
> **注意边界**：`dateFormat2` **无「天前」档**，超过 24h（86400s）会落到 `dateFormat(time)` 显示**绝对日期**（非「N 天前」）。因此初稿 §9 表中的 `history_relative_days` / `history_relative_date` / `history_relative_just_now` **全部删除**——文案分级完全由 `dateFormat2` 既有逻辑决定，**设计不再自定义相对时间档位**。

- **i18n 复用现有 key**：`cancel`（取消）、`delete`（移除/删除）、`dialog_confirm`（好的）等已有，可直接调 `t('cancel')`。
- **相对时间实现（最终）**：直接调现成 `dateFormat2(item.updateTime)`（`utils/index.ts:174`）+ 现成 i18n 键 `date_format_second/minute/hour`。**无需新增函数或 key。**

---

## 10. 500 条上限的用户感知（决策）

- **决策：静默淘汰 + 设置内只读告知，不做硬性拦截。**
- 理由：
  1. 500 条对有声小说「按作品去重」后有实际价值极高（同一作品只留 1 条），正常用户远达不到。
  2. 暴露「剩余 498/500」会造成焦虑，且项目现有列表（我的列表、搜索历史）均无配额 UI。
- **具体做法**：
  - 超限时**静默淘汰最旧的一条**（按最近播放时间）。
  - 在 设置 → 列表 分组下，加一行 `SubTitle` 说明（复用 `Setting/components/SubTitle.tsx`）：
    `播放历史最多保留 500 条，超出后会自动清理最早的记录。`
  - 不在列表页做任何提示/红字。

---

## 11. 复用映射总表

| 页面区块 | 复用现有组件/范式 | 文件路径:行号 |
|----------|------------------|---------------|
| **分段切换控件（歌单/历史）** | **`SearchTypeSelector` 范式**（横向 `TouchableOpacity`+`Text`，激活态 `borderBottomColor: c-primary-background-active` + 文字 `c-primary-font-active`） | `screens/Home/Views/Search/SearchTypeSelector.tsx:38-47,77` |
| **歌单开关菜单项** | `Menu` 的 `{action,label,disabled}` 扁平项范式 | `screens/Home/Views/Mylist/MyList/ListMenu.tsx:89-100` |
| 列表容器 | `FlatList` + `getItemLayout` | `screens/Home/Views/Mylist/MyList/List.tsx:119` |
| 列表项结构 | 照抄双行信息结构 | `.../MusicList/ListItem.tsx:46-77` |
| 行高常量 | `scaleSizeH(n)` | `.../MusicList/ListItem.tsx:13` |
| 主/次文本 | `Text` | `components/common/Text.tsx:32` |
| 图标 | `Icon`（IcoMoon） | `components/common/Icon.tsx:36` |
| 点击区域 | `Button`（含 ripple） | `components/common/Button.tsx:20` |
| 更多菜单 | `Menu` | `components/common/Menu.tsx`（用法见 `MusicList/ListMenu.tsx:164`） |
| 二次确认 | `ConfirmAlert` / `confirmDialog` | `components/common/ConfirmAlert.tsx:75` / `utils/tools.ts:186` |
| 加载 | `Loading` | `components/common/Loading.tsx:26` |
| Toast | `toast()` | `utils/tools.ts:107` |
| **相对时间格式化** | **`dateFormat2()`（现成，无需新增）** | `utils/index.ts:174-185` |
| 设置分组 | `Section` | `.../Setting/components/Section.tsx:13` |
| 设置说明文字 | `SubTitle` | `.../Setting/components/SubTitle.tsx` |
| 进度条（备选） | `ProgressBar` | `components/player/ProgressBar.tsx` |
| 歌单「小说」标记（可选增强） | `Badge` | `components/common/Badge.tsx` |
| 主题取色 | `useTheme()` | `store/theme/hook.ts:38` |

---

## 12. 响应式 / 无障碍

- **平台**：仅 Android（项目定位），无需 iOS/平板分栏。
- **触摸目标**：列表行高 ≥52px；三点按钮沿用 `moreButton` 的 `paddingLeft/Right:16`（`ListItem.tsx:151-155`）保证 ≥44px 热区。
- **对比度**：主文字 `c-font`（近 深灰 系）对 `c-content-background`（白底 浅色主题）≈ 14:1 [是]；次级 `c-500`/`c-350` 仅用于**非关键辅助信息**（时间戳），符合项目现状用法。
- **焦点/键盘**：RN 触屏，无 tab 焦点；Android 物理键可聚焦 Pressable（`Button` 原生支持）。
- **动效**：仅 Android ripple（`Button.tsx:23`）+ 列表项即时反馈，无自定义动画 → 无需 `prefers-reduced-motion`（RN 无此媒体查询，项目也未用）。
- **图标可读性**：所有 `Icon` 带语义 `name`，非装饰性图标应加 `accessibilityLabel`（**建议新增，项目现状普遍缺失 → advisory**）。

---

## 13. 自检清单（对照 P0 与红线）

- [x] **无 emoji 作功能图标** — 全部走 IcoMoon `Icon`；文案中也不含 emoji（区别于既有 `list_error` 的 (哭脸) 历史包袱）
- [x] **无紫色→粉色渐变** — 全部走主题 `c-primary` 单色，无任何 gradient
- [x] **无空洞占位** — 空态/弹窗文案均含真实引导与真实条数变量
- [x] **无硬编码颜色** — 全部 `theme['c-xxx']`；无裸 hex
- [x] **图标尺寸** — 12（列表内，延续项目）/ 15（行内）/ 20（按钮）/ 24（空态独立）
- [x] **组件状态覆盖** — 正常/空/加载/删除中/边界 五态齐备（§7）
- [x] **复用优先** — 复用映射表 §11 全部指向真实代码路径
- [x] **无虚构指标** — 进度、条数均为真实变量

---

## 14. 待确认项（advisory）

> 更新记录：初稿 advisory #1「相对时间工具需新增」**已核实推翻**（项目已有 `dateFormat2`，见 §9.1），本条删除。

1. **空态专属图标**：图标集无「书本/耳机/章节」，建议不新增、用 `music_time`；若产品坚持要书本图标，需补 IcoMoon 字体资源 + 重跑 `build:theme`。
2. **歌单「小说」标记（可选增强）**：用户如何在歌单列表一眼看出某歌单已开有声小说？建议用现成 `Badge` 在 `MyList/ListItem.tsx` 加 `小说` 小徽标。不阻塞主链路。
3. **分段切换控件**：项目无通用 segmented 组件，采用 `SearchTypeSelector.tsx` 范式的**下划线 tab**（见 §6.5.2）。若架构师希望抽象为通用组件供两处共用，需额外重构 `SearchTypeSelector` —— 初版建议内联复用，不擅自重构业务组件。
4. **进度展示**：数据层存**原始秒**；默认「时间点文字」`12:30 / 45:00`（比百分比更可靠，不依赖总时长字段准确性）。若坚持横条，走 `ProgressBar` 复用。
5. **accessibilityLabel**：项目现状功能图标普遍缺失，建议本模块新增时补上。
6. **列表项高度**：建议 `scaleSizeH(52)`，需架构师确认是否统一进 `config/constant`（现有 `LIST_ITEM_HEIGHT` 与 `ITEM_HEIGHT` 分处两个文件）。
7. **开关反馈强度**：定案为「开启/关闭各一次 toast」；若架构师认为太重，可降级为「仅开启 toast」，但不建议完全无反馈（菜单关闭后无状态可见）。

---

## 15. 变更记录

| 版本 | 变更 | 原因 | 影响范围 |
|------|------|------|----------|
| v1.0 | 初版 UI/UX 设计文档 | Phase 1 交付 | 全文 |
| v1.1 | **纠偏**：相对时间改用现成 `dateFormat2`（`utils/index.ts:174`），删除「需新增 formatRelativeTime」及 §9 自定义相对时间档位 | 架构师核查 + team-lead 独立验证推翻了初稿论断 | §9、§9.1、§11、§14 |
| v1.1 | **补充**：有声小说开关落点定案为 `MyList/ListMenu.tsx` 菜单项，采用动词短语「设为有声小说 / 取消有声小说」+ 点击切换 + toast（因 `Menu` 不支持勾选态） | 架构师提供落点 + 读取 `Menu.tsx` 实测能力 | §8.4 |
| v1.1 | **补充**：确认 UI 结构（`PlayHistory/` 独立目录 + `Mylist/index.tsx` 分段切换），分段控件复用 `SearchTypeSelector` 范式（项目无通用 segmented 组件） | team-lead 裁决 UI 结构 + 需明确复用来源 | §6.4、§6.5、§11 |
| v1.1 | **对齐**：进度存原始秒、相对时间字段 `updateTime`、集数用 `musicInfo.name` | 架构师数据层已定 | §6.4 |
