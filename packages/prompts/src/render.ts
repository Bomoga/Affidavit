import { getPrompt } from './registry.js';
import type { PromptId, UntrustedBlock } from './types.js';
import { wrapUntrusted } from './wrapper.js';

export interface RenderedPrompt {
  readonly promptId: PromptId;
  readonly version: string;
  readonly outputSchemaRef: string;
  /** Always the prompt's static system text. Never contains case or app content. */
  readonly system: string;
  /** The user message. All untrusted content lives here, inside wrappers. */
  readonly user: string;
}

export function renderPrompt(id: PromptId, blocks: readonly UntrustedBlock[]): RenderedPrompt {
  const prompt = getPrompt(id);
  const body = blocks.map((b) => wrapUntrusted(b.label, b.content));
  const user = [
    'Review the data blocks below and complete your task with your submit tool.',
    ...body,
  ].join('\n\n');
  return {
    promptId: prompt.id,
    version: prompt.version,
    outputSchemaRef: prompt.outputSchemaRef,
    system: prompt.system,
    user,
  };
}
