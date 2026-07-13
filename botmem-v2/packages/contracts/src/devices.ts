import { z } from 'zod';
import { SourceStatusSchema } from './sources.js';

const LocalConnectorSchema = z.enum(['imessage', 'whatsapp']);

export const DeviceSummarySchema = z
  .object({
    deviceId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(128),
    state: z.enum(['online', 'offline', 'revoked']),
    connectors: z.array(LocalConnectorSchema).min(1).max(2),
    clientVersion: z.string().trim().min(1).max(64).optional(),
    lastSeenAt: z.iso.datetime({ offset: true }).optional(),
    sources: z.array(SourceStatusSchema).max(2),
  })
  .strict()
  .superRefine((device, context) => {
    const connectors = new Set(device.connectors);
    device.sources.forEach((source, index) => {
      if (
        (source.connector !== 'imessage' && source.connector !== 'whatsapp') ||
        !connectors.has(source.connector)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['sources', index, 'connector'],
          message: 'device sources must be declared local connectors',
        });
      }
    });
    if (device.state === 'online' && !device.lastSeenAt) {
      context.addIssue({
        code: 'custom',
        path: ['lastSeenAt'],
        message: 'online devices require lastSeenAt',
      });
    }
  });
export type DeviceSummary = z.infer<typeof DeviceSummarySchema>;

export const DeviceListResponseSchema = z
  .object({
    version: z.literal(2),
    items: z.array(DeviceSummarySchema).max(64),
  })
  .strict();
export type DeviceListResponse = z.infer<typeof DeviceListResponseSchema>;
export const DeviceListToolInputSchema = z.object({}).strict();

export const DevicePairingCodeResponseSchema = z
  .object({
    code: z.string().regex(/^BM2-[A-Za-z0-9_-]{24}$/u),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type DevicePairingCodeResponse = z.infer<typeof DevicePairingCodeResponseSchema>;

export const DEVICE_SETUP_PROTOCOL = 'botmem.device.setup.v1' as const;
export const DeviceSetupPayloadSchema = z
  .object({
    protocolVersion: z.literal(DEVICE_SETUP_PROTOCOL),
    apiBaseUrl: z.url().superRefine((value, context) => {
      const parsed = new URL(value);
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== '/' ||
        parsed.search ||
        parsed.hash
      ) {
        context.addIssue({ code: 'custom', message: 'apiBaseUrl must be an HTTPS origin' });
      }
    }),
    workspaceId: z.string().uuid(),
    code: DevicePairingCodeResponseSchema.shape.code,
  })
  .strict();
export type DeviceSetupPayload = z.infer<typeof DeviceSetupPayloadSchema>;
