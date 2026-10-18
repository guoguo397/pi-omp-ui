import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { callSummary, duration, nestedCalls, oneLine, outputText, plain, resultSummary, status, title } from "./format.js";
import { diffStats, parseDiff, renderDiffRows } from "./diff.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const diffCache = new WeakMap();

export function icon(value, theme) {
	if (value === "ok") return theme.fg("success", "✓");
	if (value === "error") return theme.fg("error", "✗");
	if (value === "cancelled") return theme.fg("warning", "⊘");
	return theme.fg("muted", FRAMES[Math.floor(Date.now() / 90) % FRAMES.length]);
}

function diffRows(tool) {
	const details = tool.result?.details;
	if (!details || typeof details !== "object" || tool.result?.isError) return [];
	if (!diffCache.has(details)) diffCache.set(details, parseDiff(details));
	return diffCache.get(details);
}

export function toolLine(tool, theme, grouped = false) {
	const detail = grouped && tool.toolName === "codemode" && tool.result ? resultSummary(tool) : callSummary(tool.toolName, tool.args);
	return `${icon(status(tool), theme)} ${theme.fg("toolTitle", theme.bold(title(tool.toolName)))}${detail ? ` ${theme.fg("muted", detail)}` : ""}`;
}

export function padding(tool, width) {
	return Math.min(Math.max(0, tool.outputPad ?? 1), Math.max(0, width - 1));
}

function nestedLines(tool, width, theme, expanded) {
	const calls = nestedCalls(tool.result);
	const shown = expanded ? calls : calls.slice(-8);
	const lines = [];
	if (shown.length < calls.length) lines.push(theme.fg("dim", `├ … ${calls.length - shown.length} earlier calls`));
	for (let index = 0; index < shown.length; index++) {
		const call = shown[index];
		const rail = index === shown.length - 1 ? "└" : "├";
		const summary = callSummary(call.name, call.args);
		const meta = duration(call.durationMs);
		lines.push(truncateToWidth(`${theme.fg("dim", rail)} ${icon(call.status, theme)} ${theme.fg("toolTitle", title(call.name))} ${theme.fg("muted", summary)}${meta ? theme.fg("dim", ` · ${meta}`) : ""}`, width, ""));
		if (call.error) lines.push(truncateToWidth(theme.fg("error", `  ${oneLine(call.error)}`), width, ""));
	}
	return lines;
}

function inputText(args) {
	try { return plain(JSON.stringify(args, null, 2) ?? ""); }
	catch { return "[Input unavailable]"; }
}

export function renderTool(tool, width, theme, hint) {
	if (width < 1) return [];
	const pad = padding(tool, width);
	const inner = Math.max(1, width - pad * 2);
	const lines = [toolLine(tool, theme)];
	if (tool.toolName === "codemode") lines.push(...nestedLines(tool, inner, theme, tool.expanded));
	if (tool.result) {
		const rows = tool.toolName === "edit" ? diffRows(tool) : [];
		if (rows.length) {
			const stats = diffStats(rows);
			const barWidth = 16;
			const green = Math.round(barWidth * stats.added / Math.max(1, stats.added + stats.removed));
			lines.push(`${theme.fg("dim", "  ↳ diff")} ${theme.fg("success", `+${stats.added}`)} ${theme.fg("error", `−${stats.removed}`)} ${theme.fg("dim", inner >= 100 ? "split" : "unified")} [${theme.fg("success", "━".repeat(green))}${theme.fg("error", "━".repeat(barWidth - green))}]`);
			lines.push(...renderDiffRows(rows, inner, theme, tool.expanded));
		}
		const meta = duration(tool.result.durationMs);
		const summary = resultSummary(tool);
		lines.push(`${theme.fg(tool.result.isError ? "error" : "muted", `  ↳ ${summary}`)}${meta ? theme.fg("dim", ` · ${meta}`) : ""}${theme.fg("dim", ` · ${tool.expanded ? "click to collapse" : hint}`)}`);
	}
	if (tool.expanded) {
		lines.push(theme.fg("dim", "  Input"));
		for (const line of wrapTextWithAnsi(inputText(tool.args), Math.max(1, inner - 2))) lines.push(theme.fg("muted", `  ${line}`));
		const output = outputText(tool.result, tool.toolName);
		if (output) {
			lines.push(theme.fg("dim", "  Output"));
			for (const line of wrapTextWithAnsi(output, Math.max(1, inner - 2))) lines.push(theme.fg(tool.result?.isError ? "error" : "toolOutput", `  ${line}`));
		}
		const full = tool.result?.details?.fullOutputPath;
		if (full) lines.push(theme.fg("dim", `  Full output: ${oneLine(full, 2000)}`));
	}
	const rendered = ["", ...lines.map((line) => " ".repeat(pad) + truncateToWidth(line, inner, ""))];
	// 原生组件负责图像转换及缓存；只在展开时显示，避免折叠卡吞掉图片。
	if (tool.expanded && tool.showImages) {
		for (const image of tool.imageComponents ?? []) rendered.push(...image.render(width));
	}
	return rendered;
}

export function renderGroupHeader(tools, theme, expanded, hint) {
	const names = new Set(tools.map((tool) => tool.toolName));
	const states = tools.map(status);
	const running = states.filter((state) => state === "running").length;
	const failed = states.filter((state) => state === "error").length;
	const name = names.size === 1 ? title(tools[0].toolName) : "Multiple Tools";
	const progress = [running ? `${running} running` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(" · ");
	const color = failed ? "error" : running ? "muted" : "success";
	return `${theme.fg(color, "●")} ${theme.fg("toolTitle", `${name} (${tools.length})`)}${progress ? theme.fg(color, ` · ${progress}`) : ""}${theme.fg("dim", ` · ${expanded ? "click to collapse" : hint}`)}`;
}

export function fitGroupRow(tool, width, theme, last) {
	return truncateToWidth(`${theme.fg("dim", last ? "└" : "├")} ${toolLine(tool, theme, true)}`, width, "");
}

export function fitLine(text, width) {
	return visibleWidth(text) <= width ? text : truncateToWidth(text, Math.max(0, width), "");
}
