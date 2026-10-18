import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_TITLE_MAX, buildTitleContext, normalizeSessionTitle, registerAutoTitle } from "../extensions/lib/auto-title.js";
import { TITLE_AGENT_NAME, TITLE_AGENT_MODEL, TITLE_AGENT_THINKING, TITLE_TIMEOUT_MS } from "../extensions/lib/title-agent.js";
import { createTitleAgentHost, titleResponse } from "./helpers/title-agent-host.js";

function entry(role, content, stopReason = "stop") {
	return { type: "message", message: { role, content, ...(role === "assistant" ? { stopReason } : {}) } };
}
const dialogue = () => [
	entry("user", "登录后跳转到首页会丢失状态，请帮我修复。"),
	entry("assistant", [{ type: "text", text: "已修复登录后的会话状态持久化。" }]),
];
const response = (text = "修复登录状态持久化", stopReason = "stop") => titleResponse(text, stopReason);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function mock({ mode = "tui", name = "", result = () => response(), available = true } = {}) {
	const handlers = new Map();
	const host = createTitleAgentHost({ result, available });
	const names = [];
	const updates = [];
	const warnings = [];
	let sessionId = "first-session";
	let branch = dialogue();
	const ctx = {
		mode,
		cwd: process.cwd(),
		model: { id: "current-model", provider: "configured-provider" },
		modelRegistry: host.modelRegistry,
		ui: { notify: (message, level) => warnings.push({ message, level }) },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
	};
	const emit = (event, data = {}) => {
		for (const handler of handlers.get(event) ?? []) handler(data, ctx);
	};
	// 故意不提供 pi.events：命名不应依赖外部扩展的事件协议。
	const pi = {
		on: (event, handler) => { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(handler); },
		getSessionName: () => name,
		setSessionName(title) { name = title; names.push(title); emit("session_info_changed", { name: title }); },
	};
	registerAutoTitle(pi, { onUpdate: (context) => updates.push(context) });
	emit("session_start");
	return {
		ctx, emit, names, updates, warnings, ...host,
		get name() { return name; },
		setName(title, notify = true) { name = title; if (notify) emit("session_info_changed", { name: title }); },
		setSessionId(id) { sessionId = id; },
		setBranch(entries) { branch = entries; },
		input(text = "请修复登录后的状态丢失", source = "interactive") { return emit("input", { text, source }); },
	};
}

test("model title cleanup removes formatting and terminal controls and bounds Unicode length", () => {
	assert.equal(normalizeSessionTitle("\n  # 标题：“修复登录状态持久化”\n不要显示解释"), "修复登录状态持久化");
	assert.equal(normalizeSessionTitle("\x1b[31mTitle: \"Fix login state\"\x1b[0m\x07"), "Fix login state");
	assert.equal(normalizeSessionTitle("优化   工具\t分组"), "优化 工具 分组");
	for (const text of [undefined, "   ", "/name title", '\"\"']) assert.equal(normalizeSessionTitle(text), "");
	const title = normalizeSessionTitle("😀".repeat(50));
	assert.equal([...title].length, AUTO_TITLE_MAX);
	assert.ok(title.endsWith("…"));
});

test("title context contains only user and successful assistant text, not tools, images or thinking", () => {
	const context = buildTitleContext([
		{ type: "custom", data: "CUSTOM_SECRET" },
		entry("user", "/compact"),
		entry("user", [{ type: "text", text: "请修复登录" }, { type: "image", data: "IMAGE_SECRET" }]),
		entry("toolResult", "TOOL_SECRET"),
		entry("assistant", [{ type: "text", text: "ERROR_SECRET" }], "error"),
		entry("assistant", [{ type: "thinking", thinking: "THINKING_SECRET" }, { type: "text", text: "已修复登录状态" }]),
	]);
	assert.equal(context, "user: 请修复登录\n\nassistant: 已修复登录状态");
	assert.doesNotMatch(context, /SECRET|compact/);
	assert.equal(buildTitleContext([]), "");
	assert.equal(buildTitleContext([entry("user", "只有输入")]), "");
	assert.equal(buildTitleContext([entry("assistant", [{ type: "text", text: "没有用户输入" }])]), "");
	assert.equal(buildTitleContext([...dialogue(), entry("assistant", [], "error")]), "");
});

test("long context retains the initial task and recent dialogue with a bounded request size", () => {
	const entries = [entry("user", "最初的登录任务")];
	for (let i = 0; i < 10; i++) {
		entries.push(entry("user", `第${i}次输入${"长".repeat(10_000)}`));
		entries.push(entry("assistant", [{ type: "text", text: `第${i}次回复${"文".repeat(10_000)}` }]));
	}
	const context = buildTitleContext(entries);
	assert.ok(context.length <= 12_000);
	assert.match(context, /最初的登录任务/);
	assert.match(context, /第9次输入/);
	assert.match(context, /第9次回复/);
	assert.doesNotMatch(context, /第0次/);
});

test("AI naming runs an independent DeepSeek Flash high agent after final settlement", async () => {
	const session = mock();
	assert.equal(session.input(), undefined, "input is not transformed or replaced");
	assert.equal(session.name, "");
	assert.deepEqual(session.lookups, []);
	session.emit("agent_end");
	assert.deepEqual(session.lookups, [], "retries and continuations must settle first");
	assert.equal(session.emit("agent_settled"), undefined);
	await flush();
	assert.deepEqual(session.names, ["修复登录状态持久化"]);
	assert.notEqual(session.name, "请修复登录后的状态丢失");
	assert.deepEqual(session.updates, [session.ctx]);
	const request = session.requests[0];
	assert.deepEqual(session.lookups, [{ provider: "deepseek", modelId: "deepseek-flash" }]);
	assert.equal(`${request.model.provider}/${request.model.id}`, TITLE_AGENT_MODEL);
	assert.equal(request.options.reasoning, TITLE_AGENT_THINKING);
	assert.equal(request.options.reasoning, "high");
	assert.equal(request.options.maxTokens, 2048);
	assert.equal(TITLE_AGENT_NAME, "titler");
	assert.match(request.options.sessionId, /^titler:/);
	assert.notEqual(request.options.sessionId, session.ctx.sessionManager.getSessionId());
	assert.deepEqual(request.context.messages.map((message) => message.role), ["system", "user"]);
	assert.match(request.context.messages[0].content, /不要直接照抄/);
	assert.deepEqual(request.context.messages[0].toolsAdded ?? [], []);
	assert.deepEqual(request.context.tools ?? [], []);
	const task = request.context.messages[1].content[0].text;
	assert.match(task, /登录后跳转到首页/);
	assert.match(task, /已修复登录后的会话状态持久化/);
	assert.deepEqual(session.warnings, []);
	session.input("后续对话");
	session.emit("agent_settled");
	await flush();
	assert.equal(session.requests.length, 1, "a named session is never renamed automatically");
});

test("background generation neither blocks settlement nor starts duplicate requests", async () => {
	const deferred = Promise.withResolvers();
	const session = mock({ result: () => deferred.promise });
	session.input();
	assert.equal(session.emit("agent_settled"), undefined);
	await flush();
	assert.equal(session.requests.length, 1);
	assert.equal(session.name, "");
	session.input("新的输入");
	session.emit("agent_settled");
	await flush();
	assert.equal(session.requests.length, 1);
	deferred.resolve(response());
	await flush();
	assert.deepEqual(session.names, ["修复登录状态持久化"]);
});

test("existing and manually assigned titles are never overwritten, including in-flight changes", async () => {
	const named = mock({ name: "我的手动标题" });
	named.input();
	named.emit("agent_settled");
	assert.deepEqual(named.lookups, []);
	for (const notify of [false, true]) {
		const deferred = Promise.withResolvers();
		const session = mock({ result: () => deferred.promise });
		session.input();
		session.emit("agent_settled");
		await flush();
		session.setName("手动改名优先", notify);
		if (notify) assert.equal(session.requests[0].signal.aborted, true);
		deferred.resolve(response());
		await flush();
		assert.equal(session.name, "手动改名优先");
		assert.deepEqual(session.names, []);
		assert.deepEqual(session.warnings, []);
	}
});

test("commands, blank input, non-interactive sources, aborted runs and non-TUI sessions do not request titles", async () => {
	for (const [text, source] of [["/compact", "interactive"], ["   ", "interactive"], ["来自 RPC", "rpc"], ["扩展输入", "extension"]]) {
		const session = mock();
		session.input(text, source);
		session.emit("agent_settled");
		assert.deepEqual(session.lookups, []);
	}
	for (const mode of ["rpc", "json", "print"]) {
		const session = mock({ mode });
		session.input();
		session.emit("agent_settled");
		assert.deepEqual(session.lookups, []);
	}
	const aborted = mock();
	aborted.input();
	aborted.emit("agent_settled", { aborted: true });
	assert.deepEqual(aborted.lookups, []);
	aborted.emit("agent_settled");
	assert.deepEqual(aborted.lookups, [], "idle settlement cannot reuse aborted input");
	const failed = mock();
	failed.setBranch([...dialogue(), entry("assistant", [{ type: "text", text: "请求失败" }], "error")]);
	failed.input();
	failed.emit("agent_settled");
	assert.deepEqual(failed.lookups, [], "a failed main response must not trigger naming from stale history");
	await flush();
});

test("failed or invalid title responses keep the session unnamed and retry with a fresh agent", async () => {
	for (const first of [() => Promise.reject(new Error("network/auth failure")), () => response("", "error"), () => response("cancelled", "aborted"), () => response("   "), () => response("/name bad")]) {
		let attempt = 0;
		const session = mock({ result: () => ++attempt === 1 ? first() : response() });
		session.input();
		session.emit("agent_settled");
		await flush();
		assert.equal(session.name, "", "no fallback to raw input");
		assert.deepEqual(session.updates, []);
		assert.equal(session.warnings.length, 1);
		assert.equal(session.warnings[0].level, "warning");
		session.input("继续修复");
		session.emit("agent_settled");
		await flush();
		assert.equal(session.requests.length, 2);
		assert.notEqual(session.requests[0].options.sessionId, session.requests[1].options.sessionId);
		assert.equal(session.requests[1].context.messages.length, 2, "no failed child history is inherited");
		assert.deepEqual(session.names, ["修复登录状态持久化"]);
	}
});

test("missing title model warns once per session and never falls back to the parent model", async () => {
	const session = mock({ available: false });
	for (let i = 0; i < 2; i++) {
		session.input();
		session.emit("agent_settled");
		await flush();
	}
	assert.deepEqual(session.requests, []);
	assert.equal(session.name, "");
	assert.equal(session.lookups.length, 2);
	assert.equal(session.warnings.length, 1);
	assert.match(session.warnings[0].message, /未找到标题模型 deepseek\/deepseek-flash/);
	session.setSessionId("second-session");
	session.emit("session_start");
	session.input();
	session.emit("agent_settled");
	await flush();
	assert.equal(session.warnings.length, 2, "new sessions can report their own failure");
	session.setAvailable(true);
	session.ctx.model = undefined;
	session.input();
	session.emit("agent_settled");
	await flush();
	assert.deepEqual(session.names, ["修复登录状态持久化"], "the title agent does not require a selected parent model");
});

test("shutdown, reload and tree navigation abort requests and discard late results", async () => {
	for (const event of ["session_shutdown", "session_start", "session_tree"]) {
		const deferred = Promise.withResolvers();
		const session = mock({ result: () => deferred.promise });
		session.input();
		session.emit("agent_settled");
		await flush();
		session.emit(event);
		assert.equal(session.requests[0].signal.aborted, true);
		deferred.resolve(response());
		await flush();
		assert.deepEqual(session.names, []);
		assert.deepEqual(session.updates, []);
		assert.deepEqual(session.warnings, [], "lifecycle cancellation is silent");
	}
});

test("session identity guards stale contexts even before lifecycle notifications arrive", async () => {
	const deferred = Promise.withResolvers();
	const session = mock({ result: () => deferred.promise });
	session.input();
	session.emit("agent_settled");
	await flush();
	session.setSessionId("second-session");
	deferred.resolve(response());
	await flush();
	assert.deepEqual(session.names, []);
	assert.deepEqual(session.warnings, []);
});

test("late completion of an old request cannot clear a replacement request", async () => {
	const old = Promise.withResolvers();
	const current = Promise.withResolvers();
	let attempt = 0;
	const session = mock({ result: () => ++attempt === 1 ? old.promise : current.promise });
	session.input();
	session.emit("agent_settled");
	await flush();
	session.emit("session_tree");
	session.input();
	session.emit("agent_settled");
	await flush();
	old.resolve(response("旧分支标题"));
	await flush();
	session.input();
	session.emit("agent_settled");
	await flush();
	assert.equal(session.requests.length, 2);
	current.resolve(response("新分支标题"));
	await flush();
	assert.deepEqual(session.names, ["新分支标题"]);
});

test("a timed-out title request releases the job even when the provider ignores cancellation", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const deferred = Promise.withResolvers();
	const session = mock({ result: () => deferred.promise });
	session.input();
	session.emit("agent_settled");
	await flush();
	t.mock.timers.tick(TITLE_TIMEOUT_MS);
	assert.equal(session.requests[0].signal.aborted, true);
	await flush();
	assert.equal(session.warnings.length, 1);
	assert.match(session.warnings[0].message, /取消或超时/);
	session.setResult(() => response("重试生成的标题"));
	session.input();
	session.emit("agent_settled");
	await flush();
	assert.equal(session.requests.length, 2);
	assert.deepEqual(session.names, ["重试生成的标题"]);
	deferred.resolve(response("迟到标题"));
	await flush();
	assert.deepEqual(session.names, ["重试生成的标题"]);
});
