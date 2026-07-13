import { EmailLoginCompleteRequestSchema, WorkspaceIdSchema } from '@botmem-v2/contracts';

const WORKSPACE_STORAGE_KEY = 'botmem.v2.workspace';

export interface LoginFragment {
  readonly token?: string;
  readonly workspaceId?: string;
}

/** Parses the fragment-only magic link without ever copying its token into a query string. */
export function parseLoginFragment(hash: string): LoginFragment {
  const params = new URLSearchParams(hash.replace(/^#/u, ''));
  const tokenResult = EmailLoginCompleteRequestSchema.safeParse({
    token: params.get('loginToken'),
  });
  const workspaceResult = WorkspaceIdSchema.safeParse(params.get('workspaceId'));
  return {
    ...(tokenResult.success ? { token: tokenResult.data.token } : {}),
    ...(workspaceResult.success ? { workspaceId: workspaceResult.data } : {}),
  };
}

export function loadRememberedWorkspace(storage: Pick<Storage, 'getItem'>): string {
  try {
    const result = WorkspaceIdSchema.safeParse(storage.getItem(WORKSPACE_STORAGE_KEY));
    return result.success ? result.data : '';
  } catch {
    return '';
  }
}

export function rememberWorkspace(storage: Pick<Storage, 'setItem'>, workspaceId: string): void {
  const parsed = WorkspaceIdSchema.parse(workspaceId);
  try {
    storage.setItem(WORKSPACE_STORAGE_KEY, parsed);
  } catch {
    // A blocked storage API must not block authentication.
  }
}
