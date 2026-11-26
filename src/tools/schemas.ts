import * as z from 'zod';

export const model = z
  .string()
  .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/i, 'Model names look like "res.partner"')
  .describe('Technical model name, e.g. res.partner, sale.order, product.product, account.move, stock.picking');

export const method = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/i, 'Only public methods can be called: letters, digits and underscores, not starting with an underscore')
  .describe('Public method name, e.g. action_confirm, copy, message_post');

export const domain = z
  .array(z.unknown())
  .default([])
  .describe(
    'Search domain in Odoo prefix notation, e.g. [["state","=","sale"],["partner_id.name","ilike","acme"]]. ' +
      '"|" and "!" are prefix operators; [] matches every record.',
  );

export const context = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'Odoo context for this call, e.g. {"lang":"sv_SE","allowed_company_ids":[1],"active_test":false} ' +
      '(active_test false includes archived records)',
  );

export const ids = z.array(z.number().int().positive()).min(1).describe('Record ids');

export const fields = z
  .array(z.string().min(1))
  .optional()
  .describe('Field names to return. Always pass them: without, Odoo returns every field of each record.');

export const offset = z.number().int().min(0).default(0).describe('Rows to skip; pass next_offset from the previous page');

export const order = z.string().optional().describe('Sort order, e.g. "date_order desc, id"');

export const values = z.record(z.string(), z.unknown());

export function limit(byDefault: number, atMost: number) {
  return z.number().int().min(1).max(atMost).default(byDefault).describe(`Maximum number of rows to return (1-${atMost})`);
}
