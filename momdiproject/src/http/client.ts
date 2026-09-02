import axios, { AxiosError, AxiosInstance } from 'axios';
import { z } from 'zod';
import { EnrichmentResponse } from '../core/types';

const ResearchAcceptedSchema = z.object({
  success: z.boolean().optional(),
  requestIds: z.array(z.string().min(1)).min(1),
});

const PollEnvelopeSchema = z.object({
  success: z.boolean().optional(),
  data: z.array(z.object({
    requestId: z.string().optional(),
    searchResultId: z.string().optional(),
    status: z.string(),
    message: z.string().optional(),
    contact: z.record(z.string(), z.any()).optional(),
    additionalData: z.record(z.string(), z.any()).optional(),
  })).min(1),
});

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
    const requestId = parsed.requestIds[0];

    for (let poll = 1; poll <= this.options.maxPolls; poll += 1) {
      const response = await this.client.get('/contacts/research/poll', {
        params: { requestIds: requestId },
      });
      this.throwIfBad(response, 200, 'contact research poll');
      const result = PollEnvelopeSchema.parse(response.data).data[0];
      const status = result.status.toLowerCase();
      if (status === 'done' || status === 'duplicate') {
        if (!result.contact) throw new Error('Seamless returned a completed result without contact data');
        return mapContact(result.contact, input.linkedinUrl, { additionalData: result.additionalData });
      }
      if (status === 'missing') throw new Error('Seamless could not find this person at the selected company');
      if (status === 'error') throw new Error(result.message || 'Seamless contact research failed');
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
    const requestId = parsed.requestIds[0];

    for (let poll = 1; poll <= this.options.maxPolls; poll += 1) {
      const response = await this.client.get('/contacts/research/poll', {
        params: { requestIds: requestId },
      });
      this.throwIfBad(response, 200, 'contact research poll');
      const result = PollEnvelopeSchema.parse(response.data).data[0];
      const status = result.status.toLowerCase();
      if (status === 'done' || status === 'duplicate') {
        if (!result.contact) throw new Error('Seamless returned a completed result without contact data');
        return mapContact(result.contact, undefined, { additionalData: result.additionalData });
      }
      if (status === 'missing') throw new Error('Seamless could not find this contact');
      if (status === 'error') throw new Error(result.message || 'Seamless contact research failed');
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
    const requestId = parsed.requestIds[0];

    for (let poll = 1; poll <= this.options.maxPolls; poll += 1) {
      const response = await this.client.get('/contacts/research/poll', {
        params: { requestIds: requestId },
      });
      this.throwIfBad(response, 200, 'contact research poll');
      const result = PollEnvelopeSchema.parse(response.data).data[0];
      const status = result.status.toLowerCase();
      if (status === 'done' || status === 'duplicate') {
        if (!result.contact) throw new Error('Seamless returned a completed result without contact data');
        return mapContact(result.contact, linkedinUrl, { additionalData: result.additionalData });
      }
      if (status === 'missing') throw new Error('Seamless could not find this LinkedIn profile');
      if (status === 'error') throw new Error(result.message || 'Seamless research failed');
      await new Promise(resolve => setTimeout(resolve, this.options.pollIntervalMs));
    }

    const error = new Error('Seamless research timed out while polling');
    (error as any).code = 'ETIMEDOUT';
    throw error;
  }
}
