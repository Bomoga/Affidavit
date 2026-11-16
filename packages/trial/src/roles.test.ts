import { describe, expect, it } from 'vitest';
import { ROLE_TOOLS, assertAllowedTools } from './roles.js';

// Anything that could execute code, touch a filesystem, or reach a network.
const DANGEROUS =
  /shell|bash|sh$|exec|eval|run|spawn|cmd|powershell|fetch|http|curl|wget|net|socket|web|browse|search|file|read|write|fs|code|python|node/i;

describe('role tool allowlists', () => {
  it('lists the roles that may call a model', () => {
    expect(Object.keys(ROLE_TOOLS).sort()).toEqual(['defense', 'juror', 'prosecution', 'remedy']);
  });

  it('gives every role only schema-validated submit tools', () => {
    for (const [role, tools] of Object.entries(ROLE_TOOLS)) {
      expect(tools.length, `${role} has no tools`).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool, `${role}: ${tool}`).toMatch(/^submit_[a-z_]+$/);
      }
    }
  });

  it('has no tool that can execute code or reach the network', () => {
    for (const [role, tools] of Object.entries(ROLE_TOOLS)) {
      for (const tool of tools) {
        expect(tool.replace(/^submit_/, ''), `${role}: ${tool}`).not.toMatch(DANGEROUS);
      }
    }
  });

  it('gives each role only the tool for its own output', () => {
    expect(ROLE_TOOLS.defense).toEqual(['submit_witness']);
    expect(ROLE_TOOLS.prosecution).toEqual(['submit_counterexample']);
    expect(ROLE_TOOLS.remedy).toEqual(['submit_patch']);
    expect(ROLE_TOOLS.juror).toEqual(['submit_ballot']);
  });

  it('accepts a subset of the role allowlist', () => {
    expect(() => assertAllowedTools('defense', ['submit_witness'])).not.toThrow();
  });

  it('rejects a tool outside the role allowlist', () => {
    expect(() => assertAllowedTools('defense', ['submit_patch'])).toThrow(/not allowed/);
    expect(() => assertAllowedTools('juror', ['submit_ballot', 'submit_witness'])).toThrow(
      /not allowed/,
    );
  });

  it('rejects a tool name that is not in the closed list, even if cast through', () => {
    expect(() => assertAllowedTools('defense', ['bash' as never])).toThrow(/not allowed/);
  });

  it('rejects roles that never call a model', () => {
    expect(() => assertAllowedTools('judge', ['submit_witness'])).toThrow(/no tools/);
    expect(() => assertAllowedTools('stenographer', [])).toThrow(/no tools/);
  });
});
