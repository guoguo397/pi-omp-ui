import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
/**
 * Pi 的 OMP 风格输入框。
 *
 * 保留 Pi 原生的快捷键、历史记录、粘贴处理、自动补全、
 * 鼠标支持和输入法行为，仅修改输入框外观。
 */

const BOTTOM_MARKER = "\x1b[0m";
const BASE_PADDING_X = 3;
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|avif)$/i;

/** 仅把确实存在的本地图片路径折叠为标签，普通文字或混合粘贴保持原样。 */
function imagePathParts(text, cwd) {
	const isImage = (raw) => {
		let path = raw.trim().replace(/^(["'])(.*)\1$/, "$2").replace(/\\ /g, " ");
		if (!IMAGE_EXTENSION.test(path)) return false;
		if (path.startsWith("~/") || path.startsWith("~\\")) path = resolve(homedir(), path.slice(2));
		try { return statSync(resolve(cwd, path)).isFile(); } catch { return false; }
	};
	if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return;
	const trimmed = text.trim();
	if (!trimmed) return;
	if (isImage(trimmed)) return [{ raw: trimmed, index: text.indexOf(trimmed) }];
	// 剪贴板文件列表通常逐行分隔，终端拖入多个文件通常用空格及引号分隔。
	const lines = [...text.matchAll(/[^\r\n]+/g)].map((m) => ({ raw: m[0].trim(), index: m.index + m[0].indexOf(m[0].trim()) }));
	if (lines.length > 1 && lines.every((part) => isImage(part.raw))) return lines;
	const parts = [...text.matchAll(/"[^"\r\n]+"|'[^'\r\n]+'|(?:\\ |[^\s"'])+/g)]
		.map((m) => ({ raw: m[0], index: m.index }));
	if (parts.length && parts.every((part) => isImage(part.raw)) &&
		text.replace(/"[^"\r\n]+"|'[^'\r\n]+'|(?:\\ |[^\s"'])+/g, "").trim() === "") return parts;
}

function fitColumns(text, width) {
	if (width <= 0) return "";
	const sliced = sliceByColumn(text, 0, width, true);
	return sliced + " ".repeat(Math.max(0, width - visibleWidth(sliced)));
}

export class OmpEditor extends CustomEditor {
	constructor(tui, theme, keybindings, { getCompletion = () => "", getSessionTitle = () => "", cwd = process.cwd() } = {}) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.getCompletion = getCompletion;
		this.getSessionTitle = getSessionTitle;
		this.cwd = cwd;
		this.autocompleteStartRow = Number.POSITIVE_INFINITY;
		this.autocompleteRowOffset = 0;

		// 将三列基础留白分配为一列边框和两列内部留白。
		super.setPaddingX(BASE_PADDING_X);
	}

	/**
	 * 复用 Pi 1.3.0 的原生粘贴注册表与撤销栈，标签仍是可整体移动、删除的单元。
	 * 内部存 [paste #N]；仅在布局时等宽替换成 [Image #N]，提交仍由 Pi 展开原路径。
	 */
	insertImagePaths(text) {
		if (this.getExpandedText().trimStart().startsWith("!")) return false;
		const parts = imagePathParts(text, this.cwd);
		if (!parts || !(this.pastes instanceof Map)) return false;
		this.cancelAutocomplete();
		this.pushUndoSnapshot();
		this.lastAction = null;
		this.exitHistoryBrowsing();
		let result = "";
		let end = 0;
		for (const part of parts) {
			const id = ++this.pasteCounter;
			this.pastes.set(id, part.raw);
			result += text.slice(end, part.index) + `[paste #${id}]`;
			end = part.index + part.raw.length;
		}
		result += text.slice(end);
		const { line, col } = this.getCursor();
		const current = this.getLines()[line];
		const before = this.expandPasteMarkers(current.slice(0, col)).at(-1);
		const after = this.expandPasteMarkers(current.slice(col))[0];
		if (before && !/\s/.test(before) && !/^\s/.test(result)) result = ` ${result}`;
		if (after && !/\s/.test(after) && !/\s$/.test(result)) result += " ";
		this.insertTextAtCursorInternal(result);
		return true;
	}

	handlePaste(text) {
		if (!this.insertImagePaths(text)) super.handlePaste(text);
	}

	insertTextAtCursor(text) {
		if (!this.insertImagePaths(text)) super.insertTextAtCursor(text);
	}

	handleInput(data) {
		// 有括号的粘贴（包括分片输入）交给 Pi 缓冲；兼容不带括号的一次性路径拖入。
		if (!this.isInPaste && data.length > 1 && !data.includes("\x1b") && this.insertImagePaths(data)) return;
		super.handleInput(data);
	}

	handleBackspace() {
		// Pi 1.3.0 重编号无后缀粘贴标签时会拼接 undefined；在原生 change 回调前局部修正。
		const onChange = this.onChange;
		this.onChange = () => {
			const repair = (line) => line.replace(/\[paste #(\d+)undefined\]/g, (marker, id) =>
				this.pastes.has(Number(id)) ? `[paste #${id}]` : marker);
			const { line, col } = this.getCursor();
			this.state.cursorCol = repair(this.state.lines[line].slice(0, col)).length;
			this.state.lines = this.state.lines.map(repair);
			onChange?.(this.getText());
		};
		try { super.handleBackspace(); } finally { this.onChange = onChange; }
	}

	imageMarkers(text, display = false) {
		return text.replace(/\[paste #(\d+)\]/g, (marker, id) => {
			const path = this.pastes.get(Number(id));
			if (!path || !IMAGE_EXTENSION.test(path.trim().replace(/^(["'])(.*)\1$/, "$2"))) return marker;
			return display ? `[Image #${id}]` : path;
		});
	}

	getText() {
		// Pi 切换输入框、打开对话框或保存草稿时会读取 getText，不能把无映射的标签传出去。
		return this.imageMarkers(super.getText());
	}

	layoutText(width) {
		const rows = super.layoutText(width);
		const lines = this.getLines();
		const display = lines.map((line) => this.imageMarkers(line, true));
		if (display.every((line, index) => line === lines[index])) return rows;
		let logical = 0;
		let offset = 0;
		// 两种标签等长等宽；沿用原生分行和光标坐标，极窄终端也不会露出内部标签。
		return rows.map((row) => {
			const text = display[logical].slice(offset, offset + row.text.length);
			offset += row.text.length;
			if (offset >= lines[logical].length) { logical++; offset = 0; }
			return { ...row, text };
		});
	}

	/** Pi 重新应用设置时，仍保留 OMP 风格的两列内部留白。 */
	setPaddingX(_padding) {
		super.setPaddingX(BASE_PADDING_X);
	}

	/** 耗时仍居中，会话名嵌入右半段；只覆盖空横线，不挤占原生运行或滚动提示。 */
	renderTopBorder(width, hiddenLineCount) {
		const message = this.getCompletion();
		// 滚动提示优先，保留原生多行编辑行为。
		if (hiddenLineCount > 0 || width < 7) return super.renderTopBorder(width, hiddenLineCount);
		let border;
		if (message) {
			const label = ` ${truncateToWidth(message, width - 4, "…")} `;
			const remaining = width - visibleWidth(label);
			const left = Math.floor(remaining / 2);
			border = this.borderColor("─".repeat(left)) + label + this.borderColor("─".repeat(remaining - left));
		} else {
			border = super.renderTopBorder(width, hiddenLineCount);
		}
		const title = stripTerminalSequences(String(this.getSessionTitle() ?? ""))
			.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
		if (!title) return border;
		// 留一列横线分隔前面的标签，右侧留两列收尾；窄屏优先保住耗时及运行提示。
		const trailing = /─+$/.exec(stripTerminalSequences(border))?.[0].length ?? 0;
		const start = Math.max(Math.ceil(width / 2), width - trailing + 1);
		const available = width - start - 4;
		if (available < 4) return border;
		const label = ` ${truncateToWidth(title, available, "…")} `;
		const labelStart = width - 2 - visibleWidth(label);
		return sliceByColumn(border, 0, labelStart, true) + this.borderColor(label + "──");
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
