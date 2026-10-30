import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AcpClient, type ImageBlock, type PermissionRequest, type PromptBlock } from './acpClient';
import { continuationOf, digest, KiroConversation, type SavedConversation } from './conversation';
import { McpBridge, type BridgeTool } from './mcpBridge';
import { effortRequested, modelsFrom, toChatModelInfo, validEffort, type KiroModel } from './models';
import { AGENT_NAME, allowOptionId, installAgentProfile, isBridgeTool, type UsageReport } from './kiroAgent';
import { KiroTurn, type ToolResult } from './turn';
import { transcriptOf, type TranscriptTurn } from './transcript';

/** The language model vendor. Its models show in the Copilot Chat model picker. */
const VENDOR = 'kiro';

/** Global state key for the last model list Kiro reported. */
const MODELS_KEY = 'kiro.models';

/** Global state key for the chats whose Kiro sessions can be reopened. */
const CONVERSATIONS_KEY = 'kiro.conversations';

/** ponytail: a Kiro session that no chat has used for this long is closed to free memory. It reopens on the next message. */
const IDLE_LIMIT_MS = 30 * 60_000;

/** ponytail: chats kept for reopening. The oldest beyond this are forgotten, and their Kiro sessions stay on disk. */
const MAX_CONVERSATIONS = 50;

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Kiro ACP');
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
	const agentDir = path.join(os.homedir(), '.kiro', 'agents');
	try {
		output.appendLine(`Installed Kiro agent profile at ${installAgentProfile(agentDir)}`);
	} catch (error) {
		output.appendLine(`Could not install the Kiro agent profile: ${describe(error)}`);
	}

	const acp = new AcpClient({
		cwd,
		log: line => output.appendLine(line),
		onPermission: request => askPermission(request),
	});

	/** Turns still running, by conversation key. The bridge routes Kiro's tool calls to them. */
	const turns = new Map<string, KiroTurn>();
	/** The chats whose Kiro sessions can be continued. */
	const conversations: KiroConversation[] = [];

	const bridge = new McpBridge({
		listTools: sessionKey => turns.get(sessionKey)?.tools ?? [],
		callTool: (sessionKey, name, input) => {
			const turn = turns.get(sessionKey);
			return turn ? turn.callTool(name, input) : Promise.reject(new Error('No Kiro turn is running for this tool call.'));
		},
	});

	const usageItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
	/**
	 * Shows Kiro's context usage and last turn cost. VS Code gives language model providers no way to fill the
	 * Copilot context indicator (microsoft/vscode#330783), so this is the only place the figures can go.
	 */
	const showUsage = (usage: UsageReport): void => {
		const percent = usage.contextPercent === undefined ? '?' : usage.contextPercent.toFixed(1);
		const credits = usage.credits === undefined ? 'unknown' : usage.credits.toFixed(3);
		usageItem.text = `$(pulse) Kiro ${percent}% context`;
		usageItem.tooltip = `Share of Kiro's context window in use. The last turn cost ${credits} credits.`;
		usageItem.show();
	};

	let modelCache: Promise<KiroModel[]> | undefined;
	const modelsChanged = new vscode.EventEmitter<void>();
	const loadModels = (refresh = false): Promise<KiroModel[]> => {
		if (refresh) {
			modelCache = undefined;
		}
		modelCache ??= acp.discoverConfig().then(options => {
			const models = modelsFrom(options);
			if (models.length === 0) {
				throw new Error('kiro-cli returned no model list.');
			}
			void context.globalState.update(MODELS_KEY, models);
			return models;
		}).catch(error => {
			modelCache = undefined;
			output.appendLine(`Could not read Kiro models: ${describe(error)}`);
			if (refresh) {
				throw error;
			}
			// Keep offering the last list that worked, so the picker survives a slow or failed kiro-cli start.
			return context.globalState.get<KiroModel[]>(MODELS_KEY) ?? [];
		});
		return modelCache;
	};

	const persist = (): void => {
		const saved = conversations.flatMap(conversation => {
			const entry = conversation.toSaved();
			return entry ? [entry] : [];
		});
		void context.globalState.update(CONVERSATIONS_KEY, saved);
	};

	const newConversation = (): KiroConversation => {
		const conversation = new KiroConversation(acp, bridge);
		conversations.push(conversation);
		return conversation;
	};

	/** Stops tracking a chat. Its Kiro session is closed, and it cannot be continued afterwards. */
	const forget = (conversation: KiroConversation): void => {
		const index = conversations.indexOf(conversation);
		if (index >= 0) {
			conversations.splice(index, 1);
		}
		void conversation.suspend();
		persist();
	};

	/**
	 * Closes idle Kiro sessions to free memory. They reopen when their chat continues. Chats beyond the limit
	 * are forgotten, oldest first.
	 */
	const tidy = (): void => {
		const cutoff = Date.now() - IDLE_LIMIT_MS;
		for (const conversation of conversations) {
			if (!conversation.busy && conversation.isOpen && conversation.lastUsed < cutoff) {
				void conversation.suspend();
			}
		}
		const idle = conversations.filter(conversation => !conversation.busy).sort((a, b) => a.lastUsed - b.lastUsed);
		for (const conversation of idle.slice(0, Math.max(0, conversations.length - MAX_CONVERSATIONS))) {
			forget(conversation);
		}
	};

	// Chats from earlier VS Code sessions. Their Kiro sessions reopen when a chat continues.
	for (const saved of context.globalState.get<SavedConversation[]>(CONVERSATIONS_KEY, [])) {
		conversations.push(new KiroConversation(acp, bridge, saved));
	}

	/**
	 * Relays a turn's events into the chat until the turn ends or asks for a tool to run. When a tool is
	 * requested, the response ends. VS Code runs the tool with its own context and then calls this
	 * provider again with the result, which resumes the same turn.
	 */
	const drive = async (
		turn: KiroTurn,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> => {
		const cancellation = token.onCancellationRequested(() => turn.cancel());
		try {
			for (;;) {
				const event = await turn.next();
				if (event.kind === 'text') {
					progress.report(new vscode.LanguageModelTextPart(event.text));
				} else if (event.kind === 'tool') {
					progress.report(new vscode.LanguageModelToolCallPart(event.callId, event.name, (event.input ?? {}) as object));
					return;
				} else if (event.kind === 'done') {
					output.appendLine(`Turn finished: ${event.stopReason}`);
					return;
				} else {
					throw event.error;
				}
			}
		} finally {
			cancellation.dispose();
		}
	};

	/**
	 * Answers a chat request with a Kiro model. A request that carries results for tool calls continues the
	 * turn that asked for them. A request that adds one message to a chat the extension knows continues that
	 * chat's Kiro session. Any other request starts a new chat.
	 */
	const answer = async (
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> => {
		const results = toolResults(messages);
		const continued = [...turns.values()].find(turn => results.some(result => turn.owns(result.callId)));
		if (continued) {
			continued.resolveTools(results);
			await drive(continued, progress, token);
			return;
		}

		tidy();
		const known = (await loadModels()).find(entry => entry.id === model.id);
		const users = userMessagesFrom(messages);
		const digests = users.map(user => digest(user.text, user.images.map(image => image.data)));
		const earlier = continuationOf(conversations, digests);
		const conversation = earlier ?? newConversation();
		output.appendLine(earlier ? `Continuing chat ${conversation.key}.` : `Starting chat ${conversation.key}.`);
		conversation.userMessages = digests;
		conversation.busy = true;
		conversation.lastUsed = Date.now();
		const transcript: PromptBlock[] = [
			{ type: 'text', text: transcriptOf(transcriptFrom(messages)) },
			...messages.flatMap(message => imagesOf(message.content)),
		];

		const turn = new KiroTurn(conversation, acp, bridge, {
			onUsage: showUsage,
			log: line => output.appendLine(line),
			onFinish: finished => {
				turns.delete(finished.conversation.key);
				finished.conversation.busy = false;
				finished.conversation.lastUsed = Date.now();
				if (finished.failed) {
					forget(finished.conversation);
				} else {
					persist();
				}
			},
		});
		turns.set(conversation.key, turn);
		turn.start({
			agent: AGENT_NAME,
			model: model.id,
			effort: validEffort(known, effortRequested(options)),
			// A session that is reopened already holds the earlier messages, so only the newest one is sent.
			prompt: earlier ? promptOf(users[users.length - 1]) : transcript,
			transcript,
			tools: bridgeToolsFrom(options.tools ?? []),
		});
		await drive(turn, progress, token);
	};

	context.subscriptions.push(
		output,
		usageItem,
		modelsChanged,
		{ dispose: () => bridge.dispose() },
		{ dispose: () => acp.dispose() },
		{ dispose: () => turns.forEach(turn => turn.cancel()) },
		vscode.commands.registerCommand('kiro-acp.refreshModels', async () => {
			try {
				const models = await loadModels(true);
				modelsChanged.fire();
				void vscode.window.showInformationMessage(`Detected ${models.length} Kiro models.`);
			} catch (error) {
				void vscode.window.showErrorMessage(`Could not detect Kiro models: ${describe(error)}`);
			}
		}),
		vscode.commands.registerCommand('kiro-acp.regenerateAgent', () => {
			try {
				const profilePath = installAgentProfile(agentDir);
				output.appendLine(`Regenerated Kiro agent profile at ${profilePath}`);
				void vscode.window.showInformationMessage('Kiro agent profile regenerated with Copilot tools.');
			} catch (error) {
				output.appendLine(`Could not regenerate the Kiro agent profile: ${describe(error)}`);
				void vscode.window.showErrorMessage(`Could not regenerate the Kiro agent profile: ${describe(error)}`);
			}
		}),
		vscode.lm.registerLanguageModelChatProvider(VENDOR, {
			onDidChangeLanguageModelChatInformation: modelsChanged.event,
			provideLanguageModelChatInformation: async () => {
				const models = await loadModels();
				return models.map(model => toChatModelInfo(model) as unknown as vscode.LanguageModelChatInformation);
			},
			provideLanguageModelChatResponse: (model, messages, options, progress, token) => answer(model, messages, options, progress, token),
			provideTokenCount: async (_model, text) => {
				const value = typeof text === 'string' ? text : textOf(text.content);
				return Math.ceil(value.length / 4);
			},
		}),
	);

	void loadModels();
	output.appendLine(`Kiro ACP ready. Sessions run in ${cwd}`);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Shows Kiro's permission options as a quick pick. Dismissing the pick declines the request. */
async function askPermission(request: PermissionRequest): Promise<string | undefined> {
	if (isBridgeTool(request.toolCall?.title)) {
		// The tool runs through VS Code's own confirmations, so this extra prompt is skipped.
		return allowOptionId(request.options);
	}
	const picked = await vscode.window.showQuickPick(
		request.options.map(option => ({ label: option.name, optionId: option.optionId })),
		{ title: `Kiro wants to run: ${request.toolCall?.title ?? 'a tool'}`, ignoreFocusOut: true },
	);
	return picked?.optionId;
}

/** The text of a list of message parts. Other parts contribute nothing. */
function textOf(parts: readonly unknown[]): string {
	return parts.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : '').join('');
}

/** A user message's text, and its images as base64 image blocks for Kiro. */
interface UserMessage {
	readonly text: string;
	readonly images: readonly ImageBlock[];
}

/** The user messages that have text or images, in order. Tool results carry neither here, so they are skipped. */
function userMessagesFrom(messages: readonly vscode.LanguageModelChatRequestMessage[]): UserMessage[] {
	return messages
		.filter(message => message.role === vscode.LanguageModelChatMessageRole.User)
		.map(message => ({ text: textOf(message.content), images: imagesOf(message.content) }))
		.filter(message => message.text.trim().length > 0 || message.images.length > 0);
}

/** The prompt for one user message: its text, then its images. */
function promptOf(message: UserMessage): PromptBlock[] {
	return [...(message.text ? [{ type: 'text' as const, text: message.text }] : []), ...message.images];
}

/** True for an image part. Only images are sent to Kiro. */
function isImage(part: unknown): part is vscode.LanguageModelDataPart {
	return part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/');
}

/** The images in a list of message parts, base64 encoded for Kiro. */
function imagesOf(parts: readonly unknown[]): ImageBlock[] {
	return parts.filter(isImage).map((part): ImageBlock => ({
		type: 'image',
		mimeType: part.mimeType,
		data: Buffer.from(part.data).toString('base64'),
	}));
}

/**
 * Turns VS Code's message parts into plain text for a new Kiro session. Tool calls and results stay visible as text.
 * Each image is marked with its number. The image data is sent after the text, in the same order.
 */
function transcriptFrom(messages: readonly vscode.LanguageModelChatRequestMessage[]): TranscriptTurn[] {
	let images = 0;
	return messages.map(message => ({
		role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user',
		text: message.content.map(part => {
			if (!isImage(part)) {
				return describePart(part);
			}
			images++;
			return `[image ${images}]`;
		}).filter(text => text.length > 0).join('\n'),
	}));
}

function describePart(part: unknown): string {
	if (part instanceof vscode.LanguageModelTextPart) {
		return part.value;
	}
	if (part instanceof vscode.LanguageModelToolCallPart) {
		return `(called the ${part.name} tool with ${JSON.stringify(part.input)})`;
	}
	if (part instanceof vscode.LanguageModelToolResultPart) {
		return `(tool result: ${textOf(part.content)})`;
	}
	return '';
}

/** The tool results VS Code sends back for the calls this provider made. */
function toolResults(messages: readonly vscode.LanguageModelChatRequestMessage[]): ToolResult[] {
	return messages.flatMap(message => message.content.flatMap(part => part instanceof vscode.LanguageModelToolResultPart
		? [{ callId: part.callId, text: textOf(part.content), isError: false }]
		: []));
}

/** The chat's enabled tools, in the shape the bridge offers them to Kiro. */
function bridgeToolsFrom(tools: readonly vscode.LanguageModelChatTool[]): BridgeTool[] {
	// Copilot's Autopilot completion tool. Kiro ends a turn by replying without a tool call, so it is not offered this
	// one. Offered to Kiro, it kept the turn running after its result.
	return tools.filter(tool => tool.name !== 'task_complete').map(tool => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
	}));
}
