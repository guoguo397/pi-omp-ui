import { OmpEditor } from "./lib/editor.js";
import { readSettings, updateSettings } from "./lib/settings.js";
import { registerDone } from "./lib/done.js";
import { registerFooterIcon } from "./lib/footer-icon.js";
import { registerUserMessageStyle } from "./lib/user-message.js";
import { registerToolUi } from "./tool-ui/extension.js";

export { OmpEditor };

export default function ompEditorExtension(pi) {
	registerToolUi(pi);
	registerFooterIcon(pi);
	registerUserMessageStyle(pi);
	let previousFactory;
	let enabled = readSettings().enabled !== false;
	let deferredInstall;
	let completion = "";
	let activeTui;
	let activeContext;

	const factory = (tui, theme, keybindings) => {
		activeTui = tui;
		return new OmpEditor(tui, theme, keybindings, {
			cwd: activeContext.cwd,
			// 渲染时取当前主题，不缓存带旧主题颜色的统计文本。
			getCompletion: () => completion ? activeContext.ui.theme.fg("success", completion) : "",
		});
	};
	const isActive = (ctx) => ctx.ui.getEditorComponent() === factory;

	registerDone(pi, {
		onUpdate(message, ctx) {
			completion = message;
			if (!enabled || !isActive(ctx)) return false;
			activeTui?.requestRender();
			return true;
		},
	});

	const install = (ctx) => {
		if (ctx.mode !== "tui") return;
		activeContext = ctx;
		if (!isActive(ctx)) {
			previousFactory = ctx.ui.getEditorComponent();
			ctx.ui.setEditorComponent(factory);
		}
	};

	const uninstall = (ctx) => {
		if (ctx.mode !== "tui") return;
		if (isActive(ctx)) ctx.ui.setEditorComponent(previousFactory);
		activeTui = undefined;
		activeContext = undefined;
	};

	const scheduleDeferredInstall = (ctx) => {
		if (deferredInstall !== undefined) clearTimeout(deferredInstall);
		// /reload 会重建扩展界面，并在 session_start 后应用运行时及主题设置。
		// 在下一轮事件循环中重新安装，避免后续界面恢复操作
		// 覆盖按持久化设置启用的自定义输入框。
		deferredInstall = setTimeout(() => {
			deferredInstall = undefined;
			if (enabled && ctx.mode === "tui" && !isActive(ctx)) install(ctx);
		}, 0);
	};

	// 每次启动交互式会话时，恢复持久化的启用状态。
	pi.on("session_start", (_event, ctx) => {
		if (!enabled) return;
		install(ctx);
		scheduleDeferredInstall(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (deferredInstall !== undefined) {
			clearTimeout(deferredInstall);
			deferredInstall = undefined;
		}
		uninstall(ctx);
	});

	pi.registerCommand("omp-editor", {
		description: "Toggle the OMP-style rounded prompt editor (on|off|status)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const action = args.trim().toLowerCase() || "status";

			if (action === "on") {
				enabled = true;
				updateSettings({ enabled });
				install(ctx);
				ctx.ui.notify("omp-editor enabled (saved)", "info");
				return;
			}
			if (action === "off") {
				enabled = false;
				updateSettings({ enabled });
				uninstall(ctx);
				ctx.ui.notify("omp-editor disabled (saved)", "info");
				return;
			}
			if (action === "status") {
				// 已保存为启用状态时，修复输入框被意外替换的情况。
				if (enabled && !isActive(ctx)) install(ctx);
				ctx.ui.notify(
					`omp-editor is ${enabled && isActive(ctx) ? "enabled" : "disabled"} (saved)`,
					"info",
				);
				return;
			}

			ctx.ui.notify("Usage: /omp-editor on|off|status", "warning");
		},
	});
}
