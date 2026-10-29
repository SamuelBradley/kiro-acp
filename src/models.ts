import type { ConfigOption } from './acpClient';

/** Output budget reserved from each model's context window. */
const MAX_OUTPUT_TOKENS = 32_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** The key Copilot sends the chosen effort under, and the group the picker shows it in. */
export const EFFORT_PROPERTY = 'reasoningEffort';
const EFFORT_GROUP = 'navigation';

export interface KiroModel {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly contextWindow: number;
	/** The effort levels this model accepts. Empty when the model has no effort setting. */
	readonly effortLevels: readonly string[];
	readonly defaultEffort?: string;
}

/**
 * Reads the model choices from the `model` config option Kiro reports on session start.
 * Kiro states the context size in the description (for example "with 1M context window") and
 * lists each model's effort levels under `_meta.kiro`.
 */
export function modelsFrom(configOptions: readonly ConfigOption[]): KiroModel[] {
	const option = configOptions.find(entry => entry.id === 'model' || entry.category === 'model');
	return (option?.options ?? []).map(choice => {
		const kiro = choice._meta?.kiro;
		const description = choice.description ?? '';
		const size = /(\d+(?:\.\d+)?)\s*M\s*context/i.exec(description);
		return {
			id: choice.value,
			name: choice.name,
			description,
			contextWindow: size ? Math.round(Number(size[1]) * 1_000_000) : DEFAULT_CONTEXT_WINDOW,
			effortLevels: kiro?.effortLevels ?? [],
			defaultEffort: kiro?.defaultEffortLevel,
		};
	});
}

export function effortLabel(level: string): string {
	switch (level) {
		case 'none': return 'None';
		case 'low': return 'Low';
		case 'medium': return 'Medium';
		case 'high': return 'High';
		case 'xhigh': return 'xHigh';
		case 'max': return 'Max';
		default: return level.charAt(0).toUpperCase() + level.slice(1);
	}
}

/** The effort to send for a model, or undefined when the model does not accept the requested level. */
export function validEffort(model: KiroModel | undefined, requested: unknown): string | undefined {
	return typeof requested === 'string' && model?.effortLevels.includes(requested) ? requested : undefined;
}

/** The effort the picker sent with a request, if any. */
export function effortRequested(options: unknown): unknown {
	return (options as { modelConfiguration?: Record<string, unknown> }).modelConfiguration?.[EFFORT_PROPERTY];
}

/**
 * The shape VS Code's language model picker reads. A model with effort levels also carries a
 * configuration schema, which makes the picker show an effort control for it.
 */
export function toChatModelInfo(model: KiroModel) {
	const info = {
		id: model.id,
		name: model.name,
		family: 'kiro',
		version: '1',
		detail: 'Kiro CLI',
		tooltip: model.description,
		maxInputTokens: model.contextWindow - MAX_OUTPUT_TOKENS,
		maxOutputTokens: MAX_OUTPUT_TOKENS,
		capabilities: { toolCalling: true, imageInput: false },
	};
	if (model.effortLevels.length === 0) {
		return info;
	}
	const levels = [...model.effortLevels];
	const fallback = model.defaultEffort && levels.includes(model.defaultEffort) ? model.defaultEffort : levels[0];
	return {
		...info,
		configurationSchema: {
			properties: {
				[EFFORT_PROPERTY]: {
					type: 'string',
					title: 'Thinking Effort',
					description: 'How much reasoning the model spends before it answers.',
					group: EFFORT_GROUP,
					enum: levels,
					enumItemLabels: levels.map(effortLabel),
					default: fallback,
				},
			},
		},
	};
}
