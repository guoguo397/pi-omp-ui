import { Theme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, mixColors } from "@earendil-works/pi-tui";

const PATCH_KEY = Symbol.for("pi.omp-ui.user-message-style");

// 仅解析终端默认底色，不注册或替换用户主题；Theme 会跟随终端颜色更新。
function defaultBackground(appearance) {
	return new Theme(
		{ text: "", muted: "", thinkingXhigh: "" },
		{ userMessageBg: "", selectedBg: "" },
		"truecolor", { appearance },
	);
}

/** 仅改写原生用户消息的背景 ANSI，不动文本、Markdown、留白及 OSC 区域标记。 */
export function installUserMessageStyle(getTheme) {
	globalThis[PATCH_KEY]?.dispose();
	const prototype = UserMessageComponent.prototype;
	const originalRender = prototype.render;
	const defaults = { dark: defaultBackground("dark"), light: defaultBackground("light") };
	let active = true;
	let cache;
	const render = function (width) {
		const lines = originalRender.call(this, width);
		if (!active || lines.length === 0) return lines;
		const theme = getTheme();
		if (typeof theme?.getBgAnsi !== "function" || typeof theme?.getColorMode !== "function") return lines;
		const sourceAnsi = theme.getBgAnsi("userMessageBg");
		// 默认背景已经没有色块，不要把复位码改成显式颜色。
		if (!sourceAnsi || sourceAnsi === "\x1b[49m") return lines;
		const source = theme.colors?.userMessageBg;
		if (!source) return lines;
		const background = defaults[theme.appearance === "light" ? "light" : "dark"].colors.userMessageBg;
		const mode = theme.getColorMode();
		if (!cache || cache.source !== source || cache.background !== background || cache.mode !== mode || cache.sourceAnsi !== sourceAnsi) {
			cache = { source, background, mode, sourceAnsi,
				replacement: backgroundAnsi(mixColors(source, background, 0.2, "srgb"), mode),
			};
		}
		return lines.map((line) => line.replaceAll(sourceAnsi, cache.replacement));
	};
	prototype.render = render;
	const patch = {
		dispose() {
			if (!active) return;
			active = false;
			if (prototype.render === render) prototype.render = originalRender;
			if (globalThis[PATCH_KEY] === patch) delete globalThis[PATCH_KEY];
		},
	};
	globalThis[PATCH_KEY] = patch;
	return patch;
}

export function registerUserMessageStyle(pi) {
	let patch;
	pi.on("session_start", (_event, ctx) => {
		patch?.dispose();
		patch = ctx.mode === "tui" ? installUserMessageStyle(() => ctx.ui.theme) : undefined;
	});
	pi.on("session_shutdown", () => {
		patch?.dispose();
		patch = undefined;
	});
}
