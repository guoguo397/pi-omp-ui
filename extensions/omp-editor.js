import { CustomEditor, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Pi 的 OMP 风格输入框。
 *
 * 保留 Pi 原生的快捷键、历史记录、粘贴处理、自动补全、
 * 鼠标支持和输入法行为，仅修改输入框外观。
 */

const BOTTOM_MARKER = "\x1b[0m";
const BASE_PADDING_X = 3;
const SETTINGS_PATH = join(getAgentDir(), "extension-settings", "omp-editor.json");

function readEnabledSetting() {
	try {
		const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
		return settings.enabled !== false;
	} catch {
		// 首次安装、配置文件缺失或无效时，默认启用。
		return true;
	}
}

function writeEnabledSetting(enabled) {
	mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
	writeFileSync(SETTINGS_PATH, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
}

function fitColumns(text, width) {
	if (width <= 0) return "";
	const sliced = sliceByColumn(text, 0, width, true);
	return sliced + " ".repeat(Math.max(0, width - visibleWidth(sliced)));
}

export class OmpEditor extends CustomEditor {
	constructor(tui, theme, keybindings) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.autocompleteStartRow = Number.POSITIVE_INFINITY;
		this.autocompleteRowOffset = 0;

		// 将三列基础留白分配为一列边框和两列内部留白。
		super.setPaddingX(BASE_PADDING_X);
	}

	/** Pi 重新应用设置时，仍保留 OMP 风格的两列内部留白。 */
	setPaddingX(_padding) {
		super.setPaddingX(BASE_PADDING_X);
	}

	/** 添加不可见标记，供 render() 可靠地定位 Pi 的底边框。 */
	renderBottomBorder(width, hiddenLineCount) {
		return BOTTOM_MARKER + super.renderBottomBorder(width, hiddenLineCount);
	}

	render(width) {
		const base = [...super.render(width)];
		const effectivePadding = Math.min(
			BASE_PADDING_X,
			Math.max(0, Math.floor((width - 1) / 2)),
		);
		if (effectivePadding < 1 || base.length < 3) return base;

		const bottomIndex = base.findIndex(
			(line, index) => index > 0 && line.startsWith(BOTTOM_MARKER),
		);
		if (bottomIndex < 2) return base;

		const top = base[0];
		const content = base.slice(1, bottomIndex);
		const autocomplete = base.slice(bottomIndex + 1);
		const rawBottom = base[bottomIndex].slice(BOTTOM_MARKER.length);

		const framedTop =
			this.borderColor("╭") +
			fitColumns(sliceByColumn(top, 1, width - 2, true), width - 2) +
			this.borderColor("─");

		// 下方仍有隐藏内容时，用独立的圆角底边保留 Pi 的滚动提示；
		// 否则将底边与最后一行合并，保持 OMP 风格的紧凑布局。
		const hasLowerOverflow = stripTerminalSequences(rawBottom).includes("↓");
		const framedRows = content.map((line, index) => {
			const isLast = index === content.length - 1;
			if (!isLast || hasLowerOverflow) {
				return (
					this.borderColor("│") +
					fitColumns(sliceByColumn(line, 1, width - 2, true), width - 2) +
					" "
				);
			}

			const bottomLeft =
				effectivePadding >= 2
					? `╰─${" ".repeat(effectivePadding - 2)}`
					: "╰";
			// 保留原有留白，但不绘制右侧边框或封口。
			const bottomRight = " ".repeat(effectivePadding);
			const centerWidth = width - effectivePadding * 2;
			return (
				this.borderColor(bottomLeft) +
				fitColumns(
					sliceByColumn(line, effectivePadding, centerWidth, true),
					centerWidth,
				) +
				this.borderColor(bottomRight)
			);
		});

		const overflowRow = hasLowerOverflow
			? [
				this.borderColor("╰") +
				fitColumns(sliceByColumn(rawBottom, 1, width - 2, true), width - 2) +
				this.borderColor("─"),
			]
			: [];

		this.autocompleteStartRow = 1 + framedRows.length + overflowRow.length;
		this.autocompleteRowOffset = hasLowerOverflow ? 0 : 1;
		return [framedTop, ...framedRows, ...overflowRow, ...autocomplete];
	}

	handleMouse(event) {
		// 合并底边后，比 Pi 的基础渲染少一行，
		// 因此需要将补全菜单的鼠标坐标换算回原始行号。
		if (event.y >= this.autocompleteStartRow && this.autocompleteRowOffset > 0) {
			return super.handleMouse({
				...event,
				y: event.y + this.autocompleteRowOffset,
			});
		}
		return super.handleMouse(event);
	}
}

export default function ompEditorExtension(pi) {
	let previousFactory;
	let enabled = readEnabledSetting();
	let deferredInstall;

	const factory = (tui, theme, keybindings) =>
		new OmpEditor(tui, theme, keybindings);
	const isActive = (ctx) => ctx.ui.getEditorComponent() === factory;

	const install = (ctx) => {
		if (ctx.mode !== "tui") return;
		if (!isActive(ctx)) previousFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent(factory);
	};

	const uninstall = (ctx) => {
		if (ctx.mode === "tui" && isActive(ctx)) {
			ctx.ui.setEditorComponent(previousFactory);
		}
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
				writeEnabledSetting(enabled);
				install(ctx);
				ctx.ui.notify("omp-editor enabled (saved)", "info");
				return;
			}
			if (action === "off") {
				enabled = false;
				writeEnabledSetting(enabled);
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
