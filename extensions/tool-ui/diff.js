import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { plain } from "./format.js";

/** 优先解析工具返回的真实 patch，而不是重新读取（可能已被后续调用修改的）文件。 */
export function parseDiff(details) {
	if (typeof details?.patch === "string" && details.patch.includes("@@")) {
		const rows = [];
		let old = 0;
		let next = 0;
		let inHunk = false;
		for (const line of plain(details.patch).split("\n")) {
			const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			if (hunk) {
				if (rows.length) rows.push({ kind: "gap", text: "…" });
				old = Number(hunk[1]);
				next = Number(hunk[2]);
				inHunk = true;
			} else if (inHunk && /^[ +\-]/.test(line)) {
				const kind = line[0];
				rows.push({ kind, old: kind === "+" ? undefined : old++, next: kind === "-" ? undefined : next++, text: line.slice(1) });
			}
		}
		return rows;
	}
	if (typeof details?.diff !== "string") return [];
	// 兼容旧会话只保存的 Pi 显示 diff：上下文行的数字是旧文件行号。
	let delta = 0;
	return plain(details.diff).split("\n").flatMap((line) => {
		const match = /^([ +\-])\s*(\d+) (.*)$/.exec(line);
		if (!match) return line.includes("...") ? [{ kind: "gap", text: "…" }] : [];
		const [, kind, number, text] = match;
		const n = Number(number);
		if (kind === "-") { delta--; return [{ kind, old: n, text }]; }
		if (kind === "+") { delta++; return [{ kind, next: n, text }]; }
		return [{ kind, old: n, next: n + delta, text }];
	});
}

export function diffStats(rows) {
	return { added: rows.filter((row) => row.kind === "+").length, removed: rows.filter((row) => row.kind === "-").length };
}

function pairs(rows) {
	const result = [];
	for (let i = 0; i < rows.length;) {
		const row = rows[i];
		if (row.kind === " " || row.kind === "gap") {
			result.push([row, row]);
			i++;
			continue;
		}
		const removed = [];
		const added = [];
		while (i < rows.length && rows[i].kind === "-") removed.push(rows[i++]);
		while (i < rows.length && rows[i].kind === "+") added.push(rows[i++]);
		for (let n = 0; n < Math.max(removed.length, added.length); n++) result.push([removed[n], added[n]]);
	}
	return result;
}

function pad(text, width) {
	const clipped = truncateToWidth(text, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function paint(row, side, width, digits, theme) {
	if (!row) return " ".repeat(width);
	if (row.kind === "gap") return theme.fg("dim", pad("…", width));
	const number = side === "old" ? row.old : row.next;
	const prefix = `${String(number ?? "").padStart(digits)} │ `;
	const text = pad(prefix + row.text, width);
	if (row.kind === "+") return theme.bg("toolSuccessBg", theme.fg("toolDiffAdded", text));
	if (row.kind === "-") return theme.bg("toolErrorBg", theme.fg("toolDiffRemoved", text));
	return theme.fg("toolDiffContext", text);
}

/** 宽屏左右对照，窄屏自动切换统一 diff；折叠时限制高度，但不丢失展开内容。 */
export function renderDiffRows(rows, width, theme, expanded = false) {
	if (!rows.length || width < 1) return [];
	const digits = String(rows.reduce((max, row) => Math.max(max, row.old ?? 0, row.next ?? 0), 1)).length;
	let lines;
	if (width >= 100) {
		const left = Math.floor((width - 3) / 2);
		const right = width - left - 3;
		lines = [theme.fg("dim", `${pad("old", left)} │ ${pad("new", right)}`), ...pairs(rows).map(([old, next]) =>
			`${paint(old, "old", left, digits, theme)}${theme.fg("dim", " │ ")}${paint(next, "new", right, digits, theme)}`)];
	} else {
		lines = rows.map((row) => {
			if (row.kind === "gap") return theme.fg("dim", "…");
			const token = row.kind === "+" ? "toolDiffAdded" : row.kind === "-" ? "toolDiffRemoved" : "toolDiffContext";
			return theme.fg(token, truncateToWidth(`${row.kind}${String(row.next ?? row.old).padStart(digits)} ${row.text}`, width, ""));
		});
	}
	if (!expanded && lines.length > 20) lines = [...lines.slice(0, 20), theme.fg("dim", `… ${lines.length - 20} more rows`)];
	return lines.map((line) => sliceByColumn(line, 0, width, true));
}
