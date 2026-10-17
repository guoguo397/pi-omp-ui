# 更新日志

## [未发布]

### 新增

- 底部状态栏新增会话工具调用次数汇总，包含失败及原生记录的嵌套调用，重载后保留；无调用时隐藏。
- 拖入或粘贴本地图片路径时，输入框显示 Claude Code 风格的 `[Image #N]` 标签；保留原路径发送，支持多图、整体删除和撤销。
- 内置紧凑工具 UI：调用分组、状态与耗时、Codemode 子调用进度、输出展开及 Edit 宽窄屏 diff，无需安装 `pi-cc-extensions`。
- 内置完成统计：整轮执行结束后，在输入框顶边显示本次和会话累计耗时。
- Claude Code 风格四行状态栏：模型、项目、Git、Context 进度条、上下文文件 / MCP 数、运行状态及用量，保留其他插件状态。
- `/omp-tools`、`/omp-done`、`/omp-footer` 独立开关，支持 `on|off|status` 并保存设置。

### 调整

- 移除底部重复的 `working`，保留输入框中的运行进度。
- 项目由 `pi-omp-editor` 更名为 `pi-omp-ui`，命令、设置路径和入口文件名不变。
- 顶部完成统计仅保留耗时，移除 token、输入 / 输出明细及费用；底部状态栏用量显示不变。
- 检测到 `pi-cc-extensions` 接管工具渲染时自动让位；不干扰其他扩展的自定义状态栏。
- 增加工具渲染、状态栏、计时、窄屏、重载和非 TUI 模式测试。

### 升级提示

- 手动安装过 `omp-editor.js` 或 `done.js` 时，先将旧脚本移出扩展目录，避免重复加载。
- 兼容旧配置，缺失开关默认启用；状态栏沿用 `footerIconEnabled`。
- 固定标签 `v1.0.0` 不包含以上改动；主分支更新后需重启 Pi 或执行 `/reload`。

## [1.0.0] - 2026-10-17

- 首次发布 OMP 风格输入框：圆角左边框、开放右侧、紧凑留白与合并底边。
- 保留原生编辑、补全和输入法行为，修正补全菜单鼠标坐标偏移。
- 提供 `/omp-editor on|off|status`，保存开关并在启动和重载后恢复。
- 支持 Pi Git 包安装，采用 MIT 许可证。

[未发布]: https://github.com/guoguo397/pi-omp-ui/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guoguo397/pi-omp-ui/releases/tag/v1.0.0
