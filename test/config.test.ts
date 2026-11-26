import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, DEFAULT_ODOO_URL, loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  it('targets the Sensative instance with safe limits when nothing is set', () => {
    assert.deepEqual(loadConfig({}), {
      baseUrl: 'https://sensative.implefy.cloud',
      apiKey: undefined,
      database: undefined,
      readOnly: false,
      timeoutMs: 30_000,
      maxResponseChars: 40_000,
    });
    assert.equal(DEFAULT_ODOO_URL, 'https://sensative.implefy.cloud');
  });

  it('reads every setting from the environment', () => {
    const config = loadConfig({
      ODOO_URL: 'https://erp.example.com',
      ODOO_API_KEY: '  secret-key  ',
      ODOO_DB: 'prod',
      ODOO_READONLY: '1',
      ODOO_TIMEOUT_MS: '5000',
      ODOO_MAX_RESPONSE_CHARS: '2000',
    });
    assert.deepEqual(config, {
      baseUrl: 'https://erp.example.com',
      apiKey: 'secret-key',
      database: 'prod',
      readOnly: true,
      timeoutMs: 5000,
      maxResponseChars: 2000,
    });
  });

  it('treats blank values as unset', () => {
    const config = loadConfig({ ODOO_URL: ' ', ODOO_API_KEY: '', ODOO_DB: '  ', ODOO_TIMEOUT_MS: '' });
    assert.equal(config.baseUrl, DEFAULT_ODOO_URL);
    assert.equal(config.apiKey, undefined);
    assert.equal(config.database, undefined);
    assert.equal(config.timeoutMs, 30_000);
  });
});

describe('a host that passes its config file through unexpanded', () => {
  it('treats "${NAME}" as unset rather than sending it to Odoo as the key', () => {
    const config = loadConfig({ ODOO_API_KEY: '${ODOO_API_KEY}', ODOO_URL: '${ODOO_URL}', ODOO_DB: ' ${ODOO_DB} ' });

    assert.equal(config.apiKey, undefined);
    assert.equal(config.baseUrl, DEFAULT_ODOO_URL);
    assert.equal(config.database, undefined);
  });

  it('still refuses an unexpanded read-only switch, since guessing could allow writes', () => {
    assert.throws(() => loadConfig({ ODOO_READONLY: '${ODOO_READONLY}' }), ConfigError);
  });
});

describe('ODOO_URL', () => {
  const cases: ReadonlyArray<readonly [input: string, expected: string]> = [
    ['sensative.implefy.cloud/odoo', 'https://sensative.implefy.cloud'],
    ['https://sensative.implefy.cloud/odoo/action-123/7?debug=1#x', 'https://sensative.implefy.cloud'],
    ['https://sensative.implefy.cloud/web/login', 'https://sensative.implefy.cloud'],
    ['https://sensative.implefy.cloud///', 'https://sensative.implefy.cloud'],
    ['https://example.com/erp/', 'https://example.com/erp'],
    ['https://example.com/erp/odoo/action-1', 'https://example.com/erp'],
    ['https://user:pass@example.com:8443/', 'https://example.com:8443'],
    ['http://127.0.0.1:8069/', 'http://127.0.0.1:8069'],
    ['http://localhost:8069/odoo', 'http://localhost:8069'],
    ['http://odoo.localhost:8069', 'http://odoo.localhost:8069'],
    ['http://[::1]:8069', 'http://[::1]:8069'],
  ];
  for (const [input, expected] of cases) {
    it(`normalises ${input}`, () => {
      assert.equal(loadConfig({ ODOO_URL: input }).baseUrl, expected);
    });
  }

  it('refuses to send the API key over plain http to a remote host', () => {
    assert.throws(() => loadConfig({ ODOO_URL: 'http://sensative.implefy.cloud' }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /ODOO_URL/);
      assert.match(error.message, /https/);
      assert.match(error.message, /ODOO_ALLOW_INSECURE_HTTP/);
      return true;
    });
  });

  it('allows plain http to a remote host only when explicitly opted in', () => {
    const config = loadConfig({ ODOO_URL: 'http://odoo:8069', ODOO_ALLOW_INSECURE_HTTP: 'true' });
    assert.equal(config.baseUrl, 'http://odoo:8069');
  });

  for (const bad of ['ftp://example.com', 'https://', 'https://exa mple.com']) {
    it(`rejects ${bad}`, () => {
      assert.throws(() => loadConfig({ ODOO_URL: bad }), ConfigError);
    });
  }
});

describe('ODOO_READONLY', () => {
  for (const on of ['1', 'true', 'TRUE', 'Yes', 'on', ' 1 ']) {
    it(`"${on}" switches writes off`, () => {
      assert.equal(loadConfig({ ODOO_READONLY: on }).readOnly, true);
    });
  }
  for (const off of ['0', 'false', 'No', 'off', '']) {
    it(`"${off}" leaves writes on`, () => {
      assert.equal(loadConfig({ ODOO_READONLY: off }).readOnly, false);
    });
  }

  it('fails loudly on a value it cannot read instead of silently allowing writes', () => {
    assert.throws(() => loadConfig({ ODOO_READONLY: 'enabled' }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /ODOO_READONLY/);
      assert.match(error.message, /enabled/);
      return true;
    });
  });
});

describe('numeric limits', () => {
  for (const bad of ['abc', '0', '-5', '1.5', '10s']) {
    it(`rejects ODOO_TIMEOUT_MS=${bad}`, () => {
      assert.throws(() => loadConfig({ ODOO_TIMEOUT_MS: bad }), /ODOO_TIMEOUT_MS/);
    });
  }

  it('keeps the response cap large enough to hold its own truncation notice', () => {
    assert.throws(() => loadConfig({ ODOO_MAX_RESPONSE_CHARS: '999' }), /ODOO_MAX_RESPONSE_CHARS/);
    assert.equal(loadConfig({ ODOO_MAX_RESPONSE_CHARS: '1000' }).maxResponseChars, 1000);
  });
});
