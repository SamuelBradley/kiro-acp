export interface TranscriptTurn {
	readonly role: 'user' | 'assistant';
	readonly text: string;
}

/**
 * Builds the prompt for a fresh Kiro session from a chat that the language model path received as a
 * whole. Earlier messages are marked as context, so Kiro answers the latest message instead of
 * continuing the transcript.
 */
export function transcriptOf(turns: readonly TranscriptTurn[]): string {
	const latest = turns[turns.length - 1]?.text ?? '';
	const earlier = turns.slice(0, -1).filter(turn => turn.text.length > 0).map(turn => `[${turn.role}] ${turn.text}`);
	if (earlier.length === 0) {
		return latest;
	}
	return [
		'The earlier messages below are context from this chat. Do not repeat, quote, or continue them.',
		'<earlier_messages>',
		...earlier,
		'</earlier_messages>',
		'',
		'Answer only the message below.',
		'<latest_user_message>',
		latest,
		'</latest_user_message>',
	].join('\n');
}
