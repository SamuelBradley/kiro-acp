import * as fs from 'node:fs';
import * as path from 'node:path';

/** The agent profile the extension installs. Its only tools are the VS Code tools the bridge serves. */
export const AGENT_NAME = 'vscode-tools';

/** Kiro names tools from MCP servers as `@<server>/<tool>`. The bridge's server is called `vscode`. */
const BRIDGE_PREFIX = '@vscode/';

/**
 * Kiro's profile for the extension. Kiro's built-in write and shell tools are left out, so files change
 * only through VS Code's tools. Kiro still lists a read-only file tool, which the profile cannot remove.
 */
export function agentProfile(): object {
	return {
		name: AGENT_NAME,
		model: 'auto',
		tools: ['@vscode'],
		mcpServers: {},
		includeMcpJson: false,
		prompt: 'Use the tools provided by the vscode MCP server to read, edit, create and run things in the workspace. You have no built-in file or shell tools.',
	};
}

/** Writes the profile into Kiro's global agent directory when its content differs, and returns the file path. */
export function installAgentProfile(agentDir: string): string {
	const file = path.join(agentDir, `${AGENT_NAME}.json`);
	const content = JSON.stringify(agentProfile(), null, 2) + '\n';
	fs.mkdirSync(agentDir, { recursive: true });
	if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
		fs.writeFileSync(file, content);
	}
	return file;
}

/** True when a permission request is for a tool served by the VS Code bridge. */
export function isBridgeTool(title: string | undefined): boolean {
	return title?.startsWith(BRIDGE_PREFIX) ?? false;
}

/** The option that allows the request once, if the agent offered one. */
export function allowOptionId(options: readonly { readonly optionId: string; readonly kind?: string }[]): string | undefined {
	return options.find(option => option.kind === 'allow_once')?.optionId
		?? options.find(option => /allow/i.test(option.kind ?? '') || /allow/i.test(option.optionId))?.optionId;
}

export interface UsageReport {
	/** Share of Kiro's context window in use, in percent. */
	readonly contextPercent?: number;
	/** Credits the last completed turn cost. */
	readonly credits?: number;
}

/** Reads context usage and turn cost from a session update. Returns undefined for updates that carry neither. */
export function usageFrom(update: any): UsageReport | undefined {
	const kiro = update?._meta?.kiro;
	const percent = kiro?.contextUsage?.usagePercentage;
	const credits = kiro?.promptTurnSummaries?.find((summary: any) => summary?.unit === 'credit')?.usage;
	if (typeof percent !== 'number' && typeof credits !== 'number') {
		return undefined;
	}
	return {
		contextPercent: typeof percent === 'number' ? percent : undefined,
		credits: typeof credits === 'number' ? credits : undefined,
	};
}
