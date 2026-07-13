import { z } from 'zod';
export const EmailLoginStartRequestSchema = z
  .object({
    version: z.literal(2),
    email: z.string().trim().min(3).max(320),
  })
  .strict();
export type EmailLoginStartRequest = z.infer<typeof EmailLoginStartRequestSchema>;

export const EmailLoginAcceptedResponseSchema = z
  .object({
    version: z.literal(2),
    status: z.literal('accepted'),
    message: z.literal('If the account exists, a sign-in link has been sent'),
  })
  .strict();
export type EmailLoginAcceptedResponse = z.infer<typeof EmailLoginAcceptedResponseSchema>;

export const EmailLoginCompleteRequestSchema = z
  .object({
    token: z.string().regex(/^bml_v2\.[A-Za-z0-9_-]{43}$/u),
  })
  .strict();
export type EmailLoginCompleteRequest = z.infer<typeof EmailLoginCompleteRequestSchema>;
