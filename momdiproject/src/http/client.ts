import axios, { AxiosError, AxiosInstance } from 'axios';
import { z } from 'zod';
import { EnrichmentResponse } from '../core/types';
import { normalizePhone, normalizePhoneList } from '../utils/normalizePhone';


export interface SeamlessMcpClientOptions {
  endpoint: string;
  token: string;
  timeoutMs: number;
}

function parseMcpPayload(payload: any): any {
  if (payload?.result?.structuredContent) return payload.result.structuredContent;
  if (payload?.result?.data) return payload.result.data;
  if (payload?.result?.results) return payload.result.results;
  const content = payload?.result?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const text = typeof item?.text === 'string' ? item.text.trim() : '';
      if (!text) continue;
      try { return JSON.parse(text); } catch {}
      const jsonStart = Math.min(...[text.indexOf('{'), text.indexOf('[')].filter(v => v >= 0));
      if (Number.isFinite(jsonStart) && jsonStart >= 0) {
        try { return JSON.parse(text.slice(jsonStart)); } catch {}
      }
    }
  }
  return payload?.result ?? payload;
}

function collectRecords(value: any, out: Record<string, any>[] = [], depth = 0): Record<string, any>[] {
  if (depth > 8 || value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectRecords(item, out, depth + 1);
    return out;
  }
  if (typeof value !== 'object') return out;
  const interesting = ['searchResultId','lIProfileUrl','liProfileUrl','liUrl','linkedinUrl','fullName','name','company','companyName','title'];
  if (interesting.some(k => value[k] !== undefined)) out.push(value);
  for (const [key, child] of Object.entries(value)) {
    if (['metadata','schema','inputSchema'].includes(key)) continue;
    if (child && typeof child === 'object') collectRecords(child, out, depth + 1);
  }
  return out;
}

export class SeamlessMcpClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  constructor(options: SeamlessMcpClientOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
  }

  private async call(method: string, params: any): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Token: this.token },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: any;
      try { payload = JSON.parse(text); } catch { throw new Error(`Seamless MCP returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`); }
      if (!response.ok) {
        const hint = response.status === 401 || response.status === 403 ? ' Your API key must have Seamless MCP scope enabled.' : '';
        throw Object.assign(new Error(`Seamless MCP HTTP ${response.status}: ${text.slice(0, 500)}${hint}`), { response: { status: response.status, data: payload } });
      }
      if (payload?.error) throw Object.assign(new Error(payload.error.message || 'Seamless MCP returned an error'), { response: { status: 400, data: payload.error } });
      return parseMcpPayload(payload);
    } finally {
      clearTimeout(timer);
    }
  }

  async listTools(): Promise<any> { return this.call('tools/list', {}); }

  private findTool(value: any, toolName: string, depth = 0): any {
    if (depth > 8 || value == null) return null;
    if (Array.isArray(value)) {
      for (const item of value) { const found = this.findTool(item, toolName, depth + 1); if (found) return found; }
      return null;
    }
    if (typeof value !== 'object') return null;
    if (value.name === toolName) return value;
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') { const found = this.findTool(child, toolName, depth + 1); if (found) return found; }
    }
    return null;
  }

  async searchContactsByLinkedInUrl(linkedinUrl: string, limit = 50): Promise<ContactSearchResult> {
    const normalized = linkedinUrl.trim().toLowerCase().replace(/\/$/, '');
    const slug = normalized.split('/in/')[1]?.split('/')[0] ?? '';
    if (!slug) throw new Error('Invalid LinkedIn profile URL.');

    let tools: any;
    try { tools = await this.listTools(); }
    catch (error: any) {
      throw new Error(`Seamless MCP search is unavailable: ${providerErrorMessage(error)}. Make sure MCP access is enabled for the API key.`);
    }
    const tool = this.findTool(tools, 'search_contacts');
    if (!tool) throw new Error('Seamless MCP is connected, but the search_contacts tool is not available for this account.');

    const props = tool.inputSchema?.properties ?? {};
    const humanName = slug.replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
    const searches: Record<string, unknown>[] = [];
    const base = () => ({ ...(props.limit ? { limit: Math.min(Math.max(1, limit), 50) } : {}), ...(props.nextToken ? { nextToken: null } : {}) });
    if (props.fullName) searches.push({ ...base(), fullName: props.fullName.type === 'array' ? [humanName] : humanName });
    if (props.contactKeyword) searches.push({ ...base(), contactKeyword: props.contactKeyword.type === 'array' ? [slug] : slug });
    if (props.query) searches.push({ ...base(), query: humanName || slug });
    if (!searches.length) throw new Error('Seamless MCP search_contacts does not expose a supported name/keyword search field for this account.');

    const results = await Promise.allSettled(searches.map(args => this.call('tools/call', { name: 'search_contacts', arguments: args })));
    const providerErrors: unknown[] = [];
    for (const result of results) {
      if (result.status !== 'fulfilled') { providerErrors.push(result.reason); continue; }
      const records = collectRecords(result.value);
      const match = records.find((item: any) => {
        const candidate = firstString(item.lIProfileUrl, item.liProfileUrl, item.liUrl, item.linkedinUrl, item.linkedin_url);
        return candidate ? candidate.trim().toLowerCase().replace(/\/$/, '') === normalized : false;
      });
      if (match) return match as ContactSearchResult;
    }
    const firstError = providerErrors[0];
    if (firstError) throw new Error(`Seamless MCP search failed: ${providerErrorMessage(firstError)}`);
    throw new Error('Seamless MCP search did not return an exact match for this LinkedIn profile. No research credit was consumed.');
  }

  async getCredits(): Promise<number | null> {
    const result = await this.call('tools/call', { name: 'get_credits', arguments: {} });
    const values = collectRecords(result);
    for (const item of values) {
      for (const key of ['remaining','creditsRemaining','available','balance','universalCredits','universalCreditsRemaining']) {
        const n = Number(item[key]);
        if (Number.isFinite(n) && n >= 0) return Math.floor(n);
      }
    }
    const text = JSON.stringify(result);
    const match = text.match(/(?:remaining|available|balance|creditsRemaining|universalCreditsRemaining|credits)\D{0,20}(\d+)/i);
    return match ? Number(match[1]) : null;
  }
}

const ResearchAcceptedSchema = z.object({
  success: z.boolean().optional(),
  requestIds: z.array(z.union([z.string(), z.number()])).min(1).optional(),
  data: z.any().optional(),
}).passthrough();

const PollEnvelopeSchema = z.any();

const SearchResultSchema = z.record(z.string(), z.any());
const SearchEnvelopeSchema = z.object({
  data: z.array(SearchResultSchema).default([]),
  supplementalData: z.object({
    isMore: z.boolean().optional(),
    total: z.number().optional(),
    perPage: z.number().optional(),
    nextToken: z.string().nullable().optional(),
  }).optional(),
});

export interface SeamlessClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  pollIntervalMs: number;
  maxPolls: number;
  proxyUrl?: string;
  onProviderCredits?: (remaining: number) => Promise<void> | void;
}

export interface CompanySearchResult {
  searchResultId?: string;
  name?: string;
  domain?: string;
  description?: string;
  liUrl?: string;
  companyLIURL?: string;
  companyLinkedInUrl?: string;
  staffCount?: string | number;
  staffCountRange?: string;
  employeeCount?: string | number;
  numContacts?: string | number;
  industry?: string;
  industries?: string[];
  country?: string;
  city?: string;
  state?: string;
  [key: string]: unknown;
}

export interface ContactSearchResult {
  searchResultId: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  department?: string;
  seniority?: string;
  domain?: string;
  liUrl?: string;
  companyLIProfileUrl?: string;
  companyDomainAlias?: string;
  city?: string;
  state?: string;
  country?: string;
  [key: string]: unknown;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = stringOrUndefined(value);
    if (result) return result;
  }
  return undefined;
}

function mapContact(contact: Record<string, any>, fallbackLinkedInUrl?: string, extra?: Record<string, unknown>): EnrichmentResponse {
  const firstName = firstString(contact.firstName, contact.first_name);
  const lastName = firstString(contact.lastName, contact.last_name);
  const fullName = firstString(contact.fullName, contact.full_name, contact.name) ?? ([firstName, lastName].filter(Boolean).join(' ') || undefined);
  const linkedinUrl = firstString(contact.lIProfileUrl, contact.liProfileUrl, contact.linkedinUrl, contact.linkedin_url, fallbackLinkedInUrl);

  return {
    id: firstString(contact.contactId, contact.id),
    fullName,
    firstName,
    lastName,
    title: firstString(contact.title, contact.jobTitle),
    company: firstString(contact.company, contact.companyName),
    email: firstString(contact.email, contact.email1),
    phone: normalizePhone(firstString(contact.contactPhone1, contact.phone)),
    linkedinUrl: linkedinUrl ?? '',
    department: firstString(contact.department),
    seniority: firstString(contact.seniority),
    alternateEmails: [contact.email2, contact.email3, contact.personalEmail].map(stringOrUndefined).filter((v): v is string => Boolean(v)),
    alternatePhones: normalizePhoneList([contact.contactPhone2, contact.companyPhone1, contact.companyPhone2, contact.companyPhone3]),
    companyDomain: firstString(contact.companyDomain, contact.website, contact.companyWebsite),
    companyLinkedInUrl: firstString(contact.companyLIProfileUrl, contact.companyLinkedInUrl),
    contactLocation: contact.contactLocation && typeof contact.contactLocation === 'object' ? contact.contactLocation : undefined,
    companyLocation: contact.companyLocation && typeof contact.companyLocation === 'object' ? contact.companyLocation : undefined,
    raw: { ...contact, ...(extra ?? {}) },
  };
}

function readPollResult(payload: unknown): { status: string; message?: string; contact?: Record<string, any>; additionalData?: unknown } {
  const root: any = payload;
  const candidates: any[] = [];

  const visit = (value: any, depth = 0) => {
    if (value === null || value === undefined || depth > 5) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;

    if (value.status !== undefined || value.state !== undefined || value.contact !== undefined || value.result !== undefined) {
      candidates.push(value);
    }
    if (value.data !== undefined) visit(value.data, depth + 1);
    if (value.results !== undefined) visit(value.results, depth + 1);
    if (value.result !== undefined) visit(value.result, depth + 1);
  };

  visit(root);

  const result = candidates.find((item: any) => item && typeof item === 'object');
  if (!result) throw new Error('Seamless returned an unreadable research poll response');

  const status = String(result.status ?? result.state ?? '').trim().toLowerCase();
  const message = firstString(result.message, result.msg, result.errorMessage, result.error);

  let contact: any = result.contact ?? result.contactData ?? result.contact_data;
  if (!contact && result.result !== undefined) {
    if (Array.isArray(result.result)) contact = result.result[0];
    else if (result.result && typeof result.result === 'object') {
      contact = result.result.contact ?? result.result.contactData ?? result.result.contact_data ?? result.result.data ?? result.result;
    }
  }
  if (!contact && result.data !== undefined) {
    if (Array.isArray(result.data)) contact = result.data[0];
    else if (result.data && typeof result.data === 'object') {
      contact = result.data.contact ?? result.data.contactData ?? result.data.contact_data ?? result.data;
    }
  }
  if (Array.isArray(contact)) contact = contact[0];

  const mappedContact = contact && typeof contact === 'object' ? contact as Record<string, any> : undefined;
  return {
    status,
    message,
    contact: mappedContact,
    additionalData: result.additionalData ?? result.additional_data,
  };
}

function extractRequestId(payload: unknown): string {
  const root:any = payload;
  const ids = Array.isArray(root?.requestIds) ? root.requestIds : [];
  const directId = root?.requestId ?? root?.researchId ?? root?.apiResearchId;
  if ((typeof directId === 'string' && directId.trim()) || (typeof directId === 'number' && Number.isFinite(directId))) return String(directId);
  const first = ids.find((v:any) => (typeof v === 'string' && v.trim()) || (typeof v === 'number' && Number.isFinite(v)));
  if (first !== undefined) return String(first);
  const nested = Array.isArray(root?.data) ? root.data : (root?.data ? [root.data] : []);
  for (const item of nested) {
    const id = item?.requestId ?? item?.researchId ?? item?.apiResearchId;
    if ((typeof id === 'string' && id.trim()) || (typeof id === 'number' && Number.isFinite(id))) return String(id);
  }
  throw new Error('Seamless accepted the research request but did not return a request ID');
}

function researchComplete(status: string): boolean {
  return new Set(['done','duplicate','complete','completed','success','succeeded','finished','ready']).has(status);
}
function researchFailed(status: string): boolean {
  return new Set(['missing','not_found','notfound','error','failed','failure']).has(status);
}

function providerErrorMessage(error: AxiosError | { data?: unknown; message?: string }): string {
  const body = (error as any).response?.data ?? (error as any).data;
  if (body && typeof body === 'object') {
    return String((body as any).msg ?? (body as any).message ?? (body as any).error ?? (error as any).message ?? 'Provider request failed');
  }
  return (error as any).message ?? 'Provider request failed';
}

export class SeamlessClient {
  private readonly client: AxiosInstance;
  constructor(private readonly options: SeamlessClientOptions) {
    const proxy = options.proxyUrl ? (() => {
      try {
        const u = new URL(options.proxyUrl);
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP(S) proxy URLs are supported.');
        return { protocol: u.protocol.replace(':', ''), host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), auth: u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : undefined };
      } catch (error: any) {
        throw new Error(`Invalid proxy configuration: ${error?.message || 'invalid URL'}`);
      }
    })() : undefined;
    this.client = axios.create({
      baseURL: options.baseUrl.replace(/\/$/, ''),
      timeout: options.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        Token: options.apiKey,
      },
      proxy,
      validateStatus: () => true,
    });
  }

  private async captureProviderHeaders(response: any): Promise<number | undefined> {
    const raw = response?.headers?.['x-publicapi-credits'] ?? response?.headers?.get?.('x-publicapi-credits');
    if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
    const value = Number(String(raw).trim());
    if (!Number.isFinite(value) || value < 0) return undefined;
    if (this.options.onProviderCredits) await this.options.onProviderCredits(Math.floor(value));
    return Math.floor(value);
  }

  private async throwIfBad(response: any, acceptedStatus: number, label: string): Promise<number | undefined> {
    const credits = await this.captureProviderHeaders(response);
    if (response.status !== acceptedStatus) {
      const error = new Error(providerErrorMessage(response));
      (error as any).response = response;
      (error as any).context = label;
      (error as any).providerCredits = credits;
      throw error;
    }
    return credits;
  }

  async resolveCompanyByLinkedInUrl(companyLinkedInUrl: string, limit = 20): Promise<{ company: CompanySearchResult }> {
    const normalizeCompanyUrl = (value: string) => {
      try {
        const url = new URL(value.trim());
        return `https://www.linkedin.com/company/${url.pathname.split('/').filter(Boolean)[1] ?? ''}`.toLowerCase();
      } catch {
        return '';
      }
    };
    const normalizedTarget = normalizeCompanyUrl(companyLinkedInUrl);
    const slug = normalizedTarget.split('/').filter(Boolean).pop() ?? '';
    if (!slug) throw new Error('Enter a valid LinkedIn company URL.');

    // The public Contact Search API documents companyName/companyDomain filters,
    // not a LinkedIn-company-URL filter. Resolve the pasted URL to Seamless
    // company metadata first, then use that exact company name/domain for contacts.
    const response = await this.client.post('/search/companies', {
      nextToken: null,
      limit: Math.min(Math.max(5, limit), 50),
      companyName: [slug.replace(/[-_]+/g, ' ')],
      companyNameSearchType: 'default',
    });
    await this.throwIfBad(response, 200, 'company search');
    const parsed = SearchEnvelopeSchema.parse(response.data);
    const matches = parsed.data.map((item: Record<string, unknown>) => item as CompanySearchResult).filter((company: CompanySearchResult) => {
      const candidate = firstString(company.liUrl, company.companyLIURL, company.companyLinkedInUrl);
      return candidate && normalizeCompanyUrl(candidate) === normalizedTarget;
    });
    const company = matches[0];
    if (!company) throw new Error('That LinkedIn company URL could not be matched to a Seamless company record.');
    return { company };
  }

  /** Read the provider-reported balance from a normal authenticated search response.
   * The endpoint does not submit contact research; it is used only for balance visibility.
   */
  async probeProviderCredits(): Promise<number | null> {
    const response = await this.client.post('/search/contacts', {
      nextToken: null,
      limit: 1,
      fullName: ['__credit_balance_probe__'],
    }, { timeout: Math.min(this.options.timeoutMs, 8000) });
    return await this.throwIfBad(response, 200, 'provider credit balance probe') ?? null;
  }

  async searchPersonByLinkedInUrl(linkedinUrl: string, limit = 50): Promise<{ contact: ContactSearchResult }> {
    const normalized = linkedinUrl.trim().toLowerCase().replace(/\/$/, '');
    const slug = normalized.split('/in/')[1]?.split('/')[0] ?? '';
    if (!slug) throw new Error('Invalid LinkedIn profile URL.');

    // Seamless documents Contact Search as a 200-response read operation.
    // Search by the profile slug-derived name and, in parallel, by the slug as a
    // keyword. We accept only an exact LinkedIn URL match, so another person
    // with a similar name can never be shown as the requested profile.
    const humanName = slug.replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
    const searchLimit = Math.min(Math.max(10, limit), 50);
    const queries: Record<string, unknown>[] = [
      { nextToken: null, limit: searchLimit, fullName: [humanName] },
      { nextToken: null, limit: searchLimit, contactKeyword: [slug] },
    ];

    const perRequestTimeout = Math.min(this.options.timeoutMs, 8000);
    const results = await Promise.allSettled(queries.map(async body => {
      const response = await this.client.post('/search/contacts', body, { timeout: perRequestTimeout });
      await this.throwIfBad(response, 200, 'contact search');
      const parsed = SearchEnvelopeSchema.parse(response.data);
      return parsed.data.map((item: Record<string, unknown>) => item as ContactSearchResult);
    }));

    const providerErrors: unknown[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const match = result.value.find((item: ContactSearchResult) => {
          const candidate = firstString(item.lIProfileUrl, (item as any).liProfileUrl, (item as any).liUrl, (item as any).linkedinUrl, (item as any).linkedin_url);
          return candidate ? candidate.trim().toLowerCase().replace(/\/$/, '') === normalized : false;
        });
        if (match) return { contact: match };
      } else {
        providerErrors.push(result.reason);
      }
    }

    const firstProviderError = providerErrors.find(error => (error as any)?.response);
    if (firstProviderError) throw firstProviderError;
    const details = providerErrors.map(error => providerErrorMessage(error as any)).filter(Boolean).slice(0, 2);
    throw new Error(details.length ? `Seamless Contact Search did not return the requested profile: ${details.join(' | ')}` : 'Seamless Contact Search did not return an exact match for this LinkedIn profile. No research credit was consumed.');
  }

  async researchContactByIdentity(input: { contactName: string; companyName: string; title?: string; linkedinUrl?: string }, onAccepted?: () => Promise<void>): Promise<EnrichmentResponse> {
    const accepted = await this.client.post('/contacts/research', {
      contacts: [{
        contactName: input.contactName.trim(),
        companyName: input.companyName.trim(),
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      }],
      skipDeduplicationCheck: false,
    });
    await this.throwIfBad(accepted, 202, 'contact research by identity');
    const parsed = ResearchAcceptedSchema.parse(accepted.data);
    if (onAccepted) await onAccepted();
    const requestId = extractRequestId(parsed);

    for (let poll = 1; poll <= this.options.maxPolls; poll += 1) {
      const response = await this.client.get('/contacts/research/poll', {
        params: { requestIds: requestId },
      });
      await this.throwIfBad(response, 200, 'contact research poll');
      const result = readPollResult(response.data);
      const status = result.status;
      if (researchComplete(status)) {
        if (!result.contact) throw new Error('Seamless returned a completed result without contact data');
        return mapContact(result.contact, input.linkedinUrl, { additionalData: result.additionalData });
      }
      if (researchFailed(status)) throw new Error(result.message || `Seamless contact research ended with status: ${status || 'unknown'}`);
      await new Promise(resolve => setTimeout(resolve, this.options.pollIntervalMs));
    }
    const error = new Error('Seamless contact research is still processing. Please retry rather than waiting for a long-running request.');
    (error as any).code = 'ETIMEDOUT';
    throw error;
  }

  async researchContactBySearchResultId(searchResultId: string, skipDeduplicationCheck = false, onAccepted?: () => Promise<void>): Promise<EnrichmentResponse> {
    const accepted = await this.client.post('/contacts/research', {
      searchResultIds: [searchResultId],
      skipDeduplicationCheck,
    });
    await this.throwIfBad(accepted, 202, 'contact research');
    const parsed = ResearchAcceptedSchema.parse(accepted.data);
    if (onAccepted) await onAccepted();
    const requestId = extractRequestId(parsed);

    for (let poll = 1; poll <= this.options.maxPolls; poll += 1) {
      const response = await this.client.get('/contacts/research/poll', {
        params: { requestIds: requestId },
      });
      await this.throwIfBad(response, 200, 'contact research poll');
      const result = readPollResult(response.data);
      const status = result.status;
      if (researchComplete(status)) {
        if (!result.contact) throw new Error('Seamless returned a completed result without contact data');
        return mapContact(result.contact, undefined, { additionalData: result.additionalData });
      }
      if (researchFailed(status)) throw new Error(result.message || `Seamless contact research ended with status: ${status || 'unknown'}`);
      await new Promise(resolve => setTimeout(resolve, this.options.pollIntervalMs));
    }

    const error = new Error('Seamless contact research is still processing. Please retry rather than waiting for a long-running request.');
    (error as any).code = 'ETIMEDOUT';
    throw error;
  }

  async submitContactResearchByLinkedInUrl(linkedinUrl: string, skipDeduplicationCheck = false): Promise<{ requestId: string }> {
    const accepted = await this.client.post('/contacts/research', {
      contacts: [{ liProfileUrl: linkedinUrl }],
      skipDeduplicationCheck,
    });
    await this.throwIfBad(accepted, 202, 'contact research');
    const parsed = ResearchAcceptedSchema.parse(accepted.data);
    return { requestId: extractRequestId(parsed) };
  }

  async pollContactResearchRequest(requestId: string, fallbackLinkedInUrl?: string): Promise<{ status: string; message?: string; data?: EnrichmentResponse }> {
    const response = await this.client.get('/contacts/research/poll', {
      params: { requestIds: requestId },
    });
    await this.throwIfBad(response, 200, 'contact research poll');
    const result = readPollResult(response.data);
    if (researchComplete(result.status)) {
      if (!result.contact) {
        throw new Error(`Seamless marked research ${requestId} as ${result.status || 'complete'} but returned no contact payload.`);
      }
      return {
        status: result.status,
        message: result.message,
        data: mapContact(result.contact, fallbackLinkedInUrl, { additionalData: result.additionalData }),
      };
    }
    if (researchFailed(result.status)) {
      throw new Error(result.message || `Seamless contact research ended with status: ${result.status || 'unknown'}.`);
    }
    return { status: result.status || 'researching', message: result.message };
  }

  async researchContactByLinkedInUrl(linkedinUrl: string, skipDeduplicationCheck = false): Promise<EnrichmentResponse> {
    const accepted = await this.client.post('/contacts/research', {
      contacts: [{ liProfileUrl: linkedinUrl }],
      skipDeduplicationCheck,
    });
    await this.throwIfBad(accepted, 202, 'contact research');
    const parsed = ResearchAcceptedSchema.parse(accepted.data);
    const requestId = extractRequestId(parsed);

    for (let poll = 1; poll <= this.options.maxPolls; poll += 1) {
      const response = await this.client.get('/contacts/research/poll', {
        params: { requestIds: requestId },
      });
      await this.throwIfBad(response, 200, 'contact research poll');
      const result = readPollResult(response.data);
      const status = result.status;
      if (researchComplete(status)) {
        if (!result.contact) throw new Error('Seamless returned a completed result without contact data');
        return mapContact(result.contact, linkedinUrl, { additionalData: result.additionalData });
      }
      if (researchFailed(status)) throw new Error(result.message || `Seamless research ended with status: ${status || 'unknown'}`);
      await new Promise(resolve => setTimeout(resolve, this.options.pollIntervalMs));
    }

    const error = new Error('Seamless contact research is still processing. Please retry rather than waiting for a long-running request.');
    (error as any).code = 'ETIMEDOUT';
    throw error;
  }
}
