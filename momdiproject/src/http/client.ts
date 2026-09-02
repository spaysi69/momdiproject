import axios, { AxiosError, AxiosInstance } from 'axios';
import { z } from 'zod';
import { EnrichmentResponse } from '../core/types';

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
    phone: firstString(contact.contactPhone1, contact.phone),
    linkedinUrl: linkedinUrl ?? '',
    department: firstString(contact.department),
    seniority: firstString(contact.seniority),
    alternateEmails: [contact.email2, contact.email3, contact.personalEmail].map(stringOrUndefined).filter((v): v is string => Boolean(v)),
    alternatePhones: [contact.contactPhone2, contact.companyPhone1, contact.companyPhone2, contact.companyPhone3].map(stringOrUndefined).filter((v): v is string => Boolean(v)),
    companyDomain: firstString(contact.companyDomain, contact.website, contact.companyWebsite),
    companyLinkedInUrl: firstString(contact.companyLIProfileUrl, contact.companyLinkedInUrl),
    contactLocation: contact.contactLocation && typeof contact.contactLocation === 'object' ? contact.contactLocation : undefined,
    companyLocation: contact.companyLocation && typeof contact.companyLocation === 'object' ? contact.companyLocation : undefined,
    raw: { ...contact, ...(extra ?? {}) },
  };
}

function readPollResult(payload: unknown): { status: string; message?: string; contact?: Record<string, any>; additionalData?: unknown } {
  const root:any = PollEnvelopeSchema.parse(payload);
  const candidates:any[] = [];
  if (Array.isArray(root?.data)) candidates.push(...root.data);
  else if (root?.data && typeof root.data === 'object') candidates.push(root.data);
  if (Array.isArray(root?.results)) candidates.push(...root.results);
  if (root && typeof root === 'object' && (root.status !== undefined || root.contact !== undefined)) candidates.unshift(root);
  const result = candidates.find(Boolean);
  if (!result || typeof result !== 'object') {
    throw new Error('Seamless returned an unreadable research poll response');
  }
  const status = String(result.status ?? result.state ?? '').trim().toLowerCase();
  const message = typeof result.message === 'string' ? result.message : undefined;
  let contact = result.contact;
  if (!contact && result.result && typeof result.result === 'object') contact = result.result.contact ?? result.result;
  if (Array.isArray(contact)) contact = contact[0];
  const mappedContact = contact && typeof contact === 'object' ? contact as Record<string, any> : undefined;
  return { status, message, contact: mappedContact, additionalData: result.additionalData ?? result.additional_data };
}

function extractRequestId(payload: unknown): string {
  const root:any = payload;
  const ids = Array.isArray(root?.requestIds) ? root.requestIds : [];
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

  private throwIfBad(response: any, acceptedStatus: number, label: string): void {
    if (response.status !== acceptedStatus) {
      const error = new Error(providerErrorMessage(response));
      (error as any).response = response;
      (error as any).context = label;
      throw error;
    }
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
    this.throwIfBad(response, 200, 'company search');
    const parsed = SearchEnvelopeSchema.parse(response.data);
    const matches = parsed.data.map(item => item as CompanySearchResult).filter(company => {
      const candidate = firstString(company.liUrl, company.companyLIURL, company.companyLinkedInUrl);
      return candidate && normalizeCompanyUrl(candidate) === normalizedTarget;
    });
    const company = matches[0];
    if (!company) throw new Error('That LinkedIn company URL could not be matched to a Seamless company record.');
    return { company };
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
    this.throwIfBad(accepted, 202, 'contact research by identity');
    const parsed = ResearchAcceptedSchema.parse(accepted.data);
    if (onAccepted) await onAccepted();
    const requestId = extractRequestId(parsed);

    for (let poll = 1; poll <= this.options.maxPolls; poll += 1) {
      const response = await this.client.get('/contacts/research/poll', {
        params: { requestIds: requestId },
      });
      this.throwIfBad(response, 200, 'contact research poll');
      const result = readPollResult(response.data);
      const status = result.status;
      if (researchComplete(status)) {
        if (!result.contact) throw new Error('Seamless returned a completed result without contact data');
        return mapContact(result.contact, input.linkedinUrl, { additionalData: result.additionalData });
      }
      if (researchFailed(status)) throw new Error(result.message || `Seamless contact research ended with status: ${status || 'unknown'}`);
      await new Promise(resolve => setTimeout(resolve, this.options.pollIntervalMs));
    }
    const error = new Error('Seamless contact research timed out while polling');
    (error as any).code = 'ETIMEDOUT';
    throw error;
  }

  async researchContactBySearchResultId(searchResultId: string, skipDeduplicationCheck = false, onAccepted?: () => Promise<void>): Promise<EnrichmentResponse> {
    const accepted = await this.client.post('/contacts/research', {
      searchResultIds: [searchResultId],
      skipDeduplicationCheck,
    });
    this.throwIfBad(accepted, 202, 'contact research');
    const parsed = ResearchAcceptedSchema.parse(accepted.data);
    if (onAccepted) await onAccepted();
    const requestId = extractRequestId(parsed);

    for (let poll = 1; poll <= this.options.maxPolls; poll += 1) {
      const response = await this.client.get('/contacts/research/poll', {
        params: { requestIds: requestId },
      });
      this.throwIfBad(response, 200, 'contact research poll');
      const result = readPollResult(response.data);
      const status = result.status;
      if (researchComplete(status)) {
        if (!result.contact) throw new Error('Seamless returned a completed result without contact data');
        return mapContact(result.contact, undefined, { additionalData: result.additionalData });
      }
      if (researchFailed(status)) throw new Error(result.message || `Seamless contact research ended with status: ${status || 'unknown'}`);
      await new Promise(resolve => setTimeout(resolve, this.options.pollIntervalMs));
    }

    const error = new Error('Seamless contact research timed out while polling');
    (error as any).code = 'ETIMEDOUT';
    throw error;
  }

  async researchContactByLinkedInUrl(linkedinUrl: string, skipDeduplicationCheck = false): Promise<EnrichmentResponse> {
    const accepted = await this.client.post('/contacts/research', {
      contacts: [{ liProfileUrl: linkedinUrl }],
      skipDeduplicationCheck,
    });
    this.throwIfBad(accepted, 202, 'contact research');
    const parsed = ResearchAcceptedSchema.parse(accepted.data);
    const requestId = extractRequestId(parsed);

    for (let poll = 1; poll <= this.options.maxPolls; poll += 1) {
      const response = await this.client.get('/contacts/research/poll', {
        params: { requestIds: requestId },
      });
      this.throwIfBad(response, 200, 'contact research poll');
      const result = readPollResult(response.data);
      const status = result.status;
      if (researchComplete(status)) {
        if (!result.contact) throw new Error('Seamless returned a completed result without contact data');
        return mapContact(result.contact, linkedinUrl, { additionalData: result.additionalData });
      }
      if (researchFailed(status)) throw new Error(result.message || `Seamless research ended with status: ${status || 'unknown'}`);
      await new Promise(resolve => setTimeout(resolve, this.options.pollIntervalMs));
    }

    const error = new Error('Seamless research timed out while polling');
    (error as any).code = 'ETIMEDOUT';
    throw error;
  }
}
