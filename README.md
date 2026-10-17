# pi-omp-ui

自己用 AI 改的 Pi UI 扩展（自用，请温柔喷）。仿 OMP 输入框和 Claude Code 状态栏，保留 Pi 原生编辑与工具执行行为，无需安装 `pi-cc-extensions`。

## 功能

- **输入框**：圆角左边框、开放右侧、紧凑留白，保留原生编辑行为；拖入或粘贴本地图片路径时显示 `[Image #N]` 标签，发送仍使用原路径，支持整体删除和撤销。
- **工具 UI**：紧凑卡片、连续调用分组、运行状态和耗时；可展开完整输入、输出及图片。Codemode 显示子调用进度，Edit 支持宽屏并排 diff、窄屏统一 diff。
- **完成统计**：整轮执行结束后，在输入框顶边居中显示“本轮耗时 · 会话累计耗时”，不显示 token 和费用。
- **状态栏**：展示模型、项目、Git、耗时、Context 进度条、上下文文件 / MCP 数、思考等级、用量和插件状态；有本轮工具调用记录时追加次数汇总。

仅修改交互式终端界面，不改变 RPC、JSON、打印模式或工具执行逻辑。当前版本 **2.0.0**，已在 **Pi 1.3.0** 验证，其他 Pi 版本尚未验证。

## 安装与更新

```bash
pi install git:github.com/guoguo397/pi-omp-ui
```

更新：

```bash
pi update git:github.com/guoguo397/pi-omp-ui
```

安装或更新后重启 Pi，或执行 `/reload`。

> 如果手动安装过 `omp-editor.js` 或 `done.js`，请先将旧脚本移出 `~/.pi/agent/extensions/`，避免重复加载。备份也不要留在自动加载目录中。

## 使用

四项功能默认启用，开关独立保存。以下命令均支持 `on`、`off`、`status`；不带参数等同于 `status`。

| 命令 | 功能 |
| --- | --- |
| `/omp-editor` | 圆角输入框；关闭时恢复之前的输入框 |
| `/omp-tools` | 紧凑工具 UI；关闭时恢复原生显示 |
| `/omp-done` | 顶边耗时统计；输入框关闭时改为独立通知 |
| `/omp-footer` | Claude Code 风格状态栏；关闭时恢复原生显示 |

例如：`/omp-footer off` 关闭自定义状态栏，`/omp-footer on` 重新启用。

### 工具展开

- **Fullscreen**：点击工具卡或分组标题展开 / 折叠。
- **Regular**：使用 Pi 原生工具展开快捷键，默认 **Ctrl+O**；Fullscreen 也支持。
- 工具组和 Codemode 折叠时最多显示最近 8 项；Edit 默认预览 20 行，展开查看完整内容。
- 未知工具保留原渲染器。检测到 `pi-cc-extensions` 接管工具渲染时自动让位，可用 `/omp-tools status` 查看。

### 统计与状态栏

```text
╭──── 本轮 9s · 会话累计 2m 15s ────
╰─

[Opus 5.5] | act git:(master) | ⏱ <1m
Context ████░░░░░░░░░░░░ 25%
2 AGENTS.md | 2 MCPs
▶ ready · thinking high · ↑3.5k ↓200 · $0.0123
tools 12 · Read×5 · PowerShell×4 · Edit×3
```

- 顶边耗时在重试、压缩及排队执行全部结束后更新；新一轮开始时清除。
- 会话耗时从本次启动或最近一次 `/reload` 开始计算，随界面重绘更新。
- 状态栏读取真实会话数据。Context 未知时显示 `?%`；MCP 数为提供可访问工具的命名空间数，不是配置总数。
- 输入用量包含缓存读写，费用为零时隐藏。`Working` 只在输入框显示，底部不重复。
- 工具次数只统计本轮已保存的结果，包含失败及原生记录的嵌套调用；新一轮开始时清零，结束后保留本轮结果，重载或切换会话时清空。记录不完整时用 `≥` 标示，无调用时不占额外行。
- 保留其他插件状态，但不模拟 Claude Code 权限模式、快捷键或代理数。
- 支持主题配色和窄屏截断；其他扩展替换状态栏时不干扰对方。

设置保存在 `~/.pi/agent/extension-settings/omp-editor.json`，自定义 agent 目录时随之迁移。旧配置仍可使用，缺失开关默认启用；状态栏沿用 `footerIconEnabled` 设置键。

## 卸载

```bash
pi remove git:github.com/guoguo397/pi-omp-ui
```

卸载后重启或执行 `/reload`。设置文件仍可能保留，可按需删除。安装固定版本时，在来源后加 `@标签`；卸载使用同一完整来源，固定版本不会跟随主分支更新。

## 本地开发

需要 Node.js 22.19+ 及 Pi 的两个 peer dependencies。

```bash
npm install --ignore-scripts
pi --no-extensions -e .
npm test
npm pack --dry-run
```

`--no-extensions` 仅在本次启动禁用其他自动发现的扩展，包括内置 MCP 扩展。

入口：`extensions/omp-editor.js`；工具 UI：`extensions/tool-ui/`；完成统计与状态栏：`extensions/lib/`。

本项目适配了 Pi 内部 UI 接口，升级 Pi 后可能需要调整。多个扩展替换同一输入框时可能互相覆盖。本项目不是 OMP 官方插件。

[更新日志](./CHANGELOG.md) · [MIT 许可证](./LICENSE)
