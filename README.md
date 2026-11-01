# Housekeeper · 希微

**在同一个工作台里聊天、查资料、整理文字，并积累有来源的长期记忆。**

当前源码版本：**3.3.0**。Windows 桌面端采用 React + Electron，后端在本机运行。左侧是希微的轨道舱室人物场景，也可切换为圆形语音视图；右侧用标签页展示聊天、文档、记忆星空和设置。

本仓库公开用于展示与评估，暂未授予修改、再分发或商用许可，详见 [LICENSE](LICENSE)。第三方依赖保留其原有许可。

## 当前能力

- **文字与语音交流**：支持兼容接口的对话模型、DeepSeek 思考强度适配、唤醒、连续对话、打断、退下及播放状态反馈。文字原文完整展示，语音通过独立口播稿进行概括。
- **有来源的长期记忆**：从对话、资料和任务事件中提取用户偏好、生活习惯、事实、决策与经验；自动去重、更新和替代旧结论，保存证据与版本历史。记忆用于后续检索，不会训练或修改模型权重。
- **记忆星空**：以星点网络查看记忆、事件、来源和替代关系，支持搜索、聚焦和查看变化。
- **资料问答与总结**：读取 Markdown、文本和代码文件，以及 DOCX、XLSX、PPTX、PDF 等支持的格式；结构切分、父子片段、关键词与可选向量检索共同组织上下文。扫描型 PDF 不含内置 OCR。
- **人物场景**：坐姿人物、全景舱室、呼吸、眨眼和发丝轻动；口型根据实际播放幅度变化。当前使用自研 WebGL 二维网格，**不是完成绑定的 Cubism .moc3 模型**，尚无完整的情绪表情或音素口型绑定。
- **按用途配置连接**：对话、视觉、识别、合成与知识检索分别配置。视觉服务可独立于 DeepSeek；本地识别 / 合成与云端千问实时语音均保留适配代码。
- **内置方法与工具适配**：保留 Skills、HTTP 工具、MCP 与执行回执基础设施。3.3.0 界面聚焦信息助理，停用原型绘制与工作写入 / 电脑执行入口，不将旧实验能力作为可用功能宣传。

## 快速开始

需要 Node.js 24、pnpm 11，正式桌面构建面向 Windows x64。

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build:desktop
pnpm desktop
```

开发网页使用 `pnpm dev`，打开终端中的 Vite 地址。默认本地后端为 `http://127.0.0.1:4310`。

首次启动在“设置 → 模型与回答”中填写自己的服务地址、API Key 和模型 ID，并启用模型回答。所有模型凭证均为空；不连接作者的服务器，也不带入作者的项目、资料、对话或记忆。语音、唤醒和摄像头默认关闭，按需开启后可跟随 Windows 默认设备。

语音本地运行依赖额外的 Python / ONNX 资源。源码仓库不包含模型权重、Python 运行包或 B 音色资源；仅完成 Node 构建并不代表语音资源已就绪。云端语音需填写服务商支持的识别 / 合成模型、地址与自己的密钥。未打入完整语音资源时，界面会显示未就绪信息。

## 记忆机制

```text
对话 / 已扫描资料 / 已记录事件
             ↓
      去重并进入观察队列
             ↓
      后台模型提取与证据检查
             ↓
   新增 / 合并 / 替代 / 跳过
             ↓
   SQLite 事实、来源与版本历史
             ↓
  后续按范围召回相关记忆与上下文
```

自动记忆会在配置模型且启用回答后进行后台模型调用，除前台聊天外也会产生 API 用量。当前版本没有完整的逐请求 Token 账本或消费上限；不能通过聊天条数精确推算费用。更详细的处理流程与限制见 [记忆说明](docs/memory.md)。

## 代码结构

| 目录 | 用途 |
| --- | --- |
| `src/` | React 工作台、聊天与标签页、记忆星空、设置 |
| `electron/` | 主窗口、设备、密钥存储、语音进程和 IPC |
| `server/domain/agent/` | 对话执行状态、工具循环及执行回执 |
| `server/domain/memories/` | 人设、观察队列、记忆版本、证据与召回 |
| `server/retrieval/` | 文档切分、FTS / 向量检索与父子片段 |
| `server/providers/` | 对话、视觉、实时识别及语音合成适配 |
| `scripts/voice-lab/` | 本地语音运行与资源校验、封装脚本 |
| `design/xiwei-character-source/` | 正式人物运行所需网格、状态机与贴图 |

本机结构：Electron → React / 本地 Express 服务 → SQLite；模型调用通过用户配置的服务发出。密钥在正式 Electron 中使用 Windows safeStorage 保存。业务数据目录为 `%APPDATA%/housekeeper`，运行配置为 `%APPDATA%/housekeeper-runtime`，应用 ID 为 `top.sparkcrate.housekeeper`，与个人端分开。

## 构建与验证

```sh
pnpm check
pnpm test
pnpm build:desktop
```

`pnpm package:win:source` 可生成不附带完整原生语音资源的基础安装包；`pnpm package:win:local` 需要先准备经过校验的语音运行包，并设置 `AI_SECRETARY_NATIVE_VOICE_BUNDLE`。所有打包命令仅生成本地文件，不自动部署或上传。

本次更新只提交 **3.3.0 源码**，没有替换 GitHub 上的旧安装包。仓库 [Releases](https://github.com/fuxian0928-sketch/housekeeper/releases) 中旧安装包的版本可能与当前源码不同。

已知边界：记忆提炼可能出错；真实音频设备与长时间语音稳定性需实际使用验证；人物表情尚不等同于完整 Live2D 绑定。第三方资源说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
