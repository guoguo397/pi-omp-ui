import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 在加载设置模块前隔离 agent 目录，测试绝不修改用户的真实配置。
const agentDir = mkdtempSync(join(tmpdir(), "omp-auto-title-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { deriveSessionTitle, registerAutoTitle } = await import("../extensions/lib/auto-title.js");

test("deriveSessionTitle collapses whitespace and skips commands and empty text", () => {
	assert.equal(deriveSessionTitle("  修复  登录\n页面样式  "), "修复 登录 页面样式");
	assert.equal(deriveSessionTitle("/omp-editor on"), "");
	assert.equal(deriveSessionTitle("   "), "");
	assert.equal(deriveSessionTitle(undefined), "");
});

test("deriveSessionTitle truncates long titles with an ellipsis, counting code points", () => {
	const long = "一二三四五六七八九十".repeat(5); // 50 个汉字
	const title = deriveSessionTitle(long);
	assert.equal([...title].length, 40);
	assert.ok(title.endsWith("…"));
	assert.equal(deriveSessionTitle("短标题"), "短标题");
});

function mockPi(sessionName) {
	const handlers = [];
	const calls = [];
	return {
		handlers,
		calls,
		pi: {
			getSessionName: () => sessionName,
			setSessionName: (name) => calls.push(name),
			on: (name, handler) => { if (name === "input") handlers.push(handler); },
		},
	};
}

test("registerAutoTitle names an unnamed session from the first interactive input", () => {
	const { handlers, calls, pi } = mockPi("");
	registerAutoTitle(pi);
	assert.equal(handlers.length, 1);
	handlers[0]({ text: "优化工具分组和状态栏", source: "interactive" });
	assert.deepEqual(calls, ["优化工具分组和状态栏"]);
});

test("registerAutoTitle never renames a session that already has a name", () => {
	const { handlers, calls, pi } = mockPi("已有标题");
	registerAutoTitle(pi);
	handlers[0]({ text: "新的输入", source: "interactive" });
	assert.deepEqual(calls, []);
});

test("registerAutoTitle ignores non-interactive sources and slash commands", () => {
	const { handlers, calls, pi } = mockPi("");
	registerAutoTitle(pi);
	handlers[0]({ text: "来自 RPC", source: "rpc" });
	handlers[0]({ text: "/compact", source: "interactive" });
	handlers[0]({ text: "", source: "interactive" });
	assert.deepEqual(calls, []);
});

test("registerAutoTitle respects the autoTitle setting", async (t) => {
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const { mkdirSync } = await import("node:fs");
	const settingsPath = join(agentDir, "extension-settings", "omp-editor.json");
	mkdirSync(join(agentDir, "extension-settings"), { recursive: true });
	writeFileSync(settingsPath, JSON.stringify({ autoTitle: false }), "utf8");
	const { handlers, calls, pi } = mockPi("");
	registerAutoTitle(pi);
	handlers[0]({ text: "不应命名", source: "interactive" });
	assert.deepEqual(calls, []);
});
