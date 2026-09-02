import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './loader.js';

const originalEnv = { ...process.env };

describe('config loader', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SEAMLESS_API_KEY_') || key.startsWith('SEAMLESS_ROUTE_')) delete process.env[key];
    }
  });

  afterEach(() => { process.env = { ...originalEnv }; });

  it('discovers an arbitrary number of numbered credentials without config edits', () => {
    process.env.SEAMLESS_API_KEY_01 = 'test-1';
    process.env.SEAMLESS_API_KEY_02 = 'test-2';
    process.env.SEAMLESS_API_KEY_11 = 'test-11';
    process.env.SEAMLESS_ROUTE_02_RPM = '30';
    process.env.SEAMLESS_ROUTE_02_RPD = '500';
    process.env.SEAMLESS_ROUTE_02_PRIORITY = '50';
    process.env.SEAMLESS_ROUTE_02_EXPECTED_IP = '203.0.113.12';

    const config = loadConfig();
    expect(config.routes.map(r => r.id)).toEqual(['01', '02', '11']);
    expect(config.routes[1]?.limits).toEqual({ rpm: 30, rpd: 500 });
    expect(config.routes[1]?.priority).toBe(50);
    expect(config.routes[1]?.expectedEgressIp).toBe('203.0.113.12');
  });

  it('supports per-credential enabled and priority overrides', () => {
    process.env.SEAMLESS_API_KEY_01 = 'test-1';
    process.env.SEAMLESS_ROUTE_01_ENABLED = 'false';
    process.env.SEAMLESS_ROUTE_01_PRIORITY = '77';

    const config = loadConfig();
    expect(config.routes[0]?.enabled).toBe(false);
    expect(config.routes[0]?.priority).toBe(77);
  });

  it('ignores unrelated environment variables and trims empty credentials', () => {
    process.env.SEAMLESS_API_KEY_01 = '  ';
    process.env.SEAMLESS_API_KEY_02 = 'test-2';
    process.env.SEAMLESS_API_KEY_EXTRA = 'not-discovered';

    const config = loadConfig();
    expect(config.routes.map(r => r.id)).toEqual(['02']);
  });
});
