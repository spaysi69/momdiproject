import fs from 'node:fs';
import path from 'node:path';
import { AppConfigSchema, RouteConfigSchema, type AppConfig, type RouteConfig, type RouteOverride } from './schema.js';

const LEGACY_ENV_PATTERN = /^SEAMLESS_API_KEY_(PRIMARY|SECONDARY)$/;
const NUMERIC_SUFFIX_PATTERN = /^(\d{1,4})$/;

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  return fallback;
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function envNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function discoveredCredentialEnvNames(prefix: string, numericSuffixOnly: boolean): string[] {
  return Object.keys(process.env)
    .filter(name => name.startsWith(prefix) && Boolean(process.env[name]?.trim()))
    .filter(name => {
      const suffix = name.slice(prefix.length);
      return numericSuffixOnly ? NUMERIC_SUFFIX_PATTERN.test(suffix) : Boolean(suffix);
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function suffixId(envName: string, prefix: string): string {
  return envName.slice(prefix.length) || envName;
}

function buildDiscoveredRoute(envName: string, app: AppConfig, overrides: RouteOverride[]): RouteConfig {
  const prefix = app.credentialDiscovery.envPrefix;
  const id = suffixId(envName, prefix);
  const override = overrides.find(item => item.id === id || item.apiKeyEnv === envName);
  const safeId = override?.id ?? id.toLowerCase();
  const idToken = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const rpm = envPositiveInt(`SEAMLESS_ROUTE_${idToken}_RPM`, override?.limits?.rpm ?? app.credentialDiscovery.defaultLimits.rpm);
  const rpd = envPositiveInt(`SEAMLESS_ROUTE_${idToken}_RPD`, override?.limits?.rpd ?? app.credentialDiscovery.defaultLimits.rpd);
  const priority = envNonNegativeInt(`SEAMLESS_ROUTE_${idToken}_PRIORITY`, override?.priority ?? app.credentialDiscovery.defaultPriority);
  const enabled = envBool(`SEAMLESS_ROUTE_${idToken}_ENABLED`, override?.enabled ?? app.credentialDiscovery.defaultEnabled);
  const expectedEgressIp = process.env[`SEAMLESS_ROUTE_${idToken}_EXPECTED_IP`]?.trim() || override?.expectedEgressIp;
  const networkLabel = process.env[`SEAMLESS_ROUTE_${idToken}_NETWORK_LABEL`]?.trim() || override?.networkLabel;

  const parsed = RouteConfigSchema.parse({
    id: safeId,
    apiKeyEnv: envName,
    limits: { rpm, rpd },
    priority,
    enabled,
    expectedEgressIp,
    networkLabel,
  });
  return parsed;
}

export function loadConfig(filePath = path.resolve(process.cwd(), 'routes.config.json')): AppConfig {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid routes.config.json: ${parsed.error.message}`);
  const base = {
    ...parsed.data,
    network: {
      ...parsed.data.network,
      egressIpCheckUrl: (() => {
        const candidate = process.env.EGRESS_IP_CHECK_URL?.trim();
        if (!candidate) return parsed.data.network.egressIpCheckUrl;
        try { new URL(candidate); return candidate; } catch { throw new Error(`Invalid EGRESS_IP_CHECK_URL: ${candidate}`); }
      })(),
    },
  };
  const prefix = base.credentialDiscovery.envPrefix;
  const discovered = discoveredCredentialEnvNames(prefix, base.credentialDiscovery.numericSuffixOnly);
  const overrides = base.routes;

  if (discovered.length > 0) {
    const routes = discovered.map(name => buildDiscoveredRoute(name, base, overrides));
    return { ...base, routes };
  }

  // Backward compatibility for the old PRIMARY/SECONDARY environment variables.
  const legacy = Object.keys(process.env).filter(name => LEGACY_ENV_PATTERN.test(name) && Boolean(process.env[name]?.trim()));
  if (legacy.length > 0) {
    const routes = legacy.map(envName => {
      const suffix = envName.replace('SEAMLESS_API_KEY_', '').toLowerCase();
      const override = overrides.find(item => item.id === suffix || item.apiKeyEnv === envName);
      return RouteConfigSchema.parse({
        id: override?.id ?? suffix,
        apiKeyEnv: envName,
        limits: override?.limits ?? base.credentialDiscovery.defaultLimits,
        priority: override?.priority ?? base.credentialDiscovery.defaultPriority,
        enabled: override?.enabled ?? base.credentialDiscovery.defaultEnabled,
        expectedEgressIp: override?.expectedEgressIp,
        networkLabel: override?.networkLabel,
      });
    });
    return { ...base, routes };
  }

  if (overrides.length > 0) {
    return { ...base, routes: overrides.map(route => RouteConfigSchema.parse(route)) };
  }

  throw new Error(`No Seamless credentials found. Configure at least one ${prefix}<id> environment variable.`);
}
