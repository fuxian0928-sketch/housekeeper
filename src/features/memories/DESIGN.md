---
name: 希微 · 记忆星空
description: 奶白工作台中的局部夜空，以微小四芒星和可追溯连线浏览记忆。
colors:
  night: "#080d1c"
  star-ink: "#e7ecf8"
  star-muted: "#a1aec9"
  star-rule: "rgb(158 182 231 / 12%)"
  star-violet: "#c1a8ff"
  star-blue: "#8ed4ee"
  star-amber: "#e6bb7b"
  core-white: "#fff"
  heading: "#f1f3fc"
  reading-title: "#f1effb"
  reading-ink: "#d0d7e9"
  tooltip-ink: "#c3cee5"
  control-ink: "#c2cde5"
  relation-ink: "#c7d0e6"
  search-surface: "#11192c"
  search-focus: "#18213a"
  controls-surface: "rgb(17 25 45 / 94%)"
  tooltip-surface: "rgb(17 25 45 / 96%)"
  detail-surface: "rgb(16 24 43 / 97%)"
  controls-hover: "#2b3351"
  relation-hover: "#242d47"
  focus: "#b8c9f7"
  error-surface: "#351e32"
  error-ink: "#ffd1dc"
typography:
  title:
    fontFamily: '"Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", "Songti SC", "SimSun", serif'
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: ".1em"
  group:
    fontSize: "12px"
    fontWeight: 500
    letterSpacing: ".05em"
  detail-title:
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.7
  body:
    fontFamily: '"Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", "Songti SC", "SimSun", serif'
    fontSize: "12px"
    lineHeight: 1.95
  label:
    fontSize: "11px"
  tooltip-title:
    fontSize: "12px"
    fontWeight: 500
  tooltip-body:
    fontSize: "11px"
    lineHeight: 1.8
  meta:
    fontSize: "10px"
  count:
    fontFamily: "Georgia, serif"
    fontSize: "22px"
    fontWeight: 400
    lineHeight: 1.2
rounded:
  micro: "4px"
  control: "5px"
  row: "6px"
  field: "8px"
  floating: "9px"
  detail: "12px"
spacing:
  control-gap: "4px"
  icon-gap: "7px"
  row-gap: "9px"
  section: "17px"
components:
  starfield:
    backgroundColor: "{colors.night}"
    textColor: "{colors.star-ink}"
  search:
    backgroundColor: "{colors.search-surface}"
    textColor: "{colors.star-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.field}"
    padding: "0 11px"
    height: "34px"
  search-focus:
    backgroundColor: "{colors.search-focus}"
  map-controls:
    backgroundColor: "{colors.controls-surface}"
    textColor: "{colors.control-ink}"
    rounded: "{rounded.floating}"
    padding: "5px 7px"
  map-control:
    backgroundColor: "transparent"
    textColor: "{colors.control-ink}"
    rounded: "{rounded.control}"
    width: "28px"
    height: "27px"
  map-control-hover:
    backgroundColor: "{colors.controls-hover}"
    textColor: "{colors.core-white}"
  tooltip:
    backgroundColor: "{colors.tooltip-surface}"
    textColor: "{colors.tooltip-ink}"
    rounded: "{rounded.floating}"
    padding: "13px 15px"
    width: "225px"
  detail:
    backgroundColor: "{colors.detail-surface}"
    textColor: "{colors.reading-ink}"
    rounded: "{rounded.detail}"
    width: "272px"
  relation-row:
    backgroundColor: "transparent"
    textColor: "{colors.relation-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.row}"
    padding: "10px 6px"
  relation-row-hover:
    backgroundColor: "{colors.relation-hover}"
---

# Design System: 希微 · 记忆星空

## Overview

**Creative North Star: "有迹可循的星空"**

记忆、事件与项目在一片夜空中形成可以追查的星群。细小亮核、内凹曲线四芒星、短距离彩色光晕与低对比连线共同建立远近关系；默认画面让网络本身承担内容，信息随悬停、聚焦与点击逐层出现。

这是用户明确要求的局部深色例外，仅适用于记忆星空工作面。外部奶白工作台、页签、语音面与现有小字号宋体保持既有系统；此文档不替换根目录 `DESIGN.md`。实现依据为同目录的 `memory-starfield.css`、`MemoryStarfield.tsx`、`starfield-model.ts`，记录日期为 2026-10-28。业务范围见 `docs/memory-starfield-demo.md`；该交付使用隔离演示资料，不代表已接入个人数据或完成生产发布。

**Key Characteristics:**

- 深蓝夜空只存在于记忆工作面内部，外部延续奶白工作台。
- 星体很小，类型间尺寸接近；四芒外形、亮核、线型和文字共同说明状态。
- 静止时只请求显示星群名，短提示与完整详情按需出现。
- 布局稳定，呼吸轻缓，关闭详情或重新进入可回到纯网络视图。

## Colors

夜蓝承接空间，淡紫承接当前记忆，冰蓝承接来源事件，琥珀承接历史；前置元数据中的色值为本组件规范，具体渐变保留在本目录的 `.impeccable/design.json`。侧车中的派生色阶仅供文档面板预览，不是新增实现用色。

### Primary

- **淡紫记忆光**：`star-violet` 用于记忆图例与目录标记；图中记忆使用白亮核和紫色径向渐变，不把图例的纯色圆点放大成球体。
- **白色亮核**：`core-white` 是当前星体中心的四芒微光；光晕的饱和紫只在星点附近出现。

### Secondary

- **冰蓝来源光**：`star-blue` 标示事件，事件星体使用独立冰蓝渐变；图例与详情中的“事件”文字补充语义。
- **琥珀旧状态**：`star-amber` 用于历史标记及外环；历史星体有暗色填充、虚线描边，不显示当前状态的白亮核和呼吸光晕。

### Neutral

- **深蓝夜底**：`night` 覆盖标题、工具区、底栏与画布基底。画布另有低透明紫蓝色场和边缘暗角。
- **冷白阅读层**：`star-ink`、`heading`、`reading-title` 与 `reading-ink` 区分常规文字、标题和详情正文；`star-muted` 承担说明与统计。
- **深蓝浮层**：`search-surface`、`controls-surface`、`tooltip-surface`、`detail-surface` 在同一夜色内递进，不依赖背景模糊。`star-rule` 只做轻分隔。
- **操作与反馈**：`focus` 标示普通按钮键盘焦点；错误使用 `error-surface` 与 `error-ink`，同时显示说明和重新连接操作。

**The Local Night Rule.** 深色与光晕属于记忆星空内部，不扩展为全局主题，也不替换周围工作台的奶白阅读面。

## Typography

**Body Font:** 继承工作台的本机宋体栈，即 `--workbench-font`。不引入远程字体或随组件分发字体文件。

标题、星群名、提示与详情继续采用紧凑阅读尺度。当前记忆数量单独使用 Georgia 的衬线数字和等宽数字特性；这是一处统计数字处理，不形成新的展示字体体系。

| 层级 | 用途与实际处理 |
| --- | --- |
| `title` | 工作面标题；窄工作面降至（14px），仍保持同一字重与字距。 |
| `group` | 默认星群名；文字带夜色描边以便从连线中读出。 |
| `detail-title` / `body` | 详情标题与完整内容；正文保留换行，长词可断行。 |
| `tooltip-title` / `tooltip-body` | 悬停短提示；内容截取最多（110 个字符）后加省略号。 |
| `label` / `meta` | 搜索、关系行、类型、时间和底栏说明。 |
| `count` | 当前记忆数量；窄工作面缩至（19px）。 |

图中普通节点名为（11px）；选中或悬停时才加入，选中标签使用暖白并加至（500）字重。星群名截取到（15 个字符），其他节点标签截取到（12 个字符）；提示和详情保留标题。标签放置优先处理当前关注节点，其次是星群，并避让已放置文字，冲突时允许省略。

## Layout

组件占满所在工作面，纵向为标题、搜索工具区、可伸展画布与底栏。整体最小高度为（440px），画布最小高度为（250px）；外层移除通用资源页的内边距，由组件自身组织空间。桌面标题内边距为（24px 27px 17px），工具区为（0 26px 18px）；搜索最多（410px）宽。

布局按组件实际宽度响应，容器断点为（620px），与浏览器窗口宽度分开判断。窄工作面标题内边距变为（18px 17px 15px），工具区变为（0 15px 13px），搜索占满一行且高度变为（32px）；底栏可换行，更新时间隐藏。

画布是可拖动、缩放的平面 SVG 星图。底部居中的工具托盘包含节点目录、缩小、当前比例、放大与重置，距底（18px），窄工作面距底（14px）。视角初始为（100%），缩放范围为（45%–280%），按钮每次调整（15 个百分点）；滚轮以指针所在位置为缩放中心。

桌面详情位于画布右侧，顶部（17px）、右侧（18px）、底部（67px），最大宽度受画布边界约束。窄工作面详情改为底部面板，左右各（12px）、距底（63px）、最大高度为画布的（54%），正文在面板内滚动，图谱工具继续可见。

点击节点时视角平移，为详情让出空间：宽画布把节点置于左侧可见区域的中心，窄画布置于横向中央、画布高度的（22%）处。关闭详情按钮清除选择并恢复（100%）初始视角；离开此页签时清除选择、短提示、目录和视角，重新进入时显示纯网络。搜索内容保留。

## Elevation & Depth

深度来自夜色的低透明色场、微小星体的径向亮度和近不透明浮层。没有玻璃模糊；光晕属于星点，不给整个面板铺亮边。背景星点是静态装饰，数量按画布面积有界生成（110–650 个），不会充当记忆记录或可点节点。

浮层采用向下的柔影：提示为（`0 10px 26px -6px rgb(0 0 0 / 55%)`），工具托盘为（`0 6px 22px -5px rgb(0 0 0 / 40%)`），详情为（`0 14px 35px -8px rgb(0 0 0 / 48%)`）。阴影与画布暗角的完整值保存在局部侧车中。

记忆节点的四芒外形在（4.4s）内于（0.68–1）透明度之间呼吸，白亮核保持清晰；当前记忆的光晕同时在（0.32–1）透明度与（0.9–1.08）缩放之间变化，星群光晕周期为（6.4s）。部分记忆使用负延时错开相位。页签不活跃时暂停呼吸；减少动态效果偏好下关闭本组件全部动画与过渡。

**The Near-Light Rule.** 保留饱和但小半径的局部光晕，以及低透明外形；不把星点扩成大光球或在画布上叠加持续流动的背景。

## Shapes

记忆、事件、星群和历史都使用四个尖端之间向内弯曲的二次曲线闭合路径。形状由基准半径计算：尖端距离为半径的（1.55 倍），曲线控制点为尖端距离的（0.22 倍）。亮核复用同一路径，半径为外形的（0.37 倍），保留真正的四芒剪影。

| 节点 | 基准半径（SVG 用户单位） | 视觉状态 |
| --- | --- | --- |
| 当前记忆 | 2.9 | 紫色渐变四芒星、白亮核、半径（8）的局部光晕。 |
| 事件 | 2.4 | 冰蓝渐变四芒星、白亮核，不附加当前记忆光晕。 |
| 星群 | 3.3 | 淡蓝白渐变四芒星、白亮核、半径（9）的局部光晕与低对比点线外环。 |
| 历史记忆 | 2.6 | 暗色四芒星、琥珀虚线轮廓，无白亮核与呼吸光晕。 |

这些半径是形状构造参数，视觉尖端宽度约为（7.44–10.23 个用户单位），不是圆球半径。各类型的尺寸保持接近。透明命中圆半径为（24），与小星体分离；图例与列表中的圆点仅承担紧凑分类标记。

悬停、键盘聚焦或选中时，在基准半径外加（7）的距离显示细外环。浮层与搜索使用小圆角，详情稍舒展；线条通常为（1px），不增加装饰性大型容器。

## Components

### 星空网络与连接

静止时无默认详情卡、无记忆标题铺满画面，只保留避让后的星群名。项目与日常信息各自成群，节点位置由稳定 ID 和有界布局计算产生，不运行持续力模拟。

| 连接 | 常态线型 | 解释方式 |
| --- | --- | --- |
| 证据 | 细实线，透明度（0.42） | 来源与记忆的可核对关系。 |
| 项目归属 | 点线（1 8），透明度（0.23） | 同属星群，不冒充因果。 |
| 事件顺序 | 虚线（3 5），透明度（0.35） | 同一事务的记录顺序。 |
| 状态替代 | 琥珀虚线（4 5），透明度（0.68） | 旧状态与新状态的更新关系。 |
| 冲突 | 粉色虚线（3 4） | 需要核对的差异。 |

连接使用轻微弯曲路径，缩放时保持描边粗细。悬停、聚焦或选择节点时，直接相连的线提高到（0.95）透明度和（1.1）线宽，其他连线降到（0.11）；节点文字与详情中的关系说明补充颜色含义。

### 搜索与图谱工具

工具区当前只渲染一个搜索框，可搜索记忆与事件，输入上限为（120 个字符）；非空时显示清除按钮。聚焦只加深搜索底色，不叠加输入内部边线。输入稍缓后读取结果，搜索或结果为空时有明确说明。已移除的“全部星群”和“变化轨迹”不属于当前控件系统，即使样式文件中仍留有相应规则，也不恢复为默认操作。

图谱工具使用无底色的小图标按钮，悬停时出现深蓝底和亮色图形；到达缩放边界时禁用对应按钮，禁用透明度为（0.42）。普通按钮键盘焦点为（2px）轮廓并向外偏移（3px）；画布本身使用内收的细轮廓。画布方向键每次平移（35px），加减键调整缩放。节点可经 Tab 聚焦，用 Enter 或空格打开；目录提供文字访问路径。

### 短提示

仅在未打开节点详情时，悬停或键盘聚焦显示类型、完整标题和短内容。提示位置受画布边界约束，不接收指针事件；出现延时为（180ms），进入过渡为（150ms），向上移动（4px）并显现。它不展开时间、版本或完整关系列表。

### 节点详情与目录

点击节点才打开详情；点击关联行可继续选择相邻节点，点击时目录关闭。详情展示类型、标题、完整内容、所在星群、记录时间或最近整理、可用的记忆版本，以及最多（18 条）直接关系。文档来源显示“查看原文”，聊天来源显示“查看聊天”，均沿用工作台的打开行为。

详情正文内边距为（17px 17px 20px）；窄工作面收为（12px 14px）。标题和完整内容允许换行，关系行使用紧凑单行标题与次行关系说明。目录复用详情容器，列出非星群节点。详情关闭按钮恢复纯网络及初始视角；Esc 或点击画布空白可收起选择，保留当时视角。

### 同步、空态与错误

标题状态文字随实际读取显示“同步中”“自动更新”或“更新暂停”，统计数字来自返回数据。初次读取显示连接状态；没有记忆与搜索无结果使用不同空态。读取失败保留已获得的图谱，并显示带文字的错误浮层和“重新连接”。

活跃页面每（10s）检查更新，窗口重新聚焦或从隐藏恢复时检查；隐藏时不发起轮询读取，离开页签时清理定时器并中止请求。相同内容修订沿用现有图谱与视角。仅隔离开发预览显示“演示记忆变化”，正式工作面显示真实更新时间；装饰呼吸不代表数据更新频率。

## Do's and Don'ts

### Do:

- Do 让深蓝夜空止于记忆工作面，继承周围工作台的小字号宋体。
- Do 使用内凹曲线四芒星、微小白亮核与短距离紫蓝光晕，保持节点大小接近。
- Do 默认展示网络与星群名，通过悬停或聚焦给短提示，通过点击给完整详情。
- Do 用形状、线型、名称与关系说明共同传达类型、历史和连接依据。
- Do 保留文字目录、键盘焦点、窄工作面可见节点与减少动态效果回退。

### Don't:

- Don't 将四芒星换成球体、实心大圆或范围宽大的发光团。
- Don't 默认展开详情、铺满所有记忆标题，或恢复已移除的两个工具区控件。
- Don't 把背景星点算作记忆、给装饰连线编造依据，或以动画声称真实数据变化。
- Don't 把本组件的深色、光晕与动画规则扩展到全局工作台或独立桌面伴随窗口。
