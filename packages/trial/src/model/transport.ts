import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * The one seam between the model port and the network. The real transport is the Agent SDK's
 * `query`; tests pass a stub that reads the options and plays scripted messages, so no test ever
 * reaches a model.
 */
export type AgentTransport = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;

export const sdkTransport: AgentTransport = (params) => query(params);
