# pi-omp-editor

自己用AI改的一个Pi TUI插件（自用，请温柔喷）

一个仿 OMP 风格的 Pi 输入框扩展，仅调整输入框外观，保留 Pi 原生编辑行为。

## 特性

- 圆角左边框，保留顶部和底部边框，右侧开放、不封口。
- 默认两列内部留白，底边与最后一行合并，布局更加紧凑。
- 下方仍有隐藏内容时，保留滚动提示和独立底边。
- 保留原生快捷键、历史记录、粘贴处理、自动补全和输入法行为。
- 修正紧凑布局下补全菜单的鼠标坐标偏移。
- 支持命令切换，并在启动会话及 `/reload` 后恢复已保存的启用状态。

## 兼容性

本扩展面向提供 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 的 Pi 版本开发，开发环境为 Pi **1.3.0**。其他版本尚未验证。

仅在交互式终端模式下修改主输入框，不替换 RPC、JSON 或打印模式的界面。

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

首次安装默认启用。

| 命令 | 作用 |
| --- | --- |
| `/omp-editor on` | 启用并保存状态 |
| `/omp-editor off` | 关闭并恢复之前的输入框 |
| `/omp-editor status` | 查看状态；若保存为启用但输入框被替换，则尝试恢复 |
| `/omp-editor` | 等同于 `/omp-editor status` |

启用状态默认保存在：

```text
~/.pi/agent/extension-settings/omp-editor.json
```

如果配置了自定义 Pi agent 目录，该文件会随 agent 目录迁移。配置文件不包含在仓库中。

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

源码位于 `extensions/omp-editor.js`。代码注释使用中文。

## 注意事项

- 本扩展通过继承 Pi 的 `CustomEditor` 修改外观，Pi 内部渲染行为变化时可能需要适配。
- 已在开发环境中检查 10–120 列宽度下的空输入、英文、中文及表情、多行和滚动场景。极窄窗口可能触发原生编辑器的宽度或换行限制，建议保持至少 10 列宽度。
- 多个扩展同时替换主输入框时，可能互相覆盖。
- 本项目为 OMP 风格的个人定制，并非 OMP 官方插件。

## 许可证

[MIT](./LICENSE)
