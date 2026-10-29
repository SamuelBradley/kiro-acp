import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { AcpClient, type PermissionRequest } from './acpClient';
import { McpBridge, type BridgeTool } from './mcpBridge';
import { effortRequested, modelsFrom, toChatModelInfo, validEffort, type KiroModel } from './models';
import { transcriptOf, type TranscriptTurn } from './transcript';

/** The language model vendor. Its models show in the Copilot Chat model picker. */
const VENDOR = 'kiro';

/** The cancellation token of the chat request whose Kiro session is running, keyed by that session. */
const activeRequests = new Map<string, vscode.CancellationToken>();

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Kiro ACP');
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

	const acp = new AcpClient({
		cwd,
		log: line => output.appendLine(line),
		onPermission: request => askPermission(request),
	});

	const bridge = new McpBridge({
		listTools: () => listVsCodeTools(),
		callTool: (sessionKey, name, input) => invokeVsCodeTool(sessionKey, name, input),
	});

	let modelCache: Promise<KiroModel[]> | undefined;
	const loadModels = (): Promise<KiroModel[]> => {
		modelCache ??= acp.discoverConfig().then(modelsFrom).catch(error => {
			modelCache = undefined;
			output.appendLine(`Could not read Kiro models: ${describe(error)}`);
			return [];
		});
		return modelCache;
	};

	/**
	 * Answers one chat request with a Kiro model. The chat sends the whole conversation, so each
	 * request gets its own Kiro session, closed once the answer is complete.
	 */
	const answer = async (
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> => {
		const known = (await loadModels()).find(entry => entry.id === model.id);
		const effort = validEffort(known, effortRequested(options));
		const turns: TranscriptTurn[] = messages.map(message => ({
			role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user',
			text: message.content.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : '').join(''),
		}));

		const key = `chat:${randomUUID()}`;
		await bridge.start();
		const { sessionId } = await acp.newSession(bridge.urlFor(key));
		const abort = new AbortController();
		const subscription = token.onCancellationRequested(() => abort.abort());
		activeRequests.set(key, token);
		try {
			await acp.setOption(sessionId, 'model', model.id);
			if (effort) {
				await acp.setOption(sessionId, 'effortLevel', effort);
			}
			const stop = await acp.prompt(sessionId, transcriptOf(turns), update => report(update, progress), abort.signal);
			output.appendLine(`Turn finished: ${stop} (${model.id}${effort ? `, effort ${effort}` : ''})`);
		} finally {
			activeRequests.delete(key);
			bridge.release(key);
			subscription.dispose();
			await acp.closeSession(sessionId).catch(() => undefined);
		}
	};

	context.subscriptions.push(
		output,
		{ dispose: () => bridge.dispose() },
		{ dispose: () => acp.dispose() },
		vscode.lm.registerLanguageModelChatProvider(VENDOR, {
			provideLanguageModelChatInformation: async () => (await loadModels()).map(
				model => toChatModelInfo(model) as unknown as vscode.LanguageModelChatInformation,
			),
			provideLanguageModelChatResponse: (model, messages, options, progress, token) => answer(model, messages, options, progress, token),
			provideTokenCount: async (_model, text) => {
				const value = typeof text === 'string'
					? text
					: text.content.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : '').join('');
				return Math.ceil(value.length / 4);
			},
		}),
	);

	output.appendLine(`Kiro ACP ready. Sessions run in ${cwd}`);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Shows Kiro's permission options as a quick pick. Dismissing the pick declines the request. */
async function askPermission(request: PermissionRequest): Promise<string | undefined> {
	const picked = await vscode.window.showQuickPick(
		request.options.map(option => ({ label: option.name, optionId: option.optionId })),
		{ title: `Kiro wants to run: ${request.toolCall?.title ?? 'a tool'}`, ignoreFocusOut: true },
	);
	return picked?.optionId;
}

/** Streams Kiro's answer text into the chat. Tool activity is not shown, as the language model API has no slot for it. */
function report(update: any, progress: vscode.Progress<vscode.LanguageModelResponsePart>): void {
	if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
		progress.report(new vscode.LanguageModelTextPart(update.content.text));
	}
}

function listVsCodeTools(): BridgeTool[] {
	// ponytail: every registered VS Code tool is offered to Kiro. Filter by the chat's enabled tools if the list gets too long for the model.
	return vscode.lm.tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
	}));
}

async function invokeVsCodeTool(sessionKey: string, name: string, input: unknown): Promise<string> {
	const token = activeRequests.get(sessionKey);
	if (!token) {
		throw new Error('No chat request is active for this tool call.');
	}
	// ponytail: the language model API does not pass a chat invocation token, so tools that need one may refuse to run.
	const result = await vscode.lm.invokeTool(name, { input: input as object, toolInvocationToken: undefined }, token);
	return result.content.flatMap(part => part instanceof vscode.LanguageModelTextPart ? [part.value] : []).join('\n');
}
