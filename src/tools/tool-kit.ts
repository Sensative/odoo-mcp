import type { CallToolResult, McpServer, ToolAnnotations } from '@modelcontextprotocol/server';

import type { Config } from '../config.ts';
import { OdooError, type OdooClient } from '../odoo-client.ts';

export interface ToolDeps {
  readonly config: Config;
  readonly odoo: OdooClient;
  readonly serverName: string;
  readonly serverVersion: string;
}

export type ToolRegistration = (server: McpServer, deps: ToolDeps) => void;

export const READS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const ADDS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const OVERWRITES: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
export const DELETES: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
// Business methods reach beyond the database: they send mail, call carriers, post to banks.
export const RUNS_ANYTHING: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'a list' : `a ${typeof value}`;
}

export function expectList(value: unknown, source: string): readonly unknown[] {
  if (Array.isArray(value)) return value;
  throw new OdooError(`Expected a list from ${source}, but Odoo returned ${typeName(value)}.`);
}

export function expectRecord(value: unknown, source: string): Readonly<Record<string, unknown>> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return { ...value };
  throw new OdooError(`Expected an object from ${source}, but Odoo returned ${typeName(value)}.`);
}

// bin_size makes Odoo answer binary fields (images, attachments) with their size instead of megabytes of base64.
export function recordContext(context: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> {
  return { bin_size: true, ...context };
}
