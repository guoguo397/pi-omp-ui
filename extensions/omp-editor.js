import { OmpEditor } from "./lib/editor.js";
import { registerAutoTitle } from "./lib/auto-title.js";
import { registerDone } from "./lib/done.js";
import { registerFooterIcon } from "./lib/footer-icon.js";
import { registerInteractionMode } from "./lib/interaction-mode.js";
import { registerUserMessageStyle } from "./lib/user-message.js";
import { registerToolUi } from "./tool-ui/extension.js";

export { OmpEditor };

export default function ompEditorExtension(pi) {
	registerToolUi(pi);
	registerAutoTitle(pi);
	const interactionMode = registerInteractionMode(pi);
	registerFooterIcon(pi, interactionMode);
	registerUserMessageStyle(pi);
	let previousFactory;
	let deferredInstall;
	let completion = "";
	let activeTui;
	let activeContext;

	const factory = (tui, theme, keybindings) => {
		activeTui = tui;
		return new OmpEditor(tui, theme, keybindings, {
			cwd: activeContext.cwd,
			getSessionTitle: () => pi.getSessionName?.() ?? "",
			// 渲染时取当前主题，不缓存带旧主题颜色的统计文本。
			getCompletion: () => completion ? activeContext.ui.theme.fg("success", completion) : "",
		});
	};
	const isActive = (ctx) => ctx.ui.getEditorComponent() === factory;

	registerDone(pi, {
		onUpdate(message, ctx) {
			completion = message;
			if (!isActive(ctx)) return false;
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
		// 覆盖自定义输入框。
		deferredInstall = setTimeout(() => {
			deferredInstall = undefined;
			if (ctx.mode === "tui" && !isActive(ctx)) install(ctx);
		}, 0);
	};

	// 每次启动交互式会话时自动安装输入框。
	pi.on("session_start", (_event, ctx) => {
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
}
