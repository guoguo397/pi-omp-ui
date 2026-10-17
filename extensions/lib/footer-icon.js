import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readSettings, updateSettings } from "./settings.js";

/**
 * 底部状态栏目录图标。
 *
 * 包装 Pi 内置 FooterComponent 的 render，在目录行前加文件夹图标。
 * 不接管 footer 本身，Git 分支、用量、费用、模型和上下文信息全部保持原生行为；
 * 其他扩展通过 setFooter 替换状态栏时不受影响（内置组件不再渲染，补丁自动空转）。
 */

const PATCH_KEY = Symbol.for("pi.omp-editor.footer-icon-patch");
const ICON = "📁 ";
const ICON_WIDTH = visibleWidth(ICON);

/** 在首行目录前加图标，超出终端宽度时先截断原行，不增加状态栏高度。 */
export function withIcon(lines, width) {
	if (lines.length === 0 || width <= ICON_WIDTH) return lines;
	lines[0] = ICON + truncateToWidth(lines[0], width - ICON_WIDTH, "");
	return lines;
}

function installIconPatch(enabled) {
	globalThis[PATCH_KEY]?.dispose();
	const footerPrototype = FooterComponent.prototype;
	const originalRender = footerPrototype.render;
	const state = { active: true };
	const render = function (width) {
		const lines = originalRender.call(this, width);
		if (!state.active || !enabled()) return lines;
		return withIcon(lines, width);
	};
	footerPrototype.render = render;
	const patch = {
		dispose() {
			if (!state.active) return;
			state.active = false;
			if (footerPrototype.render === render) footerPrototype.render = originalRender;
			if (globalThis[PATCH_KEY] === patch) delete globalThis[PATCH_KEY];
		},
	};
	globalThis[PATCH_KEY] = patch;
	return patch;
}

export function registerFooterIcon(pi) {
	let enabled = readSettings().footerIconEnabled !== false;
	let patch;

	const stop = () => {
		patch?.dispose();
		patch = undefined;
	};
	const start = (ctx) => {
		if (ctx.mode !== "tui" || !enabled || patch) return;
		patch = installIconPatch(() => enabled);
	};

	pi.on("session_start", (_event, ctx) => {
		stop();
		start(ctx);
	});
	pi.on("session_shutdown", () => { stop(); });

	pi.registerCommand("omp-footer", {
		description: "Toggle the folder icon before the cwd in the status bar (on|off|status)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const action = args.trim().toLowerCase() || "status";
			if (action === "on" || action === "off") {
				enabled = action === "on";
				updateSettings({ footerIconEnabled: enabled });
				if (enabled) start(ctx);
				else stop();
				ctx.ui.notify(`omp-footer ${enabled ? "enabled" : "disabled"} (saved)`, "info");
				return;
			}
			if (action !== "status") {
				ctx.ui.notify("Usage: /omp-footer on|off|status", "warning");
				return;
			}
			ctx.ui.notify(`omp-footer is ${enabled ? "enabled" : "disabled"} (saved)`, "info");
		},
	});
}
