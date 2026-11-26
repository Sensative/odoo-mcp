import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { htmlToText, renderJson, renderList, renderMap, renderPage } from '../src/format.ts';

const ROOMY = 100_000;

function partner(id: number, padding = 0): { id: number; name: string } {
  return { id, name: `Partner ${id}${'x'.repeat(padding)}` };
}

describe('renderJson', () => {
  it('renders compact JSON', () => {
    assert.equal(renderJson({ ids: [1, 2], ok: true }, ROOMY), '{"ids":[1,2],"ok":true}');
  });

  it('renders a missing value as null', () => {
    assert.equal(renderJson(undefined, ROOMY), 'null');
  });

  it('cuts an oversized result and says the call itself went through', () => {
    const text = renderJson({ blob: 'y'.repeat(5000) }, 1000);

    assert.ok(text.startsWith('{"blob":"yyyy'));
    assert.match(text, /truncated/);
    assert.match(text, /5011 characters/);
    assert.match(text, /ODOO_MAX_RESPONSE_CHARS/);
    assert.match(text, /call itself completed/);
    assert.ok(text.length < 1400);
  });
});

describe('renderPage', () => {
  it('puts one record per line and reports that nothing is left', () => {
    const text = renderPage('records', [partner(1), partner(2)], { offset: 0, limit: 50 }, ROOMY);

    assert.equal(
      text,
      '{"records":[\n{"id":1,"name":"Partner 1"},\n{"id":2,"name":"Partner 2"}\n],"returned":2,"offset":0,"has_more":false}',
    );
    assert.deepEqual(JSON.parse(text).records, [partner(1), partner(2)]);
  });

  it('renders an empty page', () => {
    assert.equal(
      renderPage('records', [], { offset: 20, limit: 10 }, ROOMY),
      '{"records":[],"returned":0,"offset":20,"has_more":false}',
    );
  });

  it('uses the extra row fetched beyond the limit to tell that more exist', () => {
    const page = JSON.parse(renderPage('records', [partner(1), partner(2), partner(3)], { offset: 10, limit: 2 }, ROOMY));

    assert.deepEqual(page.records, [partner(1), partner(2)]);
    assert.equal(page.returned, 2);
    assert.equal(page.has_more, true);
    assert.equal(page.next_offset, 12);
    assert.equal(page.truncated, undefined);
  });

  it('keeps whole records only when the response cap is reached', () => {
    const rows = Array.from({ length: 30 }, (_, index) => partner(index + 1, 100));

    const text = renderPage('records', rows, { offset: 0, limit: 50 }, 1500);
    const page = JSON.parse(text);

    assert.ok(text.length <= 1500, `response is ${text.length} characters`);
    assert.ok(page.returned > 0 && page.returned < 30);
    assert.deepEqual(page.records, rows.slice(0, page.returned));
    assert.equal(page.has_more, true);
    assert.equal(page.next_offset, page.returned);
    assert.match(page.truncated, new RegExp(`Only ${page.returned} of the 30 fetched records fit`));
    assert.match(page.truncated, /fewer fields/);
  });

  it('says so when even the first record is too large', () => {
    const page = JSON.parse(renderPage('records', [partner(1, 5000)], { offset: 4, limit: 50 }, 1000));

    assert.deepEqual(page.records, []);
    assert.equal(page.returned, 0);
    assert.equal(page.has_more, true);
    assert.equal(page.next_offset, 4);
    assert.match(page.truncated, /first of the fetched records alone exceeds/);
  });
});

describe('renderList', () => {
  it('reports how many items there are', () => {
    assert.equal(
      renderList('methods', [{ name: 'read' }, { name: 'write' }], ROOMY, 'Pass query.'),
      '{"methods":[\n{"name":"read"},\n{"name":"write"}\n],"returned":2,"total":2}',
    );
  });

  it('explains how to narrow a list that does not fit', () => {
    const items = Array.from({ length: 40 }, (_, index) => partner(index, 80));

    const list = JSON.parse(renderList('methods', items, 1200, 'Pass query to narrow the list.'));

    assert.equal(list.total, 40);
    assert.ok(list.returned < 40);
    assert.equal(list.methods.length, list.returned);
    assert.match(list.truncated, /Pass query to narrow the list\./);
  });
});

describe('renderMap', () => {
  it('puts one entry per line', () => {
    assert.equal(
      renderMap('fields', { name: { type: 'char' }, email: { type: 'char' } }, ROOMY, 'Pass fields.'),
      '{"fields":{\n"name":{"type":"char"},\n"email":{"type":"char"}\n},"returned":2,"total":2}',
    );
  });

  it('renders an empty map', () => {
    assert.equal(renderMap('fields', {}, ROOMY, 'Pass fields.'), '{"fields":{},"returned":0,"total":0}');
  });

  it('keeps whole entries only when the response cap is reached', () => {
    const entries = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`field_${index}`, { help: 'h'.repeat(60) }]));

    const text = renderMap('fields', entries, 1500, 'Pass fields to pick the ones you need.');
    const map = JSON.parse(text);

    assert.ok(text.length <= 1500);
    assert.equal(map.total, 60);
    assert.equal(Object.keys(map.fields).length, map.returned);
    assert.deepEqual(Object.keys(map.fields)[0], 'field_0');
    assert.match(map.truncated, /Pass fields to pick the ones you need\./);
  });
});

describe('htmlToText', () => {
  it('turns Odoo’s rendered docstrings back into plain text', () => {
    const html =
      '<p>Search for records &amp; read them.</p>\n<ul class="simple">\n<li><tt class="docutils literal">domain</tt> &lt;list&gt;</li>\n' +
      '<li>fields&nbsp;to read</li>\n</ul>\n<p>Returns a &quot;list&quot; of dicts&#44; one per record&#x21;</p>';

    assert.equal(
      htmlToText(html),
      'Search for records & read them.\n\ndomain <list>\nfields to read\n\nReturns a "list" of dicts, one per record!',
    );
  });

  it('does not decode an escaped entity twice', () => {
    assert.equal(htmlToText('<p>&amp;lt;b&amp;gt;</p>'), '&lt;b&gt;');
  });

  it('keeps entities it does not know', () => {
    assert.equal(htmlToText('caf&eacute; &#x110000; &#99999999999; &copy'), 'caf&eacute; &#x110000; &#99999999999; &copy');
  });

  it('leaves plain text alone', () => {
    assert.equal(htmlToText('  already plain  '), 'already plain');
  });
});

describe('htmlToText on code samples', () => {
  it('keeps the line breaks and indentation of preformatted blocks', () => {
    const html = '<p>Example:</p>\n<pre class="code python literal-block">\nrecords = self.search([])\nfor record in records:\n    record.name\n</pre>\n<p>Done.</p>';

    assert.equal(htmlToText(html), 'Example:\n\nrecords = self.search([])\nfor record in records:\n    record.name\n\nDone.');
  });
});
