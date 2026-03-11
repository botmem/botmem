import { SetMetadata } from '@nestjs/common';

export const IS_READ_ONLY_KEY = 'isReadOnly';
export const ReadOnly = () => SetMetadata(IS_READ_ONLY_KEY, true);
