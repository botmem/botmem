# Botmem v2 CLI

This package contains one standalone Node.js 22+ executable. It has no runtime
package dependencies and talks only to the configured Botmem v2 API.

```bash
shasum -a 256 -c botmem-v2-cli-0.1.0.tgz.sha256
npm install --global ./botmem-v2-cli-0.1.0.tgz
export BOTMEM_API_URL='https://api.botmem.xyz'
export BOTMEM_ACCESS_TOKEN='bmp_v2.…'
botmem search --workspace '<workspace-uuid>' --query 'launch decision' --json
```

Create a named personal access token in **Botmem → Account → Agent access**.
Search requires `botmem:search`; connection and device status require their
corresponding read-only scopes. Tokens are secrets: pass them through the
environment, never as command arguments.

Each tagged GitHub release also includes a public Sigstore bundle named
`botmem-v2-cli-0.1.0.tgz.sigstore.json`; the release page records the exact
main-branch CI run that produced it. This package is licensed under
AGPL-3.0-only. The corresponding source is at
<https://github.com/botmem/botmem/tree/main/botmem-v2>.
