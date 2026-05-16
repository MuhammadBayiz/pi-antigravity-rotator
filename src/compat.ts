import type { IncomingMessage, ServerResponse } from "node:http";
import { PayloadTooLargeError, readLimitedBody } from "./body-limit.js";
import { logger } from "./logger.js";
import type { AccountRotator } from "./rotator.js";
import { resolveQuotaModelKey } from "./types.js";
import { withRotation, flattenHeaders, type RequestBody } from "./proxy.js";
import { ANTIGRAVITY_IDENTITY_PROMPT } from "./antigravity-prompt.js";

const compatLogger = logger.child("compat");

export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | Array<{ type: string; text?: string;[key: string]: unknown }> | null;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	name?: string;
}

export interface OpenAITool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export interface OpenAIToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface OpenAIToolChoice {
	type: "function";
	function: { name: string };
}

// Gemini function calling types
interface GeminiFunctionDeclaration {
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
}

interface GeminiToolConfig {
	functionCallingConfig: {
		mode: "AUTO" | "NONE" | "ANY";
		allowedFunctionNames?: string[];
	};
}

export interface OpenAIChatCompletionRequest {
	model: string;
	messages: ChatMessage[];
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
	tools?: OpenAITool[];
	tool_choice?: unknown;
	[key: string]: unknown;
}

export interface AnthropicMessagesRequest {
	model: string;
	messages: ChatMessage[];
	system?: string | Array<{ type: string; text?: string;[key: string]: unknown }>;
	stream?: boolean;
	max_tokens?: number;
	temperature?: number;
	[key: string]: unknown;
}

export interface CompatCompletion {
	text: string;
	inputTokens: number;
	outputTokens: number;
	responseId?: string;
	toolCalls?: OpenAIToolCall[];
}

type AntigravityPart = { text: string } | { inlineData: { mimeType: string; data: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function extractText(content: ChatMessage["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p) => (p.type === "text" && typeof p.text === "string") || (p.type === "thinking" && typeof p.thinking === "string"))
		.map((p) => p.type === "thinking" ? `[Thinking]\n${p.thinking}\n[/Thinking]` : p.text)
		.join("\n");
}

function dataUrlToInlineData(url: string): AntigravityPart | null {
	const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
	if (!match) return null;
	return { inlineData: { mimeType: match[1], data: match[2] } };
}

function extractParts(content: ChatMessage["content"]): AntigravityPart[] {
	if (content === null) return [];
	if (typeof content === "string") return content ? [{ text: content }] : [];
	if (!Array.isArray(content)) return [];
	const parts: AntigravityPart[] = [];
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string" && part.text) {
			parts.push({ text: part.text });
			continue;
		}
		if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking) {
			parts.push({ text: `[Thinking]\n${part.thinking}\n[/Thinking]` });
			continue;
		}
		if (part.type === "image_url" && isRecord(part.image_url) && typeof part.image_url.url === "string") {
			const inline = dataUrlToInlineData(part.image_url.url);
			if (inline) parts.push(inline);
			continue;
		}
		if (part.type === "image" && isRecord(part.source) && part.source.type === "base64" && typeof part.source.media_type === "string" && typeof part.source.data === "string") {
			parts.push({ inlineData: { mimeType: part.source.media_type, data: part.source.data } });
		}
	}
	return parts;
}

/** Convert OpenAI tools array to Gemini functionDeclarations */
function convertOpenAIToolsToGemini(tools: OpenAITool[]): { functionDeclarations: GeminiFunctionDeclaration[] }[] {
	const decls: GeminiFunctionDeclaration[] = tools
		.filter((t) => t.type === "function" && isNonEmptyString(t.function?.name))
		.map((t) => ({
			name: t.function.name,
			...(t.function.description ? { description: t.function.description } : {}),
			...(t.function.parameters ? { parameters: t.function.parameters } : {}),
		}));
	return decls.length > 0 ? [{ functionDeclarations: decls }] : [];
}

/** Convert OpenAI tool_choice to Gemini toolConfig */
function convertToolChoiceToGemini(toolChoice: unknown): GeminiToolConfig | undefined {
	if (!toolChoice || toolChoice === "none") return { functionCallingConfig: { mode: "NONE" } };
	if (toolChoice === "auto" || toolChoice === "required") return { functionCallingConfig: { mode: "AUTO" } };
	if (isRecord(toolChoice) && toolChoice.type === "function" && isRecord(toolChoice.function) && isNonEmptyString(toolChoice.function.name)) {
		return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolChoice.function.name] } };
	}
	return { functionCallingConfig: { mode: "AUTO" } };
}

function validateMessages(value: unknown): value is ChatMessage[] {
	return Array.isArray(value) && value.every((msg) => {
		if (!isRecord(msg)) return false;
		if (!["system", "user", "assistant", "tool"].includes(String(msg.role))) return false;
		return typeof msg.content === "string" || msg.content === null || Array.isArray(msg.content);
	});
}

export function validateOpenAIChatCompletionRequest(value: unknown): { ok: true; value: OpenAIChatCompletionRequest } | { ok: false; errors: string[] } {
	if (!isRecord(value)) return { ok: false, errors: ["body must be a JSON object"] };
	const errors: string[] = [];
	if (!isNonEmptyString(value.model)) errors.push("body.model must be a non-empty string");
	if (!validateMessages(value.messages)) errors.push("body.messages must be an array of chat messages");
	if (value.stream !== undefined && typeof value.stream !== "boolean") errors.push("body.stream must be boolean when provided");
	if (value.temperature !== undefined && typeof value.temperature !== "number") errors.push("body.temperature must be number when provided");
	if (value.max_tokens !== undefined && typeof value.max_tokens !== "number") errors.push("body.max_tokens must be number when provided");
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as unknown as OpenAIChatCompletionRequest };
}

export function validateAnthropicMessagesRequest(value: unknown): { ok: true; value: AnthropicMessagesRequest } | { ok: false; errors: string[] } {
	if (!isRecord(value)) return { ok: false, errors: ["body must be a JSON object"] };
	const errors: string[] = [];
	if (!isNonEmptyString(value.model)) errors.push("body.model must be a non-empty string");
	if (!validateMessages(value.messages)) errors.push("body.messages must be an array of chat messages");
	if (value.system !== undefined && typeof value.system !== "string" && !Array.isArray(value.system)) errors.push("body.system must be string or content array when provided");
	if (value.stream !== undefined && typeof value.stream !== "boolean") errors.push("body.stream must be boolean when provided");
	if (value.temperature !== undefined && typeof value.temperature !== "number") errors.push("body.temperature must be number when provided");
	if (value.max_tokens !== undefined && typeof value.max_tokens !== "number") errors.push("body.max_tokens must be number when provided");
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as unknown as AnthropicMessagesRequest };
}

type GeminiContent = { role: "user" | "model"; parts: unknown[] };

export function openAIToAntigravityBody(input: OpenAIChatCompletionRequest): RequestBody {
	// Separate system messages from conversation turns
	const systemParts: string[] = [];
	const conversationMessages = input.messages.filter((msg) => {
		if (msg.role === "system") {
			const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
			if (text) systemParts.push(text);
			return false;
		}
		return true;
	});

	// Build multi-turn contents array
	const contents: GeminiContent[] = [];
	for (const msg of conversationMessages) {
		if (msg.role === "assistant") {
			const parts: unknown[] = [];
			// Text content
			if (msg.content) {
				const textContent = typeof msg.content === "string" ? msg.content : extractText(msg.content);
				if (textContent) parts.push({ text: textContent });
			}
			// tool_calls → functionCall parts
			if (Array.isArray(msg.tool_calls)) {
				for (const tc of msg.tool_calls) {
					try {
						const args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
						parts.push({ functionCall: { name: tc.function.name, args } });
					} catch {
						parts.push({ functionCall: { name: tc.function.name, args: {} } });
					}
				}
			}
			if (parts.length > 0) contents.push({ role: "model", parts });
		} else if (msg.role === "tool") {
			// tool result → functionResponse part
			const responseText = typeof msg.content === "string" ? msg.content : extractText(msg.content);
			let responseData: unknown;
			try { responseData = JSON.parse(responseText); } catch { responseData = { output: responseText }; }
			const fnName = msg.name || "unknown";
			contents.push({ role: "user", parts: [{ functionResponse: { name: fnName, response: responseData } }] });
		} else {
			// user message
			const msgParts = extractParts(msg.content);
			if (msgParts.length > 0) contents.push({ role: "user", parts: msgParts });
		}
	}

	if (contents.length === 0) contents.push({ role: "user", parts: [{ text: "Hello" }] });

	// Build tools / toolConfig if present
	const inputTools = Array.isArray(input.tools) ? (input.tools as OpenAITool[]) : [];
	const geminiTools = convertOpenAIToolsToGemini(inputTools);
	const geminiToolConfig = input.tool_choice !== undefined ? convertToolChoiceToGemini(input.tool_choice) : undefined;

	const request: Record<string, unknown> = {
		contents,
		generationConfig: {
			...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
			...(typeof input.max_tokens === "number" ? { maxOutputTokens: input.max_tokens } : {}),
		},
	};

	const systemText = systemParts.length > 0
		? `${ANTIGRAVITY_IDENTITY_PROMPT}\n\n${systemParts.join("\n\n")}`
		: ANTIGRAVITY_IDENTITY_PROMPT;

	request.systemInstruction = {
		role: "user",
		parts: [{ text: systemText }]
	};

	if (geminiTools.length > 0) request.tools = geminiTools;
	if (geminiToolConfig) request.toolConfig = geminiToolConfig;

	return {
		project: "compat-placeholder",
		model: input.model,
		userAgent: "antigravity",
		requestType: "agent",
		request,
	};
}

export function anthropicToAntigravityBody(input: AnthropicMessagesRequest): RequestBody {
	const systemText = typeof input.system === "string" ? input.system : Array.isArray(input.system) ? extractText(input.system as ChatMessage["content"]) : "";
	return openAIToAntigravityBody({
		model: input.model,
		stream: input.stream,
		temperature: input.temperature,
		max_tokens: input.max_tokens,
		messages: [
			...(systemText ? [{ role: "system" as const, content: systemText }] : []),
			...input.messages,
		],
	});
}

export function parseAntigravitySse(raw: string): CompatCompletion {
	let text = "";
	let inputTokens = 0;
	let outputTokens = 0;
	let responseId: string | undefined;
	const toolCallsMap = new Map<string, OpenAIToolCall>();
	let toolCallIndex = 0;

	for (const line of raw.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		try {
			const parsed = JSON.parse(payload) as Record<string, unknown>;
			const response = isRecord(parsed.response) ? parsed.response : parsed;
			if (!responseId && typeof response.responseId === "string") responseId = response.responseId;
			const candidates = Array.isArray(response.candidates) ? response.candidates : [];
			for (const candidate of candidates) {
				if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
				for (const part of candidate.content.parts) {
					if (!isRecord(part)) continue;
					if (typeof part.text === "string") {
						text += part.text;
					} else if (isRecord(part.functionCall)) {
						// Gemini functionCall → OpenAI tool_call
						const fc = part.functionCall;
						const name = typeof fc.name === "string" ? fc.name : "unknown";
						const args = fc.args !== undefined ? JSON.stringify(fc.args) : "{}";
						const callId = `call_${Date.now().toString(36)}_${toolCallIndex++}`;
						toolCallsMap.set(name + callId, { id: callId, type: "function", function: { name, arguments: args } });
					}
				}
			}
			const usage = isRecord(response.usageMetadata) ? response.usageMetadata : isRecord(response.usage) ? response.usage : null;
			if (usage) {
				if (typeof usage.promptTokenCount === "number") inputTokens = usage.promptTokenCount;
				if (typeof usage.candidatesTokenCount === "number") outputTokens = usage.candidatesTokenCount;
				if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
				if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
			}
		} catch {
			// Ignore malformed SSE lines from upstream; other chunks may still be valid.
		}
	}

	const toolCalls = toolCallsMap.size > 0 ? [...toolCallsMap.values()] : undefined;
	return { text, inputTokens, outputTokens, responseId, toolCalls };
}

function writeJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "Content-Type": "application/json", ...headers });
	res.end(JSON.stringify(payload));
}

function summarizeCompatRequest(body: RequestBody): string {
	const request = isRecord(body.request) ? body.request : {};
	const contents = Array.isArray(request.contents) ? request.contents : [];
	const tools = Array.isArray(request.tools) ? request.tools.length : 0;
	const systemInstruction = isRecord(request.systemInstruction) ? "yes" : "no";
	return `model=${body.model} userAgent=${body.userAgent || "none"} turns=${contents.length} tools=${tools} systemInstruction=${systemInstruction}`;
}

function writeOpenAIStream(res: ServerResponse, model: string, completion: CompatCompletion): void {
	const created = Math.floor(Date.now() / 1000);
	const id = `chatcmpl-${Date.now().toString(36)}`;
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
	res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
	if (completion.toolCalls && completion.toolCalls.length > 0) {
		// Emit tool_call deltas
		for (let i = 0; i < completion.toolCalls.length; i++) {
			const tc = completion.toolCalls[i];
			res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] })}\n\n`);
		}
		res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
	} else {
		if (completion.text) {
			res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: completion.text }, finish_reason: null }] })}\n\n`);
		}
		res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
	}
	res.write("data: [DONE]\n\n");
	res.end();
}

function writeAnthropicStream(res: ServerResponse, model: string, completion: CompatCompletion): void {
	const id = `msg_${Date.now().toString(36)}`;
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
	res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: completion.inputTokens, output_tokens: 0 } } })}\n\n`);
	res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
	if (completion.text) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: completion.text } })}\n\n`);
	res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
	res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: completion.outputTokens } })}\n\n`);
	res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
	res.end();
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	try {
		const body = await readLimitedBody(req);
		return JSON.parse(body.toString("utf-8"));
	} catch (err) {
		if (err instanceof PayloadTooLargeError) throw err;
		throw new Error("Invalid JSON body");
	}
}
async function completeViaRotator(
	req: IncomingMessage,
	rotator: AccountRotator,
	body: RequestBody,
): Promise<{ completion: CompatCompletion; status: number; errorText?: string }> {
	const outcome = await withRotation(rotator, body.model, flattenHeaders(req.headers), body,
		async (response) => {
			const raw = await response.text();
			const completion = parseAntigravitySse(raw);
			if (completion.inputTokens > 0 || completion.outputTokens > 0) {
				rotator.recordTokenUsage(body.model, completion.inputTokens, completion.outputTokens);
			}
			return completion;
		},
	);
	if (!outcome.ok) {
		if (outcome.status === 404) {
			compatLogger.warn(
				`Compat upstream 404 endpoint=${outcome.endpoint || "unknown"} ${summarizeCompatRequest(body)} error=${(outcome.errorText || "").slice(0, 300)}`,
			);
		}
		return {
			completion: { text: "", inputTokens: 0, outputTokens: 0 },
			status: outcome.status,
			errorText: outcome.retryAfterMs ? `${outcome.errorText}; retryAfterMs=${outcome.retryAfterMs}` : outcome.errorText,
		};
	}
	return { completion: outcome.result, status: 200 };
}


export function serveOpenAIModels(res: ServerResponse): void {
	writeJson(res, 200, {
		object: "list",
		data: ["gemini-3-flash", "gemini-3.1-pro-low", "gemini-3.1-pro-high", "claude-sonnet-4-6", "claude-opus-4-6-thinking"].map((id) => ({
			id,
			object: "model",
			created: 0,
			owned_by: "pi-antigravity-rotator",
		})),
	});
}

export async function handleOpenAIChatCompletions(req: IncomingMessage, res: ServerResponse, rotator: AccountRotator): Promise<void> {
	let parsed: unknown;
	try {
		parsed = await readJsonBody(req);
	} catch (err) {
		if (err instanceof PayloadTooLargeError) return writeJson(res, 413, { error: { message: "Payload too large", type: "invalid_request_error" } });
		return writeJson(res, 400, { error: { message: "Invalid JSON body", type: "invalid_request_error" } });
	}
	const validation = validateOpenAIChatCompletionRequest(parsed);
	if (!validation.ok) return writeJson(res, 400, { error: { message: validation.errors.join("; "), type: "invalid_request_error" } });

	const started = Date.now();
	const result = await completeViaRotator(req, rotator, openAIToAntigravityBody(validation.value));
	if (result.status !== 200) {
		compatLogger.warn(`OpenAI compat upstream failed status=${result.status} model=${validation.value.model}`);
		return writeJson(res, result.status, { error: { message: result.errorText || "Upstream error", type: "upstream_error" } });
	}
	if (validation.value.stream) {
		writeOpenAIStream(res, validation.value.model, result.completion);
		return;
	}
	const hasToolCalls = result.completion.toolCalls && result.completion.toolCalls.length > 0;
	writeJson(res, 200, {
		id: `chatcmpl-${started.toString(36)}`,
		object: "chat.completion",
		created: Math.floor(started / 1000),
		model: validation.value.model,
		choices: [{
			index: 0,
			message: hasToolCalls
				? { role: "assistant", content: null, tool_calls: result.completion.toolCalls }
				: { role: "assistant", content: result.completion.text },
			finish_reason: hasToolCalls ? "tool_calls" : "stop",
		}],
		usage: {
			prompt_tokens: result.completion.inputTokens,
			completion_tokens: result.completion.outputTokens,
			total_tokens: result.completion.inputTokens + result.completion.outputTokens,
		},
	});
}

export async function handleAnthropicMessages(req: IncomingMessage, res: ServerResponse, rotator: AccountRotator): Promise<void> {
	let parsed: unknown;
	try {
		parsed = await readJsonBody(req);
	} catch (err) {
		if (err instanceof PayloadTooLargeError) return writeJson(res, 413, { type: "error", error: { type: "invalid_request_error", message: "Payload too large" } });
		return writeJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } });
	}
	const validation = validateAnthropicMessagesRequest(parsed);
	if (!validation.ok) return writeJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: validation.errors.join("; ") } });

	const started = Date.now();
	const result = await completeViaRotator(req, rotator, anthropicToAntigravityBody(validation.value));
	if (result.status !== 200) {
		compatLogger.warn(`Anthropic compat upstream failed status=${result.status} model=${validation.value.model}`);
		return writeJson(res, result.status, { type: "error", error: { type: "upstream_error", message: result.errorText || "Upstream error" } });
	}
	if (validation.value.stream) {
		writeAnthropicStream(res, validation.value.model, result.completion);
		return;
	}
	writeJson(res, 200, {
		id: `msg_${started.toString(36)}`,
		type: "message",
		role: "assistant",
		model: validation.value.model,
		content: [{ type: "text", text: result.completion.text }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: {
			input_tokens: result.completion.inputTokens,
			output_tokens: result.completion.outputTokens,
		},
	});
}
