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
    contact: z.record(z.any()).optional(),
    additionalData: z.record(z.any()).optional(),
  })).min(1),
});

export interface SeamlessClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  pollIntervalMs: number;
  maxPolls: number;
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

function mapContact(contact: Record<string, any>, fallbackLinkedInUrl: string): EnrichmentResponse {
  const firstName = firstString(contact.firstName, contact.first_name);
  const lastName = firstString(contact.lastName, contact.last_name);
  const fullName = firstString(contact.fullName, contact.full_name, contact.name) ?? ([firstName, lastName].filter(Boolean).join(' ') || undefined);
  const linkedinUrl = firstString(contact.lIProfileUrl, contact.liProfileUrl, contact.linkedinUrl, contact.linkedin_url, fallbackLinkedInUrl) ?? fallbackLinkedInUrl;

  return {
    id: firstString(contact.contactId, contact.id),
    fullName,
    firstName,
    lastName,
    title: firstString(contact.title, contact.jobTitle),
    company: firstString(contact.company, contact.companyName),
    email: firstString(contact.email, contact.email1),
    phone: firstString(contact.contactPhone1, contact.phone),
    linkedinUrl,
    department: firstString(contact.department),
    seniority: firstString(contact.seniority),
    alternateEmails: [contact.email2, contact.email3, contact.personalEmail].map(stringOrUndefined).filter((v): v is string => Boolean(v)),
    alternatePhones: [contact.contactPhone2, contact.companyPhone1, contact.companyPhone2, contact.companyPhone3].map(stringOrUndefined).filter((v): v is string => Boolean(v)),
    companyDomain: firstString(contact.companyDomain, contact.website, contact.companyWebsite),
    companyLinkedInUrl: firstString(contact.companyLIProfileUrl, contact.companyLinkedInUrl),
    contactLocation: contact.contactLocation && typeof contact.contactLocation === 'object' ? contact.contactLocation : undefined,
    companyLocation: contact.companyLocation && typeof contact.companyLocation === 'object' ? contact.companyLocation : undefined,
    raw: contact,
  };
}

function providerErrorMessage(error: AxiosError): string {
  const body = error.response?.data as any;
  if (body && typeof body === 'object') {
    return String(body.msg ?? body.message ?? body.error ?? error.message);
  }
  return error.message;
}

export class SeamlessClient {
  private readonly client: AxiosInstance;
  constructor(private readonly options: SeamlessClientOptions) {
    this.client = axios.create({
      baseURL: options.baseUrl.replace(/\/$/, ''),
      timeout: options.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        Token: options.apiKey,
      },
      validateStatus: () => true,
    });
  }

  async researchContactByLinkedInUrl(linkedinUrl: string, skipDeduplicationCheck = false): Promise<EnrichmentResponse> {
    const accepted = await this.client.post('/contacts/research', {
      contacts: [{ liProfileUrl: linkedinUrl }],
      skipDeduplicationCheck,
    });

    if (accepted.status !== 202) {
      const error = new Error(providerErrorMessage(accepted as any));
      (error as any).response = accepted;
      throw error;
    }

    const parsed = ResearchAcceptedSchema.parse(accepted.data);
    const requestId = parsed.requestIds[0];

    for (let poll = 1; poll <= this.options.maxPolls; poll += 1) {
      const response = await this.client.get('/contacts/research/poll', {
        params: { requestIds: requestId },
      });
      if (response.status !== 200) {
        const error = new Error(providerErrorMessage(response as any));
        (error as any).response = response;
        throw error;
      }

      const result = PollEnvelopeSchema.parse(response.data).data[0];
      const status = result.status.toLowerCase();
      if (status === 'done' || status === 'duplicate') {
        if (!result.contact) throw new Error('Seamless returned a completed result without contact data');
        return mapContact(result.contact, linkedinUrl);
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
