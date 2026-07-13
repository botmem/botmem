import { z } from 'zod';

export const WorkspaceIdSchema = z.string().uuid();
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;

export const BrowserSessionSchema = z
  .object({
    version: z.literal(2),
    workspaceId: WorkspaceIdSchema,
  })
  .strict();
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;

export function parseWorkspaceId(input: unknown): WorkspaceId {
  return WorkspaceIdSchema.parse(input);
}

export function parseBrowserSession(input: unknown): BrowserSession {
  return BrowserSessionSchema.parse(input);
}
