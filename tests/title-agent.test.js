import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { generateSessionTitle } from "../extensions/lib/title-agent.js";
import { createTitleAgentHost, titleResponse } from "./helpers/title-agent-host.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("an already cancelled title job does not look up a model or start a child", async () => {
	const host = createTitleAgentHost();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(generateSessionTitle("对话正文", host, controller.signal), { name: "AbortError" });
	assert.deepEqual(host.lookups, []);
	assert.deepEqual(host.requests, []);
	assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});

test("cancelling during Agent preparation prevents even the first provider request", async () => {
	const host = createTitleAgentHost();
	const controller = new AbortController();
	const pending = generateSessionTitle("对话正文", host, controller.signal);
	controller.abort();
	await assert.rejects(pending, /取消或超时/);
	await flush();
	assert.deepEqual(host.requests, []);
	assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});

test("success uses only assistant text and removes the cancellation listener", async () => {
	const answer = titleResponse("修复登录状态");
	answer.content.unshift({ type: "thinking", thinking: "PRIVATE_THINKING" });
	const host = createTitleAgentHost({ result: () => answer });
	const controller = new AbortController();
	assert.equal(await generateSessionTitle("对话正文", host, controller.signal), "修复登录状态");
	assert.equal(host.requests.length, 1);
	assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});

test("provider failures and reasoning-only responses do not turn into titles", async () => {
	const thinkingOnly = titleResponse();
	thinkingOnly.content = [{ type: "thinking", thinking: "PRIVATE_THINKING" }];
	const failure = titleResponse("失败的正文", "error");
	failure.errorMessage = "DeepSeek authentication failed";
	for (const [answer, error] of [[thinkingOnly, /未返回有效文本/], [failure, /DeepSeek authentication failed/], [titleResponse("取消的正文", "aborted"), /aborted/]]) {
		const host = createTitleAgentHost({ result: () => answer });
		const controller = new AbortController();
		await assert.rejects(generateSessionTitle("对话正文", host, controller.signal), error);
		assert.equal(host.requests.length, 1);
		assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
	}
});

test("unexpected tool calls cannot execute tools or trigger additional model turns", async () => {
	for (const stopReason of ["toolUse", "stop", "length"]) {
		const answer = titleResponse("不应采用的标题", stopReason);
		answer.content.push({ type: "toolCall", id: "unexpected", name: "powershell", arguments: { command: "throw 'must never execute'" } });
		const host = createTitleAgentHost({ result: () => answer });
		const controller = new AbortController();
		await assert.rejects(generateSessionTitle("对话正文", host, controller.signal), /toolUse|不允许的工具调用/);
		assert.equal(host.requests.length, 1, "no retry or tool follow-up turn");
		assert.deepEqual(host.requests[0].context.tools ?? [], []);
		assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
	}
});

test("cancelling an in-flight request settles promptly and ignores a late rejected provider response", async () => {
	const deferred = Promise.withResolvers();
	const host = createTitleAgentHost({ result: () => deferred.promise });
	const controller = new AbortController();
	const pending = generateSessionTitle("对话正文", host, controller.signal);
	await flush();
	controller.abort();
	await assert.rejects(pending, /取消或超时/);
	assert.equal(host.requests[0].signal.aborted, true);
	assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
	deferred.reject(new Error("late provider failure"));
	await flush();
	assert.equal(host.requests.length, 1);
});
