import { logger } from '../utils/logger';

export interface McpToolResult {
  raw: unknown;
  text: string[];
  structured: unknown[];
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, any>; [key: string]: unknown };
}

export class SeamlessMcpError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'SeamlessMcpError';
  }
}

function parseJsonText(value: string): unknown | undefined {
  const text = value.trim();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch {}
  }
  const first = Math.min(...[text.indexOf('{'), text.indexOf('[')].filter(i => i >= 0));
  if (Number.isFinite(first)) {
    const candidate = text.slice(first);
    try { return JSON.parse(candidate); } catch {}
  }
  return undefined;
}

export async function readRpcResponse(response: Response, id: string): Promise<any> {
  if (!response.ok) throw new SeamlessMcpError(`HTTP_${response.status}`, `Seamless MCP HTTP ${response.status}${response.status === 403 ? ': check MCP scope and account access' : ''}`);
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const reader = response.body?.getReader();
    if (!reader) throw new SeamlessMcpError('INVALID_RESPONSE', 'Empty MCP stream');
    const decoder = new TextDecoder(); let buffer = '';
    try {
      while (true) {
        const {value, done} = await reader.read();
        buffer += decoder.decode(value, {stream: !done}).replace(/\r\n/g, '\n');
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = event.split('\n').filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const message = JSON.parse(data);
          if (message.id === id) return message;
        }
        if (buffer.length > 5000000) throw new SeamlessMcpError('INVALID_RESPONSE', 'MCP response too large');
        if (done) break;
      }
      throw new SeamlessMcpError('INVALID_RESPONSE', 'MCP stream ended before the response');
    } finally { await reader.cancel().catch(() => {}); }
  }
  const body: any = await response.json();
  if (body.id !== id) throw new SeamlessMcpError('INVALID_RESPONSE', 'MCP response ID mismatch');
  return body;
}

export class SeamlessMcpClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = process.env.SEAMLESS_MCP_BASE_URL?.trim() || 'https://mcp.seamless.ai/mcp',
    private readonly timeoutMs = Number(process.env.SEAMLESS_MCP_TIMEOUT_MS || 30000),
  ) {
    if (!apiKey) throw new Error('Missing required Seamless MCP API key');
  }

  private toolListCache: { expiresAt: number; tools: McpToolDefinition[] } | null = null;

  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Token: this.apiKey },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id }),
        signal: controller.signal,
      });
      const body = await readRpcResponse(response, id);
      if (body?.error) {
        throw new SeamlessMcpError(String(body.error.code ?? 'MCP_ERROR'), String(body.error.message ?? 'Seamless MCP request failed'), body.error.data);
      }
      return this.unwrapResult<T>(body?.result);
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new SeamlessMcpError('TIMEOUT', `Seamless MCP request timed out after ${this.timeoutMs}ms`);
      logger.warn('seamless.mcp.call_failed', { tool: name, message: error?.message || String(error) });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private unwrapResult<T>(result: any): T {
    if (!result) return result as T;
    if (result.isError) {
      const message = Array.isArray(result.content) ? result.content.map((x: any) => x?.text).filter(Boolean).join('\n') : 'Seamless MCP tool returned an error';
      throw new SeamlessMcpError('TOOL_ERROR', message || 'Seamless MCP tool returned an error');
    }
    return result as T;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    if (this.toolListCache && this.toolListCache.expiresAt > Date.now()) return this.toolListCache.tools;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Token: this.apiKey },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id }),
        signal: controller.signal,
      });
      const body = await readRpcResponse(response, id);
      if (body?.error) throw new SeamlessMcpError(String(body.error.code ?? 'MCP_ERROR'), String(body.error.message ?? 'Seamless MCP tools/list failed'), body.error.data);
      if (!Array.isArray(body?.result?.tools)) throw new SeamlessMcpError('INVALID_TOOLS_LIST', 'Seamless MCP tools/list returned no tool list');
      const tools = Array.isArray(body?.result?.tools) ? body.result.tools : [];
      this.toolListCache = { expiresAt: Date.now() + 300000, tools };
      return tools;
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new SeamlessMcpError('TIMEOUT', `Seamless MCP tools/list timed out after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async searchContacts(args: Record<string, unknown>): Promise<McpToolResult> {
    return this.callTool<McpToolResult>('search_contacts', args);
  }

  async researchContacts(args: Record<string, unknown>): Promise<McpToolResult> {
    return this.callTool<McpToolResult>('research_contacts', args);
  }

  async pollContactResearch(args: Record<string, unknown>): Promise<McpToolResult> {
    return this.callTool<McpToolResult>('poll_contact_research', args);
  }

  async getCredits(): Promise<McpToolResult> {
    return this.callTool<McpToolResult>('get_credits', {});
  }

  normalizeToolResult(result: any): McpToolResult {
    const text: string[] = [];
    const structured: unknown[] = [];
    for (const item of Array.isArray(result?.content) ? result.content : []) {
      if (typeof item?.text === 'string') text.push(item.text);
    }
    for (const value of [result?.structuredContent, result?.data, result?.result]) {
      if (value !== undefined) structured.push(value);
    }
    for (const t of text) {
      const parsed = parseJsonText(t);
      if (parsed !== undefined) structured.push(parsed);
    }
    return { raw: result, text, structured };
  }
}
