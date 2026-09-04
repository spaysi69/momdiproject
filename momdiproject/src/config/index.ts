import fs from 'node:fs';
import path from 'node:path';
import { ServiceConfigSchema } from './schema';
export function loadConfig(configPath = path.join(process.cwd(), 'config.json')) {
  if (!fs.existsSync(configPath)) throw new Error(`Config file not found: ${configPath}`);
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const parsed = ServiceConfigSchema.safeParse({ ...raw, mcpBaseUrl: process.env.SEAMLESS_MCP_BASE_URL?.trim() || raw.mcpBaseUrl });
  if (!parsed.success) throw new Error(`Invalid config: ${parsed.error.message}`);
  return parsed.data;
}
