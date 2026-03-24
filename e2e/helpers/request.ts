/**
 * Convenience supertest wrapper for unauthenticated requests.
 */
import supertest from 'supertest';
import { getHttpServer } from './app.js';

export function request() {
  return supertest(getHttpServer());
}
