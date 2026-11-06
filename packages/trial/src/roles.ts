import type { Role, SubmitToolName } from './interim/types.js';

/**
 * The only tools any role may be given. Each is a schema-validated submit tool.
 * There is no shell, file, or network tool anywhere in this table or in the
 * SubmitToolName union, so an agent cannot execute code or reach a host.
 */
export const ROLE_TOOLS = {
  defense: ['submit_witness'],
  prosecution: ['submit_counterexample'],
  remedy: ['submit_patch'],
  juror: ['submit_ballot'],
} as const satisfies Record<string, readonly SubmitToolName[]>;

type ModelRole = keyof typeof ROLE_TOOLS;

function isModelRole(role: Role): role is ModelRole {
  return Object.hasOwn(ROLE_TOOLS, role);
}

/** Throws unless every requested tool is on the role's allowlist. */
export function assertAllowedTools(role: Role, tools: readonly SubmitToolName[]): void {
  if (!isModelRole(role)) {
    throw new Error(`role ${role} has no tools and never calls a model`);
  }
  const allowed: readonly string[] = ROLE_TOOLS[role];
  for (const tool of tools) {
    if (!allowed.includes(tool)) {
      throw new Error(`tool ${String(tool)} is not allowed for role ${role}`);
    }
  }
}
