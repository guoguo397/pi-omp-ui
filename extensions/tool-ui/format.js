import { homedir } from "node:os";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

export const COMPACT_TOOLS = new Set([
	"read", "ls", "find", "grep", "bash", "powershell", "edit", "write", "codemode", "tool_search",
]);

/** 工具参数和输出都是不可信文本，不让控制字符改变终端状态。 */
export function plain(value) {
	return stripTerminalSequences(String(value ?? ""))
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "  ")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function oneLine(value, limit = 300) {
	return plain(String(value ?? "").slice(0, limit * 4)).replace(/\s+/g, " ").trim().slice(0, limit);
}

/** 只缩写完整主目录边界；保留其他目录的完整路径，避免误把 hy-other 当作 hy。 */
export function displayPath(value, home = homedir()) {
	const original = String(value ?? "");
	const path = original.replace(/\\/g, "/");
	const root = String(home).replace(/\\/g, "/").replace(/\/+$/, "");
	const windows = /^[a-z]:\//i.test(root) || root.startsWith("//");
	const comparablePath = windows ? path.toLowerCase() : path;
	const comparableRoot = windows ? root.toLowerCase() : root;
	if (root && comparablePath === comparableRoot) return "~";
	if (root && comparablePath.startsWith(`${comparableRoot}/`)) return oneLine(`~/${path.slice(root.length + 1)}`);
	return oneLine(original);
}

export function title(name) {
	return ({ powershell: "PowerShell", tool_search: "Tool Search" })[name] ??
		oneLine(name).replace(/(^|[_-])(\w)/g, (_match, separator, letter) =>
			`${separator ? " " : ""}${letter.toUpperCase()}`);
}

export function parseArgs(value) {
	if (typeof value !== "string") return value && typeof value === "object" ? value : {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return { preview: value };
	}
}

export function callSummary(name, input) {
	const args = parseArgs(input);
	const path = args.path ?? args.file_path;
	switch (name) {
		case "read": return displayPath(path);
		case "ls": return displayPath(path ?? ".");
		case "grep": return oneLine(`"${args.pattern ?? ""}" in ${displayPath(path ?? ".")}`);
		case "find": return oneLine(`${args.pattern ?? ""} in ${displayPath(path ?? ".")}`);
		case "edit":
		case "write": return displayPath(path);
		case "bash":
		case "powershell": return oneLine(args.command);
		case "tool_search": return oneLine(args.query);
		// 脚本仅在展开后的完整输入中展示，不把实现代码作为标题摘要。
		case "codemode": return "";
		default: return path != null ? displayPath(path) : oneLine(args.query ?? args.command ?? args.preview ?? JSON.stringify(args));
	}
}

let toolCaches = new WeakMap();

/** 原生 updateDisplay / invalidate 通知原地更新；重装补丁时清空旧缓存。 */
export function invalidateToolCache(tool) {
	if (tool === undefined) toolCaches = new WeakMap();
	else toolCaches.delete(tool);
}

/** 仅缓存已完成结果，流式结果可能原地修改，不能只比较对象引用。 */
export function getToolCache(tool) {
	const result = tool.result;
	if (!result || tool.isPartial) {
		toolCaches.delete(tool);
		return {};
	}
	let cache = toolCaches.get(tool);
	if (!cache || cache.result !== result || cache.args !== tool.args || cache.toolName !== tool.toolName ||
		cache.content !== result.content || cache.details !== result.details || cache.isError !== result.isError) {
		cache = { result, args: tool.args, toolName: tool.toolName,
			content: result.content, details: result.details, isError: result.isError };
		toolCaches.set(tool, cache);
	}
	return cache;
}

export function toolOutputText(tool) {
	const cache = getToolCache(tool);
	return cache.text ??= outputText(tool.result, tool.toolName);
}

export function outputText(result, name) {
	const blocks = (result?.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "");
	if (name === "codemode" && /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/.test(blocks[0] ?? "")) blocks.shift();
	return plain(blocks.join("\n")).trimEnd();
}

export function lineCount(text) {
	return text ? text.split("\n").length : 0;
}

export function nestedCalls(result) {
	return Array.isArray(result?.details?.calls) ? result.details.calls : [];
}

export function duration(value) {
	if (!Number.isFinite(value) || value < 0) return "";
	return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

export function status(tool) {
	if (!tool.result || tool.isPartial) return "running";
	return tool.result.isError ? "error" : "ok";
}

export function resultSummary(tool) {
	const cache = getToolCache(tool);
	if (cache.summary !== undefined) return cache.summary;
	const text = cache.text ?? outputText(tool.result, tool.toolName);
	// 折叠卡只保留短摘要，避免为全部历史输出常驻一份清理后的全文。
	if (tool.expanded) cache.text = text;
	return cache.summary = summarizeResult(tool, text);
}

function summarizeResult(tool, text) {
	if (tool.result?.isError) return oneLine(text || "Tool failed");
	const count = lineCount(text);
	const images = (tool.result?.content ?? []).filter((item) => item.type === "image").length;
	if (tool.toolName === "codemode") {
		const calls = nestedCalls(tool.result);
		const failed = calls.filter((call) => call.status === "error" || call.status === "cancelled").length;
		return [calls.length ? `${calls.length} calls` : "", failed ? `${failed} failed` : "", `${count} lines output`].filter(Boolean).join(" · ");
	}
	if (images) return `${images} image${images === 1 ? "" : "s"}${count ? ` · ${count} lines` : ""}`;
	if (tool.toolName === "write") return "File written";
	return `${count} line${count === 1 ? "" : "s"} ${tool.toolName === "read" ? "loaded" : "returned"}`;
}
