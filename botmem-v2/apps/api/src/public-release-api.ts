import type { PublicReleaseConfiguration } from '@botmem-v2/contracts';
import type { FastifyInstance } from 'fastify';

export function registerPublicReleaseApi(
  app: FastifyInstance,
  releases: PublicReleaseConfiguration,
): void {
  app.get('/v2/public/releases', async (_request, reply) => reply.code(200).send(releases));
}
