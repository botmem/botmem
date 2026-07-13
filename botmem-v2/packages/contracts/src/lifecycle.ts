import { z } from 'zod';

export const LifecycleJobKindSchema = z.enum(['export', 'deletion']);
export type LifecycleJobKind = z.infer<typeof LifecycleJobKindSchema>;

export const LifecycleJobStateSchema = z.enum([
  'queued',
  'running',
  'retry',
  'ready',
  'completed',
  'expired',
  'dead',
]);
export type LifecycleJobState = z.infer<typeof LifecycleJobStateSchema>;

export const LifecycleJobSchema = z
  .object({
    version: z.literal(2),
    jobId: z.string().uuid(),
    kind: LifecycleJobKindSchema,
    state: LifecycleJobStateSchema,
    requestedAt: z.string().datetime({ offset: true }),
    attempts: z.number().int().nonnegative(),
    availableUntil: z.string().datetime({ offset: true }).nullable(),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    failureCode: z.string().min(1).max(64).nullable(),
    localDelete: z
      .object({
        delivered: z.number().int().nonnegative(),
        unreachable: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type LifecycleJob = z.infer<typeof LifecycleJobSchema>;

export const LifecycleJobListResponseSchema = z
  .object({ version: z.literal(2), items: z.array(LifecycleJobSchema) })
  .strict();
export type LifecycleJobListResponse = z.infer<typeof LifecycleJobListResponseSchema>;

export const LifecycleRequestResponseSchema = z
  .object({ version: z.literal(2), job: LifecycleJobSchema })
  .strict();
export type LifecycleRequestResponse = z.infer<typeof LifecycleRequestResponseSchema>;

export const WorkspaceDeletionRequestSchema = z
  .object({
    version: z.literal(2),
    confirmation: z.string().min(1).max(128),
  })
  .strict();
export type WorkspaceDeletionRequest = z.infer<typeof WorkspaceDeletionRequestSchema>;
