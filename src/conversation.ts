import { createHash, randomUUID } from 'node:crypto';
import type { AcpClient } from './acpClient';
import type { McpBridge } from './mcpBridge';

/** Collapses whitespace, so a message still compares equal after the chat re-renders it. */
export function normalize(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * A fingerprint of a user message. Conversations keep these instead of the text, so chat content is not
 * stored between VS Code sessions.
 */
export function digest(text: string): string {
	return createHash('sha256').update(normalize(text)).digest('hex');
}

/**
 * The one conversation that a request continues. Its earlier user messages must match the request's user
 * messages in order, and the request must add exactly one message. Busy conversations are skipped.
 * Returns undefined when no conversation matches, or when more than one does, since then two chats
 * cannot be told apart.
 */
export function continuationOf<T extends { readonly userMessages: readonly string[]; readonly busy: boolean }>(
	conversations: readonly T[],
	userMessages: readonly string[],
): T | undefined {
	const matches = conversations.filter(conversation => !conversation.busy
		&& conversation.userMessages.length + 1 === userMessages.length
		&& conversation.userMessages.every((text, index) => text === userMessages[index]));
	return matches.length === 1 ? matches[0] : undefined;
}

/** What is kept for one conversation between VS Code sessions. */
export interface SavedConversation {
	readonly key: string;
	readonly acpSessionId: string;
	readonly userMessages: readonly string[];
	readonly lastUsed: number;
}

/**
 * A chat's Kiro session. Kiro keeps each session's history on disk, so the session can be closed to free
 * memory and opened again later. `loadedIn` is the kiro-cli process the session is open in.
 */
export class KiroConversation {
	readonly key: string;
	/** The Kiro session id. Kept after the session is closed, so the session can be reopened. */
	acpSessionId?: string;
	/** The kiro-cli process the session is open in. Undefined while it is closed. */
	loadedIn?: number;
	/** Digests of the user messages this session has been sent, in order. */
	userMessages: string[];
	busy = false;
	lastUsed: number;

	constructor(private readonly acp: AcpClient, private readonly bridge: McpBridge, saved?: SavedConversation) {
		this.key = saved?.key ?? `chat-${randomUUID()}`;
		this.acpSessionId = saved?.acpSessionId;
		this.userMessages = [...(saved?.userMessages ?? [])];
		this.lastUsed = saved?.lastUsed ?? Date.now();
	}

	/** True when the session is open in the running kiro-cli process. */
	get isOpen(): boolean {
		return this.acpSessionId !== undefined && this.loadedIn === this.acp.processId;
	}

	/** What to keep for this conversation between VS Code sessions. A conversation without a Kiro session keeps nothing. */
	toSaved(): SavedConversation | undefined {
		if (!this.acpSessionId) {
			return undefined;
		}
		return { key: this.key, acpSessionId: this.acpSessionId, userMessages: [...this.userMessages], lastUsed: this.lastUsed };
	}

	/** Closes the Kiro session to free memory. Kiro keeps the session, so the next turn opens it again. */
	async suspend(): Promise<void> {
		const sessionId = this.acpSessionId;
		const wasOpen = this.isOpen;
		this.loadedIn = undefined;
		this.bridge.release(this.key);
		if (sessionId && wasOpen) {
			await this.acp.closeSession(sessionId).catch(() => undefined);
		}
	}
}
