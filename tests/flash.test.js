import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { FLASH_MODEL, FLASH_THINKING, registerFlash } from "../extensions/lib/flash.js";
import { createTitleAgentHost, titleResponse } from "./helpers/title-agent-host.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const call = (name, args) => ({ type: "toolCall", id: `${name}-${Math.random()}`, name, arguments: args });
function toolsResponse(...calls) {
	return { ...titleResponse("", "toolUse"), content: calls };
}

function create(t, mode = "tui") {
	const cwd = mkdtempSync(join(tmpdir(), "omp-flash-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeFileSync(join(cwd, "target.txt"), "old label\n");
	writeFileSync(join(cwd, "other.txt"), "other file\n");
	const handlers = new Map();
	const registered = new Map();
	const host = createTitleAgentHost();
	const calls = [];
	const updates = [];
	let interactionMode = "execute";
	const ctx = {
		cwd, mode, modelRegistry: host.modelRegistry,
		getSystemPrompt: () => "PROJECT_RULE: preserve user changes and reply in Chinese.",
		tools: [createReadTool(cwd), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd), createEditTool(cwd), createWriteTool(cwd)],
		async executeTool(name, args, options) {
			calls.push({ name, args, options });
			return ctx.tools.find((tool) => tool.name === name).execute(`nested-${calls.length}`, args, options.signal);
		},
	};
	registerFlash({
		on(name, handler) { handlers.set(name, handler); },
		registerTool(tool) { registered.set(tool.name, tool); },
		getActiveTools: () => [...registered.keys()],
	}, { getMode: () => interactionMode });
	const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
	emit("session_start");
	t.after(() => emit("session_shutdown"));
	return {
		cwd, ctx, host, calls, updates, registered, emit,
		set mode(value) { interactionMode = value; },
		get tool() { return registered.get("flash"); },
		run(params = { path: "target.txt", task: "将 old label 改为 new label，仅修改指定文件" }, signal) {
			return registered.get("flash").execute("flash-call", params, signal, (update) => updates.push(update), ctx);
		},
	};
}

test("flash registration and delegation guidance are TUI-only and reload-idempotent", (t) => {
	const s = create(t);
	assert.equal(s.tool.name, "flash");
	assert.equal(s.tool.exposure, "model-only");
	assert.equal(s.tool.executionMode, "sequential");
	assert.deepEqual(s.tool.reachesTools(), ["read", "grep", "find", "ls", "edit", "write"]);
	const prompt = { systemPromptOptions: { sections: { existing: "keep" } } };
	s.emit("before_agent_start", prompt);
	assert.match(prompt.systemPromptOptions.sections.omp_flash, /exactly ONE known file/);
	assert.match(prompt.systemPromptOptions.sections.omp_flash, /including required test\/documentation changes/);
	assert.match(prompt.systemPromptOptions.sections.omp_flash, /split a multi-file task/);
	assert.equal(prompt.systemPromptOptions.sections.existing, "keep");
	s.mode = "plan";
	s.emit("before_agent_start", prompt);
	assert.equal(prompt.systemPromptOptions.sections.omp_flash, "");
	s.emit("session_start");
	assert.equal(s.registered.size, 1);
	for (const mode of ["rpc", "json", "print"]) {
		const other = create(t, mode);
		const event = { systemPromptOptions: { sections: {} } };
		other.emit("before_agent_start", event);
		assert.equal(other.registered.size, 0);
		assert.deepEqual(event.systemPromptOptions.sections, {});
	}
});

test("flash uses the fixed model/low thinking, inherits instructions and edits exactly one file", async (t) => {
	const s = create(t);
	let round = 0;
	s.host.setResult(() => [
		toolsResponse(call("read", { path: "other.txt" }), call("read", { path: "target.txt" })),
		toolsResponse(call("edit", { path: "./target.txt", edits: [{ oldText: "old label", newText: "new label" }] })),
		titleResponse("已修改标签；未运行测试。"),
	][round++]);
	const result = await s.run();
	assert.equal(result.isError, undefined);
	assert.equal(FLASH_MODEL, "deepseek/deepseek-flash");
	assert.equal(FLASH_THINKING, "low");
	assert.equal(readFileSync(join(s.cwd, "target.txt"), "utf8"), "new label\n");
	assert.equal(readFileSync(join(s.cwd, "other.txt"), "utf8"), "other file\n");
	assert.deepEqual(s.calls.map((item) => item.name), ["read", "read", "edit"]);
	assert.equal(s.calls[2].args.path, realpathSync(join(s.cwd, "target.txt")));
	assert.deepEqual(result.details, { agent: "flash", started: true, path: realpathSync(join(s.cwd, "target.txt")), writeAttempted: true });
	assert.equal(result.usage.input, 30);
	assert.equal(result.usage.output, 15);
	assert.equal(result.usage.totalTokens, 45);
	assert.match(result.content[0].text, /主 agent.*验证/);
	for (const request of s.host.requests) {
		assert.equal(request.model.id, "deepseek-flash");
		assert.equal(request.options.reasoning, "low");
		assert.match(request.options.sessionId, /^flash:/);
	}
	const system = s.host.requests[0].context.messages[0];
	assert.match(system.content, /PROJECT_RULE/);
	assert.match(system.content, /You are flash/);
	assert.deepEqual(system.toolsAdded.map((tool) => tool.name), ["read", "grep", "find", "ls", "edit", "write"]);
	assert.equal(s.updates.length, 3);
});

test("both edit and write reject a second file, even through traversal", async (t) => {
	for (const name of ["edit", "write"]) {
		const s = create(t);
		const args = name === "write" ? { path: "sub/../other.txt", content: "bad" }
			: { path: "other.txt", edits: [{ oldText: "other", newText: "bad" }] };
		s.host.setResult(() => toolsResponse(call(name, args)));
		const result = await s.run();
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /只能修改/);
		assert.deepEqual(s.calls, []);
		assert.equal(readFileSync(join(s.cwd, "other.txt"), "utf8"), "other file\n");
		assert.equal(s.host.requests.length, 1, "a rejected write is handed back, not retried by the worker");
	}
});

test("directory links cannot redirect a write to another file", async (t) => {
	const s = create(t);
	mkdirSync(join(s.cwd, "outside"));
	writeFileSync(join(s.cwd, "outside", "target.txt"), "do not touch");
	symlinkSync(join(s.cwd, "outside"), join(s.cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
	s.host.setResult(() => toolsResponse(call("write", { path: "alias/target.txt", content: "bad" })));
	const result = await s.run();
	assert.equal(result.isError, true);
	assert.deepEqual(s.calls, []);
	assert.equal(readFileSync(join(s.cwd, "outside", "target.txt"), "utf8"), "do not touch");
});

test("a dangling directory link is not mistaken for a new ordinary target path", async (t) => {
	const s = create(t);
	symlinkSync(join(s.cwd, "missing"), join(s.cwd, "dangling"), process.platform === "win32" ? "junction" : "dir");
	const result = await s.run({ path: "dangling/new.txt", task: "创建文件" });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /悬空链接/);
	assert.equal(result.details.started, false);
	assert.deepEqual(s.host.requests, []);
});

test("flash can create its one target file with missing parent directories", async (t) => {
	const s = create(t);
	let round = 0;
	s.host.setResult(() => round++ === 0 ? toolsResponse(call("write", { path: "new/nested.txt", content: "new file" })) : titleResponse("已创建。"));
	const result = await s.run({ path: "new/nested.txt", task: "创建指定文件" });
	assert.equal(result.isError, undefined);
	assert.equal(readFileSync(join(s.cwd, "new", "nested.txt"), "utf8"), "new file");
});

test("shells, codemode, MCP, recursive workers and disabled file tools never reach executeTool", async (t) => {
	for (const name of ["powershell", "bash", "codemode", "mcp__server__write", "flash", "edit"]) {
		const s = create(t);
		// Even a registered, callable dangerous tool is not passed to the child.
		s.ctx.tools.push({ name: "powershell", parameters: s.ctx.tools[0].parameters });
		if (name === "edit") s.ctx.tools = s.ctx.tools.filter((tool) => tool.name !== "edit");
		s.host.setResult(() => toolsResponse(call(name, { path: "target.txt", command: "bad" })));
		const result = await s.run();
		assert.equal(result.isError, true);
		assert.deepEqual(s.calls, []);
	}
});

test("plan mode, empty tasks and missing models do not start a child request", async (t) => {
	const s = create(t);
	s.mode = "plan";
	await assert.rejects(s.run(), /执行模式/);
	s.mode = "execute";
	const empty = await s.run({ path: "target.txt", task: "  " });
	assert.equal(empty.isError, true);
	assert.equal(empty.details.started, false);
	s.host.setAvailable(false);
	const missing = await s.run();
	assert.equal(missing.isError, true);
	assert.equal(missing.details.started, false);
	assert.match(missing.content[0].text, /未找到模型/);
	assert.deepEqual(s.host.requests, []);
});

test("nested permission denial is preserved and stops the worker", async (t) => {
	const s = create(t);
	s.ctx.executeTool = async () => ({ isError: true, content: [{ type: "text", text: "Permission denied by another extension" }], details: undefined });
	s.host.setResult(() => toolsResponse(call("write", { path: "target.txt", content: "bad" })));
	const result = await s.run();
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Permission denied/);
	assert.match(result.content[0].text, /已尝试写入.*不会自动回滚/);
	assert.equal(readFileSync(join(s.cwd, "target.txt"), "utf8"), "old label\n");
});

test("tool errors without meaningful text stop the worker and use a fallback message", async (t) => {
	for (const content of [[], [{ type: "text", text: "" }], [{ type: "text", text: " \n\t" }], [{ type: "image", data: "AA==", mimeType: "image/png" }]]) {
		const s = create(t);
		s.ctx.executeTool = async () => ({ isError: true, content, details: undefined });
		let round = 0;
		s.host.setResult(() => round++ === 0 ? toolsResponse(call("read", { path: "target.txt" })) : titleResponse("不应继续执行。"));
		const result = await s.run();
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /工具执行失败.*未提供错误文本/);
		assert.equal(s.host.requests.length, 1, "a tool error stops the worker regardless of its content");
	}
});

test("authentication errors and truncated/empty responses are failures, not silent model fallback", async (t) => {
	for (const answer of [titleResponse("", "stop"), titleResponse("incomplete", "length"), { ...titleResponse("", "error"), errorMessage: "Authentication failed" }]) {
		const s = create(t);
		s.host.setResult(() => answer);
		const result = await s.run();
		assert.equal(result.isError, true);
		assert.equal(result.details.started, true);
		assert.equal(s.host.requests.length, 1);
		assert.equal(result.usage.output, 5);
	}
});

test("an error after a write reports partial work without rollback", async (t) => {
	const s = create(t);
	let round = 0;
	s.host.setResult(() => round++ === 0 ? toolsResponse(call("write", { path: "target.txt", content: "partial work" }))
		: { ...titleResponse("", "error"), errorMessage: "Provider failed" });
	const result = await s.run();
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /已尝试写入.*不会自动回滚/);
	assert.equal(readFileSync(join(s.cwd, "target.txt"), "utf8"), "partial work");
	assert.equal(result.usage.output, 10);
});

test("pre-cancelled and in-flight cancelled requests cannot perform late edits", async (t) => {
	const s = create(t);
	const before = new AbortController();
	before.abort();
	const early = await s.run(undefined, before.signal);
	assert.equal(early.isError, true);
	assert.deepEqual(s.host.requests, []);
	const deferred = Promise.withResolvers();
	s.host.setResult(() => deferred.promise);
	const controller = new AbortController();
	const pending = s.run(undefined, controller.signal);
	await flush();
	controller.abort();
	const result = await pending;
	assert.equal(result.isError, true);
	assert.equal(s.host.requests[0].signal.aborted, true);
	assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
	deferred.resolve(toolsResponse(call("write", { path: "target.txt", content: "late" })));
	await flush();
	assert.deepEqual(s.calls, []);
	assert.equal(readFileSync(join(s.cwd, "target.txt"), "utf8"), "old label\n");
});

test("cancellation waits for an in-flight file operation before releasing the worker", async (t) => {
	const s = create(t);
	const entered = Promise.withResolvers();
	const deferred = Promise.withResolvers();
	s.ctx.executeTool = async () => { entered.resolve(); return deferred.promise; };
	s.host.setResult(() => toolsResponse(call("write", { path: "target.txt", content: "partial" })));
	const controller = new AbortController();
	let settled = false;
	const pending = s.run(undefined, controller.signal).then((value) => { settled = true; return value; });
	await entered.promise;
	controller.abort();
	await flush();
	assert.equal(settled, false);
	await assert.rejects(s.run(), /正在运行/);
	deferred.resolve({ content: [{ type: "text", text: "operation settled" }], details: undefined });
	const result = await pending;
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /已尝试写入/);
});

test("session lifecycle events cancel workers without waiting for a late provider", async (t) => {
	for (const event of ["session_shutdown", "session_tree", "session_start"]) {
		const s = create(t);
		const deferred = Promise.withResolvers();
		s.host.setResult(() => deferred.promise);
		const pending = s.run();
		await flush();
		s.emit(event);
		const result = await pending;
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /取消/);
		deferred.resolve(titleResponse("late"));
		await flush();
	}
});

test("flash has bounded request rounds, tool calls and timeout", async (t) => {
	const rounds = create(t);
	rounds.host.setResult(() => toolsResponse(call("read", { path: "target.txt" })));
	assert.equal((await rounds.run()).isError, true);
	assert.equal(rounds.host.requests.length, 8);
	const calls = create(t);
	calls.host.setResult(() => toolsResponse(...Array.from({ length: 25 }, () => call("read", { path: "target.txt" }))));
	assert.equal((await calls.run()).isError, true);
	assert.equal(calls.calls.length, 24);
	const timed = create(t);
	const deferred = Promise.withResolvers();
	timed.host.setResult(() => deferred.promise);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const pending = timed.run();
	await flush();
	t.mock.timers.tick(120_000);
	const result = await pending;
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /超时/);
	deferred.resolve(titleResponse("late"));
	await flush();
});
