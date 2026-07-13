import { z } from 'zod';
import { ConnectorSchema } from './search.js';

export const SourceReadinessSchema = z.enum([
  'disconnected',
  'authorizing',
  'enrolling',
  'connected',
  'indexing',
  'ready',
  'locked',
  'degraded',
  'error',
]);
export type SourceReadiness = z.infer<typeof SourceReadinessSchema>;

export const DeviceSourceDetailSchema = z.enum([
  'disabled',
  'not_installed',
  'permission_required',
  'schema_unsupported',
  'indexing',
  'ready',
  'error',
]);
export type DeviceSourceDetail = z.infer<typeof DeviceSourceDetailSchema>;

export const SourceStatusSchema = z
  .object({
    connector: ConnectorSchema,
    readiness: SourceReadinessSchema,
    detail: DeviceSourceDetailSchema.optional(),
    searchable: z.boolean(),
    indexedCount: z.number().int().nonnegative().optional(),
    checkpointAt: z.iso.datetime({ offset: true }).optional(),
    lastProbeAt: z.iso.datetime({ offset: true }).optional(),
    reasonCode: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((source, context) => {
    const local = source.connector === 'imessage' || source.connector === 'whatsapp';
    if (source.readiness === 'ready' && !source.searchable) {
      context.addIssue({
        code: 'custom',
        path: ['searchable'],
        message: 'a ready source must be searchable',
      });
    }
    if (source.readiness === 'ready' && !source.checkpointAt) {
      context.addIssue({
        code: 'custom',
        path: ['checkpointAt'],
        message: 'a ready source requires a completed checkpoint',
      });
    }
    if (source.readiness === 'ready' && !source.lastProbeAt) {
      context.addIssue({
        code: 'custom',
        path: ['lastProbeAt'],
        message: 'a ready source requires a successful search probe',
      });
    }
    if (source.readiness === 'ready' && local && source.detail !== 'ready') {
      context.addIssue({
        code: 'custom',
        path: ['detail'],
        message: 'a ready device source requires ready detail',
      });
    }
    if (source.readiness === 'ready' && source.detail && source.detail !== 'ready') {
      context.addIssue({
        code: 'custom',
        path: ['detail'],
        message: 'ready source detail cannot describe an unavailable source',
      });
    }
    if (source.detail === 'ready' && source.readiness !== 'ready') {
      context.addIssue({
        code: 'custom',
        path: ['detail'],
        message: 'ready detail requires ready source readiness',
      });
    }
  });
export type SourceStatus = z.infer<typeof SourceStatusSchema>;
