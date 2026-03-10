import { SetMetadata } from '@nestjs/common';

export const REQUIRES_PRO_KEY = 'requiresPro';
export const RequiresPro = () => SetMetadata(REQUIRES_PRO_KEY, true);
