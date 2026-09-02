import axios from 'axios';
import { z } from 'zod';
import { EnrichmentResponse } from '../core/types';

const ProviderResponseSchema = z.object({
  id: z.string().optional(),
  full_name: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  title: z.string().optional(),
  company: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  linkedin_url: z.string(),
});

export function createProviderClient(baseURL: string, apiKey: string, timeout: number) {
  const client = axios.create({ baseURL, timeout, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'EnrichmentService/2.0' } });
  return {
    async enrich(path: string, linkedinUrl: string): Promise<EnrichmentResponse> {
      const response = await client.post(path, { linkedin_url: linkedinUrl });
      const parsed = ProviderResponseSchema.parse(response.data);
      return { id: parsed.id, fullName: parsed.full_name, firstName: parsed.first_name, lastName: parsed.last_name, title: parsed.title, company: parsed.company, email: parsed.email, phone: parsed.phone, linkedinUrl: parsed.linkedin_url };
    }
  };
}
