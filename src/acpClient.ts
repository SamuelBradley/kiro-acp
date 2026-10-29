import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { splitLines } from './framing';

/** Kiro CLI 3.x engine, authenticated with the credentials from `kiro-cli login`. */
const KIRO_ARGS = ['acp', '--agent-engine=v3', '--auth-method=cli'];
const PROTOCOL_VERSION = 1;

export interface ConfigChoice {
	readonly value: string;
	readonly name: string;
	readonly description?: string;
	readonly _meta?: {
		readonly kiro?: {
			readonly effortLevels?: readonly string[];
			readonly defaultEffortLevel?: string;
		};
	};
}

export interface ConfigOption {
	readonly id: string;
	readonly category?: string;
	readonly type: string;
	readonly currentValue?: string;
	readonly options?: readonly ConfigChoice[];
}

export interface PermissionRequest {
	readonly sessionId: string;
	readonly toolCall?: { readonly title?: string };
	readonly options: readonly { readonly optionId: string; readonly name: string; readonly kind?: string }[];
}

export interface AcpClientOptions {
	readonly cwd: string;
	readonly log: (line: string) => void;
	/** Resolves to the chosen option id, or undefined when the user declines. */
	readonly onPermission: (request: PermissionRequest) => Promise<string | undefined>;
}

interface Waiter {
	readonly resolve: (value: any) => void;
	readonly reject: (error: Error) => void;
}

/**
 * JSON-RPC 2.0 client for `kiro-cli acp` over stdio. The process starts on first use
 * and restarts on the next call after it exits.
 */
export class AcpClient {
	private child?: ChildProcessWithoutNullStreams;
	private launches = 0;
	private ready?: Promise<void>;
	private nextId = 1;
	private buffer = '';
	private readonly waiters = new Map<number, Waiter>();
	private readonly updateHandlers = new Map<string, (update: any) => void>();
	private readonly configBySession = new Map<string, readonly ConfigOption[]>();

	constructor(private readonly options: AcpClientOptions) { }

	/** Changes each time kiro-cli starts. A session is open only in the process it was opened in. */
	get processId(): number {
		return this.launches;
	}

	/** Starts the process and completes the ACP `initialize` handshake. */
	start(): Promise<void> {
		this.ready ??= this.launch().catch(error => {
			this.ready = undefined;
			throw error;
		});
		return this.ready;
	}

	/** Creates a session and returns its id with the config options Kiro reports for it, such as the model list. */
	async newSession(mcpUrl: string | undefined): Promise<{ sessionId: string; configOptions: readonly ConfigOption[] }> {
		await this.start();
		const mcpServers = mcpUrl ? [{ type: 'http', name: 'vscode', url: mcpUrl, headers: [] }] : [];
		const response = await this.request<{ sessionId: string; configOptions?: readonly ConfigOption[] }>('session/new', {
			cwd: this.options.cwd,
			mcpServers,
		});
		const configOptions = response.configOptions ?? this.configBySession.get(response.sessionId) ?? [];
		this.configBySession.delete(response.sessionId);
		return { sessionId: response.sessionId, configOptions };
	}

	/**
	 * Opens a session that Kiro saved, with the MCP endpoint to use from now on. Kiro replays the saved
	 * history as session updates while it loads. Those reach no handler, because no prompt is running.
	 */
	async loadSession(sessionId: string, mcpUrl: string): Promise<void> {
		await this.start();
		await this.request('session/load', {
			sessionId,
			cwd: this.options.cwd,
			mcpServers: [{ type: 'http', name: 'vscode', url: mcpUrl, headers: [] }],
		});
	}

	/**
	 * True when Kiro still lists the session for this folder. Kiro answers a load for an unknown session id
	 * without an error, so a load alone cannot tell a missing session from a saved one.
	 */
	async hasSession(sessionId: string): Promise<boolean> {
		await this.start();
		let cursor: string | undefined;
		// ponytail: at most 20 pages of listed sessions are read. A folder with more than that is treated as missing.
		for (let page = 0; page < 20; page++) {
			const response = await this.request<{ sessions?: readonly { readonly sessionId: string }[]; nextCursor?: string | null }>('session/list', {
				cwd: this.options.cwd,
				...(cursor ? { cursor } : {}),
			});
			if ((response.sessions ?? []).some(session => session.sessionId === sessionId)) {
				return true;
			}
			cursor = response.nextCursor ?? undefined;
			if (!cursor) {
				return false;
			}
		}
		return false;
	}

	async closeSession(sessionId: string): Promise<void> {
		await this.request('session/close', { sessionId });
	}

	/**
	 * Sets a session config option such as `model` or `effortLevel`. Kiro ignores values it does not
	 * accept, so callers should check the returned value against what they asked for.
	 */
	async setOption(sessionId: string, configId: string, value: string): Promise<readonly ConfigOption[]> {
		const response = await this.request<{ configOptions?: readonly ConfigOption[] }>('session/set_config_option', { sessionId, configId, value });
		return response.configOptions ?? [];
	}

	/**
	 * Sends one user turn and streams the session's updates to `onUpdate`.
	 * Aborting the signal sends `session/cancel`; the returned promise then resolves with the stop reason.
	 */
	async prompt(sessionId: string, text: string, onUpdate: (update: any) => void, signal: AbortSignal): Promise<string> {
		if (signal.aborted) {
			return 'cancelled';
		}
		this.updateHandlers.set(sessionId, onUpdate);
		const cancel = () => this.notify('session/cancel', { sessionId });
		signal.addEventListener('abort', cancel, { once: true });
		try {
			const response = await this.request<{ stopReason: string }>('session/prompt', {
				sessionId,
				prompt: [{ type: 'text', text }],
			});
			return response.stopReason;
		} finally {
			signal.removeEventListener('abort', cancel);
			this.updateHandlers.delete(sessionId);
		}
	}

	/** Opens a throwaway session to read the model list, then closes it. */
	async discoverConfig(): Promise<readonly ConfigOption[]> {
		const { sessionId, configOptions } = await this.newSession(undefined);
		await this.closeSession(sessionId).catch(() => undefined);
		return configOptions;
	}

	dispose(): void {
		this.child?.kill();
	}

	private async launch(): Promise<void> {
		const child = spawn('kiro-cli', KIRO_ARGS, { cwd: this.options.cwd, windowsHide: true });
		this.child = child;
		this.launches++;
		this.buffer = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => this.options.log(chunk.trimEnd()));
		child.on('error', error => this.onExit(child, error));
		child.on('exit', code => this.onExit(child, new Error(`kiro-cli exited with code ${code}`)));

		this.options.log(`Starting kiro-cli ${KIRO_ARGS.join(' ')} in ${this.options.cwd}`);
		await this.request('initialize', {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {},
			clientInfo: { name: 'kiro-acp', version: '0.2.0' },
		});
	}

	private onExit(child: ChildProcessWithoutNullStreams, error: Error): void {
		if (this.child !== child) {
			return;
		}
		this.child = undefined;
		this.ready = undefined;
		for (const waiter of this.waiters.values()) {
			waiter.reject(error);
		}
		this.waiters.clear();
		this.options.log(error.message);
	}

	private request<T>(method: string, params: unknown): Promise<T> {
		if (!this.child) {
			return Promise.reject(new Error('kiro-cli is not running.'));
		}
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.waiters.set(id, { resolve, reject });
			this.write({ jsonrpc: '2.0', id, method, params });
		});
	}

	private notify(method: string, params: unknown): void {
		this.write({ jsonrpc: '2.0', method, params });
	}

	private write(message: object): void {
		this.child?.stdin.write(JSON.stringify(message) + '\n');
	}

	private onStdout(chunk: string): void {
		const { lines, rest } = splitLines(this.buffer + chunk);
		this.buffer = rest;
		for (const line of lines) {
			this.onMessage(line);
		}
	}

	private onMessage(line: string): void {
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			this.options.log(`Ignoring output that is not JSON: ${line.slice(0, 200)}`);
			return;
		}

		if (message.method !== undefined && message.id !== undefined) {
			void this.answerRequest(message);
		} else if (message.method !== undefined) {
			this.onNotification(message.method, message.params);
		} else {
			const waiter = this.waiters.get(message.id);
			if (!waiter) {
				return;
			}
			this.waiters.delete(message.id);
			if (message.error) {
				waiter.reject(new Error(message.error.message ?? 'ACP request failed.'));
			} else {
				waiter.resolve(message.result);
			}
		}
	}

	private onNotification(method: string, params: any): void {
		if (method !== 'session/update') {
			return;
		}
		const update = params?.update;
		if (update?.sessionUpdate === 'config_option_update' && params.sessionId) {
			// Kiro can send config options before the session/new response arrives.
			this.configBySession.set(params.sessionId, update.configOptions ?? []);
		}
		this.updateHandlers.get(params?.sessionId)?.(update);
	}

	/** Kiro asks the client for permission before running its own tools. */
	private async answerRequest(message: { id: number | string; method: string; params: any }): Promise<void> {
		if (message.method === 'session/request_permission') {
			const optionId = await this.options.onPermission(message.params).catch(() => undefined);
			const outcome = optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
			this.write({ jsonrpc: '2.0', id: message.id, result: { outcome } });
			return;
		}
		this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not supported by kiro-acp: ${message.method}` } });
	}
}
