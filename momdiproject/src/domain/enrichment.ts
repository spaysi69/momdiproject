import { z } from 'zod';

export const EnrichmentRequestSchema = z.object({
  linkedinUrl: z.string().min(1),
});

export const EnrichmentResponseSchema = z.object({
  full_name: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  title: z.string().optional(),
  company: z.string().optional(),
  linkedin_url: z.string().url(),
}).passthrough();

export type EnrichmentRequest = z.infer<typeof EnrichmentRequestSchema>;
export type EnrichmentResponse = z.infer<typeof EnrichmentResponseSchema>;
