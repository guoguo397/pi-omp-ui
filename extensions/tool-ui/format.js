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
		case "codemode": return oneLine(String(args.code ?? "").split("\n").find((line) => line.trim() && !line.trim().startsWith("//")));
		default: return path != null ? displayPath(path) : oneLine(args.query ?? args.command ?? args.preview ?? JSON.stringify(args));
	}
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
	const text = outputText(tool.result, tool.toolName);
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
