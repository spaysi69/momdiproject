import fs from 'node:fs';
import path from 'node:path';
import { ServiceConfig, ServiceConfigSchema } from './schema';

export function loadConfig(configPath = path.join(process.cwd(), 'config.json')): ServiceConfig {
  if (!fs.existsSync(configPath)) throw new Error(`Config file not found: ${configPath}`);
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const withOverrides = {
    ...raw,
    providerBaseUrl: process.env.PROVIDER_BASE_URL?.trim() || raw.providerBaseUrl,
  };
  const parsed = ServiceConfigSchema.safeParse(withOverrides);
  if (!parsed.success) throw new Error(`Invalid config: ${parsed.error.message}`);
  return parsed.data;
}
