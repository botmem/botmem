import { SetMetadata } from '@nestjs/common';

export const REQUIRES_JWT_KEY = 'requiresJwt';
export const RequiresJwt = () => SetMetadata(REQUIRES_JWT_KEY, true);
