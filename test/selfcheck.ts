import assert from 'node:assert/strict';
import { splitLines } from '../src/framing';
import { McpBridge } from '../src/mcpBridge';
import { effortRequested, modelsFrom, toChatModelInfo, validEffort } from '../src/models';
import { transcriptOf } from '../src/transcript';
import { continuationOf, digest, normalize } from '../src/conversation';
import { AGENT_NAME, allowOptionId, installAgentProfile, isBridgeTool, usageFrom } from '../src/kiroAgent';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Framing: a line split across two chunks is joined, and blank lines are dropped.
const first = splitLines('{"a":1}\n{"b":');
assert.deepEqual(first.lines, ['{"a":1}']);
assert.equal(first.rest, '{"b":');
const second = splitLines(first.rest + '2}\n\n');
assert.deepEqual(second.lines, ['{"b":2}']);
assert.equal(second.rest, '');

// Models: ids and context size come from the config option, and effort levels from each model's _meta.
const models = modelsFrom([{
	id: 'model',
	category: 'model',
	type: 'select',
	options: [
		{ value: 'auto', name: 'Auto', description: 'Chosen by task' },
		{
			value: 'claude-sonnet-5.5',
			name: 'Claude Sonnet 5.5',
			description: 'Claude Sonnet 5.5 model with 1M context window',
			_meta: { kiro: { effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffortLevel: 'high' } },
		},
	],
}]);
const [auto, sonnet] = models;
assert.deepEqual(models.map(model => model.id), ['auto', 'claude-sonnet-5.5']);
assert.equal(auto.contextWindow, 200_000);
assert.equal(sonnet.contextWindow, 1_000_000);
assert.deepEqual(auto.effortLevels, []);

// Effort: only levels the model lists are sent, and the picker's choice is read from the request options.
assert.equal(validEffort(sonnet, 'high'), 'high');
assert.equal(validEffort(sonnet, 'none'), undefined);
assert.equal(validEffort(auto, 'low'), undefined);
assert.equal(effortRequested({ modelConfiguration: { reasoningEffort: 'low' } }), 'low');
assert.equal(effortRequested({}), undefined);

// The picker info: effort models get a configuration schema with the default; others do not.
assert.equal((toChatModelInfo(auto) as { configurationSchema?: unknown }).configurationSchema, undefined);
const schema = (toChatModelInfo(sonnet) as { configurationSchema?: any }).configurationSchema;
assert.deepEqual(schema.properties.reasoningEffort.enum, ['low', 'medium', 'high', 'xhigh', 'max']);
assert.equal(schema.properties.reasoningEffort.default, 'high');
assert.equal(schema.properties.reasoningEffort.enumItemLabels[3], 'xHigh');

// Transcript: a single message is sent as-is; earlier messages are marked as context and the latest is set apart.
assert.equal(transcriptOf([{ role: 'user', text: 'hi' }]), 'hi');
const transcript = transcriptOf([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }, { role: 'user', text: 'name?' }]);
assert.ok(transcript.includes('[assistant] hello'));
assert.ok(transcript.endsWith('<latest_user_message>\nname?\n</latest_user_message>'));

// Kiro agent: the profile offers only the VS Code bridge tools, bridge permissions are recognised, and usage is read from Kiro's metadata.
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-agent-'));
const profilePath = installAgentProfile(profileDir);
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
assert.equal(profile.name, AGENT_NAME);
assert.deepEqual(profile.tools, ['@vscode']);
assert.equal(installAgentProfile(profileDir), profilePath);
fs.rmSync(profileDir, { recursive: true });
assert.ok(isBridgeTool('@vscode/marker_lookup'));
assert.ok(!isBridgeTool('fs_write'));
assert.equal(allowOptionId([{ optionId: 'reject', kind: 'reject_once' }, { optionId: 'accept', kind: 'allow_once' }]), 'accept');
assert.equal(allowOptionId([{ optionId: 'reject', kind: 'reject_once' }]), undefined);
assert.deepEqual(usageFrom({ _meta: { kiro: { contextUsage: { usagePercentage: 2.5 } } } }), { contextPercent: 2.5, credits: undefined });
assert.deepEqual(usageFrom({ _meta: { kiro: { promptTurnSummaries: [{ unit: 'credit', usage: 0.035 }] } } }), { contextPercent: undefined, credits: 0.035 });
assert.equal(usageFrom({ sessionUpdate: 'agent_message_chunk' }), undefined);

// Conversations: a follow-up continues the one conversation that its earlier messages match exactly.
assert.equal(normalize('  hello \n  there '), 'hello there');
assert.equal(digest('  hello \n  there '), digest('hello there'));
assert.notEqual(digest('hello'), digest('goodbye'));
const chatA = { id: 'a', userMessages: ['hi'], busy: false };
const chatB = { id: 'b', userMessages: ['hi', 'how are you'], busy: false };
assert.equal(continuationOf([chatA, chatB], ['hi', 'tell me more'])?.id, 'a');
assert.equal(continuationOf([chatA, { ...chatA, id: 'c' }], ['hi', 'tell me more']), undefined, 'two matching chats cannot be told apart');
assert.equal(continuationOf([{ ...chatA, busy: true }], ['hi', 'tell me more']), undefined, 'a busy session takes no new message');
assert.equal(continuationOf([chatB], ['hi', 'changed', 'tell me more']), undefined, 'an edited earlier message starts a new session');
assert.equal(continuationOf([chatA], ['hi']), undefined, 'a request that adds no message is not a follow-up');

// MCP bridge: tools/list and tools/call work over HTTP, an unknown path is refused, and a released session stops answering.
const bridge = new McpBridge({
	listTools: () => [{ name: 'echo', description: 'Echo the input', inputSchema: { type: 'object' } }],
	callTool: async (sessionKey, name, input) => `${sessionKey}:${name}:${JSON.stringify(input)}`,
});

async function main(): Promise<void> {
	await bridge.start();
	const url = bridge.urlFor('chat-1');
	const post = (body: object, target = url) => fetch(target, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});

	const listed = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json() as any;
	assert.equal(listed.result.tools[0].name, 'echo');

	const called = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { x: 1 } } })).json() as any;
	assert.equal(called.result.content[0].text, 'chat-1:echo:{"x":1}');

	const unknown = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, url.replace(/\/mcp\/[0-9a-f]+$/, `/mcp/${'f'.repeat(32)}`));
	assert.equal(unknown.status, 404);

	bridge.release('chat-1');
	const released = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
	assert.equal(released.status, 404);

	bridge.dispose();
	console.log('selfcheck passed');
}

main().catch(error => {
	bridge.dispose();
	console.error(error);
	process.exit(1);
});
