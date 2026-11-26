import * as z from 'zod';

import { renderJson, renderList, renderMap, renderPage } from '../format.ts';
import { context, domain, fields, ids, limit, model, offset, order } from './schemas.ts';
import { expectList, expectRecord, READS, recordContext, textResult, type ToolRegistration } from './tool-kit.ts';

const DESCRIBED_ATTRIBUTES = ['string', 'type', 'required', 'readonly', 'relation', 'selection', 'help'];

export const searchRead: ToolRegistration = (server, { odoo, config }) => {
  server.registerTool(
    'search_read',
    {
      title: 'Search and read records',
      description:
        'Find the records of a model that match a domain and return the chosen fields, one page at a time. ' +
        'Many2one values come back as [id, display_name]; one2many and many2many values as lists of ids to read from the related model. ' +
        'When has_more is true, call again with offset set to next_offset.',
      inputSchema: z.object({ model, domain, fields, limit: limit(50, 500), offset, order, context }),
      annotations: READS,
    },
    async ({ model, limit, offset, context, ...query }, ctx) => {
      const body = { ...query, offset, limit: limit + 1, context: recordContext(context) };
      const rows = expectList(await odoo.call(model, 'search_read', body, ctx.mcpReq.signal), `${model}.search_read`);
      return textResult(renderPage('records', rows, { offset, limit }, config.maxResponseChars));
    },
  );
};

export const searchCount: ToolRegistration = (server, { odoo, config }) => {
  server.registerTool(
    'search_count',
    {
      title: 'Count records',
      description: 'Count the records of a model that match a domain.',
      inputSchema: z.object({ model, domain, context }),
      annotations: READS,
    },
    async ({ model, ...query }, ctx) => {
      const count = await odoo.call(model, 'search_count', query, ctx.mcpReq.signal);
      return textResult(renderJson({ count }, config.maxResponseChars));
    },
  );
};

export const read: ToolRegistration = (server, { odoo, config }) => {
  server.registerTool(
    'read',
    {
      title: 'Read records by id',
      description: 'Read the chosen fields of the records with the given ids, for example the ids found in a one2many field.',
      inputSchema: z.object({ model, ids, fields, context }),
      annotations: READS,
    },
    async ({ model, context, ...query }, ctx) => {
      const body = { ...query, context: recordContext(context) };
      const rows = expectList(await odoo.call(model, 'read', body, ctx.mcpReq.signal), `${model}.read`);
      return textResult(renderList('records', rows, config.maxResponseChars, 'Ask for fewer fields or fewer ids.'));
    },
  );
};

export const nameSearch: ToolRegistration = (server, { odoo, config }) => {
  server.registerTool(
    'name_search',
    {
      title: 'Find records by name',
      description:
        'Look records up by their display name and get [id, display_name] pairs back. ' +
        'The quick way to turn "the customer Acme" into the id a domain or a many2one value needs.',
      inputSchema: z.object({
        model,
        name: z.string().default('').describe('Text to look for in the display name'),
        domain,
        operator: z.string().default('ilike').describe('Comparison used on the name: ilike, =, like, =ilike, …'),
        limit: limit(20, 100),
        context,
      }),
      annotations: READS,
    },
    async ({ model, ...query }, ctx) => {
      const matches = await odoo.call(model, 'name_search', query, ctx.mcpReq.signal);
      return textResult(renderJson(matches, config.maxResponseChars));
    },
  );
};

export const formattedReadGroup: ToolRegistration = (server, { odoo, config }) => {
  server.registerTool(
    'formatted_read_group',
    {
      title: 'Group and aggregate records',
      description:
        'Aggregate the records that match a domain, grouped by one or more fields: totals per customer, counts per state, revenue per month. ' +
        'Replaces read_group, which Odoo 19 deprecates. Each group also carries __extra_domain, the domain that selects its records.',
      inputSchema: z.object({
        model,
        domain,
        groupby: z
          .array(z.string())
          .default([])
          .describe('Fields to group by, optionally with a date granularity: ["partner_id"], ["date_order:month"], ["state","user_id"]'),
        aggregates: z
          .array(z.string())
          .default(['__count'])
          .describe('Aggregates as "field:function": ["amount_total:sum","id:count_distinct"]; "__count" counts the records of each group'),
        having: z
          .array(z.unknown())
          .optional()
          .describe('Domain over the aggregates, e.g. [["amount_total:sum",">",10000]]'),
        limit: limit(80, 500),
        offset,
        order,
        context,
      }),
      annotations: READS,
    },
    async ({ model, limit, offset, ...query }, ctx) => {
      const body = { ...query, offset, limit: limit + 1 };
      const groups = expectList(await odoo.call(model, 'formatted_read_group', body, ctx.mcpReq.signal), `${model}.formatted_read_group`);
      return textResult(renderPage('groups', groups, { offset, limit }, config.maxResponseChars));
    },
  );
};

export const fieldsGet: ToolRegistration = (server, { odoo, config }) => {
  server.registerTool(
    'fields_get',
    {
      title: 'Describe the fields of a model',
      description:
        'Describe the fields of a model: label, type, related model, selection values, whether required or read-only. ' +
        'Look here before searching, creating or writing, to get field names and types right.',
      inputSchema: z.object({
        model,
        fields: z.array(z.string().min(1)).optional().describe('Describe only these fields; leave out for all of them'),
        attributes: z.array(z.string()).default(DESCRIBED_ATTRIBUTES).describe('Field attributes to include'),
        context,
      }),
      annotations: READS,
    },
    async ({ model, fields, ...query }, ctx) => {
      const body = { ...query, allfields: fields };
      const described = expectRecord(await odoo.call(model, 'fields_get', body, ctx.mcpReq.signal), `${model}.fields_get`);
      return textResult(renderMap('fields', described, config.maxResponseChars, 'Pass `fields` to describe only the ones you need.'));
    },
  );
};
