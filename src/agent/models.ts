export type Provider = 'openai' | 'anthropic';

export type Model = {
  name: string;
  apiName?: string;
  endpoint?: string;
  type: string;
  provider: Provider;
  streaming?: boolean;
  reasoning?: boolean;
  extendedThinking?: boolean;
  contextWindowTokens?: number;
  compactionTargetTokens?: number;
};

// Prefer process.env when available (main/preload), but guard in browser (renderer).
const endpoint =
  (typeof process !== 'undefined' && process?.env?.BRILLIANT_AI_ENDPOINT)
    || (typeof process !== 'undefined' && process?.env?.AZURE_OPENAI_ENDPOINT)
    || (typeof import.meta !== 'undefined' && (import.meta as any)?.env?.VITE_BRILLIANT_AI_ENDPOINT)
    || '';

// OpenAI models served via the Brilliant AI proxy (legacy Azure envs remain for compatibility).
// These keys map to deployment/model names that the renderer passes back from the
// model picker. The main process relays the chosen string directly to the SDK.
export const OPENAI_MODELS: Record<string, Model> = {
  'gpt-5.1-codex-max': {
    name: 'gpt-5.1-codex-max',
    endpoint,
    type: 'reasoning',
    provider: 'openai',
    streaming: false,
    reasoning: true,
    contextWindowTokens: 272_000,
    compactionTargetTokens: 180_000,
  },
  'gpt-5.1': {
    name: 'gpt-5.1',
    endpoint,
    type: 'reasoning',
    provider: 'openai',
    streaming: false,
    reasoning: true,
    contextWindowTokens: 272_000,
    compactionTargetTokens: 180_000,
  },
  'gpt-5.2': {
    name: 'gpt-5.2',
    endpoint,
    type: 'reasoning',
    provider: 'openai',
    streaming: false,
    reasoning: true,
    contextWindowTokens: 272_000,
    compactionTargetTokens: 180_000,
  },
  'gpt-5-pro': {
    name: 'gpt-5-pro',
    endpoint,
    type: 'reasoning',
    provider: 'openai',
    streaming: false,
    reasoning: true,
    contextWindowTokens: 272_000,
    compactionTargetTokens: 180_000,
  }
};

export const ANTHROPIC_MODELS: Record<string, Model> = {
  'claude-opus-4.5': {
    name: 'claude-opus-4.5',
    apiName: 'claude-opus-4-5-20251101',
    type: 'extended_thinking',
    provider: 'anthropic',
    streaming: false,
    reasoning: false,
    extendedThinking: true,
    contextWindowTokens: 200_000,
    compactionTargetTokens: 100_000,
  },
  'claude-sonnet-4.5': {
    name: 'claude-sonnet-4.5',
    apiName: 'claude-sonnet-4-5-20250929',
    type: 'extended_thinking',
    provider: 'anthropic',
    streaming: false,
    reasoning: false,
    extendedThinking: true,
    contextWindowTokens: 200_000,
    compactionTargetTokens: 100_000,
  },
};

export const MODELS: Record<string, Model> = {
  ...OPENAI_MODELS,
  ...ANTHROPIC_MODELS
};

export function supportsReasoning(modelName: string): boolean {
  const model = MODELS[modelName];
  const resolvedName = model?.apiName || model?.name;
  if (!model) return modelName.startsWith('gpt-5');
  if (model.reasoning === false) return false;
  if (model.reasoning === true) return true;
  if (model.extendedThinking === true) return true;
  return (resolvedName || modelName).startsWith('gpt-5');
}

export function getModelProvider(modelName: string): Provider {
  const model = MODELS[modelName];
  if (!model) {
    if (modelName.startsWith('claude-')) return 'anthropic';
    return 'openai';
  }
  return model.provider;
}

export function supportsExtendedThinking(modelName: string): boolean {
  const model = MODELS[modelName];
  return model?.extendedThinking === true;
}

export function supportsStreaming(_modelName: string): boolean {
  return false;
}

export function resolveApiModelName(modelKey: string): string {
  const model = MODELS[modelKey];
  if (model?.apiName) return model.apiName;
  if (model?.name) return model.name;
  return modelKey;
}
