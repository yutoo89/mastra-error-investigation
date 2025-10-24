import { MCPClient } from '@mastra/mcp';

/**
 * Sentry MCP Server に接続するクライアント（STDIO モード）
 *
 * 注意: Sentry Remote MCP Server (https://mcp.sentry.dev/mcp) は OAuth 専用のため、
 * このクライアントはローカル STDIO モードで Sentry MCP Server を起動します。
 *
 * 環境変数:
 * - SENTRY_MCP_TOKEN: Sentry User Auth Token (必須)
 *   必要なスコープ: org:read, project:read, project:write, team:read, team:write, event:write
 *   トークン作成: https://sentry.io/settings/account/api/auth-tokens/
 * - SENTRY_MCP_URL: Sentry の完全な URL (必須)
 *   例: https://mov-inc.sentry.io
 *
 * 参考:
 * - Sentry MCP Server: https://docs.sentry.io/product/sentry-mcp
 * - Mastra MCP Client: https://mastra.ai/reference/tools/mcp-client
 */

// シングルトンインスタンスをキャッシュ
let mcpClientInstance: MCPClient | null = null;

export function createSentryMCPClient(): MCPClient {
  // 既にインスタンスが存在する場合は再利用
  if (mcpClientInstance) {
    return mcpClientInstance;
  }

  const mcpToken = process.env.SENTRY_MCP_TOKEN;
  const sentryUrl = process.env.SENTRY_MCP_URL;

  if (!mcpToken) {
    throw new Error(
      'SENTRY_MCP_TOKEN environment variable is required. ' +
      'Create a User Auth Token at https://sentry.io/settings/account/api/auth-tokens/ ' +
      'with scopes: org:read, project:read, project:write, team:read, team:write, event:write'
    );
  }

  if (!sentryUrl) {
    throw new Error(
      'SENTRY_MCP_URL environment variable is required. ' +
      'Example: https://mov-inc.sentry.io'
    );
  }

  mcpClientInstance = new MCPClient({
    // ユニークIDを設定してメモリリークエラーを回避
    id: 'sentry-mcp-client',
    servers: {
      sentry: {
        // STDIO モード: ローカルで Sentry MCP Server を起動
        command: 'npx',
        args: [
          '@sentry/mcp-server@latest',
          `--access-token=${mcpToken}`,
          `--url=${sentryUrl}`, // 完全なURLを指定する場合は --url を使用
        ],
        // 環境変数を渡す場合はここで設定
        env: Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
        ),
        // サーバー単位のタイムアウト（60秒）
        timeout: 60_000,
      },
    },
  });

  return mcpClientInstance;
}
