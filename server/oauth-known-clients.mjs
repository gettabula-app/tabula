// Exact redirects used by well-known MCP clients. Keep each URI tied to its source.
export const KNOWN_REDIRECTS = [
  // https://claude.com/docs/connectors/building/authentication
  { label: 'Claude', uri: 'https://claude.ai/api/mcp/auth_callback' },
  // https://developers.openai.com/apps-sdk/build/auth
  { label: 'ChatGPT', uri: 'https://chatgpt.com/connector_platform_oauth_redirect' },
  // https://cursor.com/docs/context/mcp
  { label: 'Cursor', uri: 'https://www.cursor.com/agents/mcp/oauth/callback' },
  // https://raw.githubusercontent.com/microsoft/vscode/main/extensions/microsoft-authentication/src/common/env.ts
  { label: 'VS Code', uri: 'https://vscode.dev/redirect' },
  // https://github.com/microsoft/vscode/issues/278512
  { label: 'VS Code (Insiders)', uri: 'https://insiders.vscode.dev/redirect' },
];

export const KNOWN_LOCALHOST_PATHS = ['/callback', '/oauth/callback', '/oauth_callback'];

// Observed in Cursor's DCR payload (https://forum.cursor.com/t/cursor-mcp-dcr-still-omits-application-type-and-uses-a-non-rfc-8252-compliant-private-redirect-uri-3-14-27/167608).
// This URI is non-compliant with the MCP spec and is only tolerated, never verified.
export const TOLERATED_PRIVATE_URIS = ['cursor://anysphere.cursor-mcp/oauth/callback'];

export function knownRedirect(uri) {
  const match = KNOWN_REDIRECTS.find((entry) => entry.uri === uri);
  return match ? { label: match.label } : null;
}
