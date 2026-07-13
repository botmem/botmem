import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [portFile] = process.argv.slice(2);
if (!portFile) throw new Error('port file is required');
const workspaceId = '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf';
const prefix = `/v2/workspaces/${workspaceId}`;
const server = createServer((request, response) => {
  if (!request.headers.authorization?.startsWith('Bearer bmp_v2.')) {
    respond(response, 401, { error: { code: 'authentication_required', message: 'Authentication required' } });
    return;
  }
  if (request.method === 'POST' && request.url === `${prefix}/search`) {
    request.resume();
    respond(response, 200, {
      version: 2,
      queryId: '52b2ecba-3d9a-4c9d-89c8-e06c7916eec1',
      items: [],
      coverage: {
        partial: false,
        lanes: [{
          laneId: 'hosted',
          placement: 'hosted',
          status: 'complete',
          retryable: false,
          returned: 0,
          tookMs: 1,
        }],
      },
      found: 0,
      tookMs: 1,
    });
    return;
  }
  if (request.method === 'GET' && request.url === `${prefix}/connections`) {
    respond(response, 200, { version: 2, items: [] });
    return;
  }
  if (request.method === 'GET' && request.url === `${prefix}/devices`) {
    respond(response, 200, { version: 2, items: [] });
    return;
  }
  respond(response, 404, { error: { code: 'not_found', message: 'Not found' } });
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP listener is unavailable');
  writeFileSync(portFile, `http://127.0.0.1:${address.port}\n`, { mode: 0o600 });
});

function respond(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
