import { keyText } from "@earendil-works/pi-coding-agent";
import { isViewportTUI } from "@earendil-works/pi-tui";
import { hasExternalToolUi, installToolUi } from "./runtime.js";

const HOST_WIDGET = "omp-editor-tool-ui-host";

export function registerToolUi(pi) {
	let patch;
	let root;
	let deferred;
	let context;

	const stop = () => {
		clearTimeout(deferred);
		deferred = undefined;
		patch?.dispose();
		patch = undefined;
		root?.requestRender();
		if (context?.mode === "tui") context.ui.setWidget(HOST_WIDGET, undefined);
		root = undefined;
	};

	const start = (ctx) => {
		context = ctx;
		if (ctx.mode !== "tui") return;
		if (hasExternalToolUi()) return;
		// 零高度 widget 只用于获取 Pi 提供的 TUI，不替换 header/footer/editor。
		ctx.ui.setWidget(HOST_WIDGET, (tui) => {
			root = tui;
			return { render: () => [], invalidate() {} };
		}, { placement: "belowEditor" });
		if (!patch) patch = installToolUi({
			theme: () => context.ui.theme,
			hint: () => root && isViewportTUI(root) ? "click to show more" : `${keyText("app.tools.expand") || "Ctrl+O"} to show more`,
		});
		root?.requestRender();
	};

	pi.on("session_start", (_event, ctx) => {
		stop();
		start(ctx);
		if (ctx.mode !== "tui") return;
		// 等其他扩展安装结束后再次检查，避免加载顺序导致双重工具 UI。
		deferred = setTimeout(() => {
			deferred = undefined;
			if (hasExternalToolUi()) stop();
			else start(ctx);
		}, 0);
	});
	pi.on("session_shutdown", () => { stop(); context = undefined; });
}
