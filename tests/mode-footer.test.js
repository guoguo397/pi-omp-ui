import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderClaudeFooter } from "../extensions/lib/footer-icon.js";
import { MODE_STATUS } from "../extensions/lib/interaction-mode.js";

const theme = { fg: (_token, text) => text };
const base = {
	modelName: "Model", cwd: "/repo", thinkingLevel: "high",
	usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
	statuses: new Map([[MODE_STATUS, "duplicated mode status"], ["subagents", "← 2 agents"]]),
};

test("mode labels lead the existing status line, retain real plugin statuses and replace ready", () => {
	for (const [interactionMode, label] of [["execute", "⏵⏵ accept edits on"], ["plan", "⏸ plan mode"]]) {
		for (const busy of [false, true]) {
			const lines = renderClaudeFooter({ ...base, interactionMode, busy }, 200, theme);
			assert.equal(lines.length, 4);
			assert.equal(lines[3], `${label} (shift+tab to cycle) · thinking high · ↑1.0k ↓200 · $0.0100 · ← 2 agents`);
			assert.doesNotMatch(lines[3], /ready|duplicated|working/);
		}
	}
	const compacting = renderClaudeFooter({ ...base, interactionMode: "plan", compacting: true }, 200, theme);
	assert.match(compacting[3], /plan mode.*▶ compacting/);
	const withoutAgents = renderClaudeFooter({ ...base, interactionMode: "execute", statuses: new Map() }, 200, theme);
	assert.doesNotMatch(withoutAgents.join("\n"), /agents/, "do not simulate an agent count");
});

test("mode row retains tool statistics and output speed without adding any lines", () => {
	const lines = renderClaudeFooter({
		...base, interactionMode: "plan", outputSpeed: 42.6,
		toolUsage: { total: 1, counts: new Map([["read", 1]]) },
	}, 200, theme);
	assert.equal(lines.length, 5);
	assert.equal(lines[3], "✓ Read ×1");
	assert.match(lines[4], /^⏸ plan mode.*↓200 · 42\.6 tok\/s · \$0\.0100/);
});

test("mode colors follow live themes and fit all narrow widths", () => {
	const tagged = { fg: (token, text) => `<${token}>${text}</${token}>` };
	assert.match(renderClaudeFooter({ ...base, interactionMode: "execute" }, 1000, tagged)[3], /<thinkingHigh>⏵⏵ accept edits on<\/thinkingHigh>/);
	assert.match(renderClaudeFooter({ ...base, interactionMode: "plan" }, 1000, tagged)[3], /<warning>⏸ plan mode<\/warning>/);
	for (const interactionMode of ["execute", "plan"]) {
		for (let width = 0; width <= 160; width++) {
			const lines = renderClaudeFooter({ ...base, interactionMode }, width, {
				fg: (_token, text) => `\x1b[35m${text}\x1b[0m`,
			});
			assert.equal(lines.length, 4);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
				assert.doesNotMatch(stripTerminalSequences(line), /[\r\n]/);
			}
		}
	}
});
