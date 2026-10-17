# pi-omp-editor

自己用AI改的一个Pi TUI插件（自用，请温柔喷）

一个仿 OMP 风格的 Pi 输入框与工具 UI 扩展。保留 Pi 原生编辑和工具执行行为，内置紧凑工具卡、树形分组及 Edit diff，**无需另外安装 `pi-cc-extensions`**。

## 特性

- 圆角左边框，保留顶部和底部边框，右侧开放、不封口。
- 默认两列内部留白，底边与最后一行合并，布局更加紧凑。
- 下方仍有隐藏内容时，保留滚动提示和独立底边。
- 保留原生快捷键、历史记录、粘贴处理、自动补全和输入法行为。
- 修正紧凑布局下补全菜单的鼠标坐标偏移。
- 输入框和工具 UI 可分别开关，并在启动会话及 `/reload` 后恢复已保存的状态。
- 工具调用采用 `✓` / `✗` / 动态运行指示、参数摘要、结果行数和耗时。
- 连续工具自动合并成 `Multiple Tools` 或同名工具树；Codemode 显示真实子调用进度。
- 默认折叠输出，可展开查看完整输入、输出和图片。
- Edit 使用工具返回的真实 diff：宽屏左右对照，窄屏自动切换统一 diff，显示增删统计。

## 兼容性

本扩展面向提供 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 的 Pi 版本开发，开发环境为 Pi **1.3.0**。其他版本尚未验证。

仅在交互式终端模式下修改输入框和工具显示，不改变 RPC、JSON 或打印模式的行为，不重新注册或替换工具执行逻辑。

## 安装

```bash
pi install git:github.com/guoguo397/pi-omp-editor
```

安装后启动 Pi，或在已经运行的交互式会话中执行：

```text
/reload
```

> 如果之前手动安装过 `omp-editor.js`，请先把旧文件移出 `~/.pi/agent/extensions/`，避免重复加载。备份文件也不要留在该目录中并继续使用 `.js` 或 `.ts` 扩展名。

安装固定版本：

```bash
pi install git:github.com/guoguo397/pi-omp-editor@v1.0.0
```

固定标签的安装不会自动跟随主分支更新。

## 使用

首次安装默认同时启用输入框和工具 UI。两者独立保存状态；关闭输入框不会关闭工具 UI。

| 命令 | 作用 |
| --- | --- |
| `/omp-editor on` | 启用并保存状态 |
| `/omp-editor off` | 关闭并恢复之前的输入框 |
| `/omp-editor status` | 查看状态；若保存为启用但输入框被替换，则尝试恢复 |
| `/omp-editor` | 等同于 `/omp-editor status` |
| `/omp-tools on` | 启用紧凑工具 UI 并保存 |
| `/omp-tools off` | 关闭工具 UI，恢复原生工具显示 |
| `/omp-tools status` | 查看工具 UI 状态及是否让位给其他渲染插件 |
| `/omp-tools` | 等同于 `/omp-tools status` |

### 工具 UI

```text
 ● Multiple Tools: 3 done · Read×1, Ls×1, Grep×1 · click to show more
 ├ ✓ Read src/main.js
 ├ ✓ Ls src
 └ ✓ Grep "render" in src

 ✓ PowerShell npm test
   ↳ 12 lines returned · 451ms · click to show more

 ✓ Edit src/main.js
   ↳ diff +3 −1 split [━━━━━━━━━━━━━━━━]
 old                       │ new
```

- **Fullscreen 模式**：点击单个工具卡展开/折叠；点击分组标题展开/折叠组内工具。
- **Regular 模式**：终端管理鼠标和滚动，使用 Pi 原生的工具展开快捷键（默认 **Ctrl+O**）。提示文字跟随当前快捷键设置。
- 原生展开快捷键在两种模式下都有效，不需要逐个点击。
- 工具组和 Codemode 折叠时最多显示最近 8 项，显示隐藏数量；展开可查看全部。
- Edit 默认预览最多 20 行，展开查看完整 diff；内容区至少 100 列时并排显示，否则使用统一 diff。
- 内置支持 Read、Ls、Find、Grep、Bash、PowerShell、Edit、Write、Codemode、Tool Search。未知工具（含自定义 MCP 工具）保留原来的渲染器。
- 不跨越可见的助手消息合并分组，Edit、Write 和含图片的调用独立显示。图片展开后仍由 Pi 原生图像组件渲染。

### 与其他 UI 插件共用

如果检测到正在接管工具渲染的 `pi-cc-extensions`，本项目的工具 UI 会自动让位，避免重复分组；输入框仍独立工作。`/omp-tools status` 会说明当前状态。

要只使用本项目提供的工具 UI，请在 Pi 资源配置中禁用对方的渲染扩展（或移除该插件），然后执行 `/reload`。本项目不会自动修改或删除其他插件及其配置。

启用状态默认保存在：

```text
~/.pi/agent/extension-settings/omp-editor.json
```

如果配置了自定义 Pi agent 目录，该文件会随 agent 目录迁移。配置文件不包含在仓库中。

```json
{
  "enabled": true,
  "toolsEnabled": true
}
```

旧配置只包含 `enabled` 也可使用；缺失的 `toolsEnabled` 默认启用。

## 更新

对于未固定标签的安装：

```bash
pi update git:github.com/guoguo397/pi-omp-editor
```

更新后重新启动 Pi，或执行 `/reload`。

## 卸载

```bash
pi remove git:github.com/guoguo397/pi-omp-editor
```

如果安装时指定了版本，请使用对应的完整来源，例如：

```bash
pi remove git:github.com/guoguo397/pi-omp-editor@v1.0.0
```

卸载后重新启动 Pi，或执行 `/reload`。单独保存的启用状态文件可能仍会保留，如不再需要可手动删除。

## 本地开发

```bash
git clone https://github.com/guoguo397/pi-omp-editor.git
cd pi-omp-editor
pi --no-extensions -e .
```

上述命令仅在本次启动加载此扩展，不写入安装配置；`--no-extensions` 用于避免同时加载其他扩展或已经安装的副本。它会同时禁用其他自动发现的扩展，包括内置 MCP 扩展。

入口位于 `extensions/omp-editor.js`，工具 UI 位于 `extensions/tool-ui/`，共享设置位于 `extensions/lib/settings.js`。代码注释使用中文。

运行测试（需要 Node.js 22.19+ 及 Pi 的两个 peer dependencies）：

```bash
npm install --ignore-scripts
npm test
npm pack --dry-run
```

测试覆盖紧凑卡片、分组边界和鼠标坐标、运行/错误状态、Codemode 子调用、宽窄屏 diff、中文/表情/ANSI 宽度、图片、独立开关、重载清理及非 TUI 模式。

## 注意事项

- 输入框继承 Pi 的 `CustomEditor`；工具 UI 适配 `ToolExecutionComponent`、`Container.render` 和鼠标布局。工具分组只影响渲染，不移动原组件树；Pi 内部接口变化时仍可能需要适配。
- 工具 UI 是按参考样式实现的独立功能，不包含 `pi-cc-extensions` 的状态栏、思考块、Markdown 增强、工具执行覆盖或其他附加功能。
- 已在开发环境中检查 10–120 列宽度下的空输入、英文、中文及表情、多行和滚动场景。极窄窗口可能触发原生编辑器的宽度或换行限制，建议保持至少 10 列宽度。
- 多个扩展同时替换主输入框时，可能互相覆盖。
- 本项目为 OMP 风格的个人定制，并非 OMP 官方插件。

## 许可证

[MIT](./LICENSE)
