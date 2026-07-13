import {
  SEARCH_TOOL_INPUT_JSON_SCHEMA,
  SearchToolInputSchema,
  parseSearchRequest,
  parseWorkspaceId,
  type SearchResponse,
  type SearchToolInput,
} from '@botmem-v2/contracts';
import type { SearchApplicationService } from '@botmem-v2/sdk';

export type McpSearchInput = SearchToolInput;

export interface McpSearchResult {
  readonly structuredContent: SearchResponse;
  readonly content: [{ readonly type: 'text'; readonly text: string }];
}

export interface McpSearchTool {
  readonly name: 'search';
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  invoke(input: McpSearchInput): Promise<McpSearchResult>;
}

/** Creates the read-only MCP search adapter bound to an authorized workspace. */
export function createMcpSearchTool(
  search: SearchApplicationService,
  workspaceId: string,
): McpSearchTool {
  const validatedWorkspaceId = parseWorkspaceId(workspaceId);
  return {
    name: 'search',
    description: 'Search hosted and device-local Botmem sources with explicit lane coverage.',
    inputSchema: SEARCH_TOOL_INPUT_JSON_SCHEMA,
    async invoke(input) {
      const toolInput = SearchToolInputSchema.parse(input);
      const request = parseSearchRequest({ version: 2, ...toolInput });
      const response = await search.search(validatedWorkspaceId, request);
      return {
        structuredContent: response,
        content: [{ type: 'text', text: JSON.stringify(response) }],
      };
    },
  };
}
