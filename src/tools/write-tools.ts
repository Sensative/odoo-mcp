import * as z from 'zod';

import { renderJson } from '../format.ts';
import { context, ids, method, model, values } from './schemas.ts';
import { ADDS, DELETES, OVERWRITES, RUNS_ANYTHING, textResult, type ToolRegistration } from './tool-kit.ts';

const RESERVED_ARGUMENTS = ['ids', 'context'];

export const create: ToolRegistration = (server, { odoo, config }) => {
  server.registerTool(
    'create',
    {
      title: 'Create records',
      description:
        'Create one record per entry of vals_list and return the new ids. ' +
        'Relational fields take ids (many2one) or commands such as [[4, id]] to link and [[0, 0, {…}]] to create a line (x2many).',
      inputSchema: z.object({
        model,
        vals_list: z.array(values).min(1).describe('One object of field values per record to create'),
        context,
      }),
      annotations: ADDS,
    },
    async ({ model, ...body }, ctx) => {
      const created = await odoo.call(model, 'create', body, ctx.mcpReq.signal);
      return textResult(renderJson({ ids: created }, config.maxResponseChars));
    },
  );
};

export const write: ToolRegistration = (server, { odoo, config }) => {
  server.registerTool(
    'write',
    {
      title: 'Update records',
      description: 'Set the same field values on every record with the given ids.',
      inputSchema: z.object({ model, ids, vals: values.describe('Field values to set'), context }),
      annotations: OVERWRITES,
    },
    async ({ model, ...body }, ctx) => {
      const result = await odoo.call(model, 'write', body, ctx.mcpReq.signal);
      return textResult(renderJson({ ids: body.ids, result }, config.maxResponseChars));
    },
  );
};

export const unlink: ToolRegistration = (server, { odoo, config }) => {
  server.registerTool(
    'unlink',
    {
      title: 'Delete records',
      description:
        'Permanently delete the records with the given ids. There is no undo; ' +
        'for records that have an `active` field, archiving them (write active: false) is usually what is wanted.',
      inputSchema: z.object({ model, ids, context }),
      annotations: DELETES,
    },
    async ({ model, ...body }, ctx) => {
      const result = await odoo.call(model, 'unlink', body, ctx.mcpReq.signal);
      return textResult(renderJson({ deleted_ids: body.ids, result }, config.maxResponseChars));
    },
  );
};

export const call: ToolRegistration = (server, { odoo, config }) => {
  server.registerTool(
    'call',
    {
      title: 'Call any model method',
      description:
        'Call a public method of a model: business actions such as action_confirm or action_post, copy, message_post, default_get, and so on. ' +
        'Arguments are passed by name in kwargs (the JSON-2 API has no positional arguments); list_methods shows a method’s parameter names. ' +
        'Pass ids to run the method on records; leave them out for model-level methods. ' +
        'Methods can change data, send mail and trigger other side effects, and every call commits on its own.',
      inputSchema: z.object({
        model,
        method,
        ids: z.array(z.number().int().positive()).optional().describe('Records to call the method on; leave out for model-level (@api.model) methods'),
        kwargs: values
          .default({})
          .refine((kwargs) => RESERVED_ARGUMENTS.every((name) => !(name in kwargs)), 'Pass ids and context in their own parameters, not inside kwargs')
          .describe('The method’s arguments by name, e.g. {"default": {"name": "Copy"}} for copy'),
        context,
      }),
      annotations: RUNS_ANYTHING,
    },
    async ({ model, method, ids, kwargs, context }, ctx) => {
      const result = await odoo.call(model, method, { ...kwargs, ids, context }, ctx.mcpReq.signal);
      return textResult(renderJson(result, config.maxResponseChars));
    },
  );
};
