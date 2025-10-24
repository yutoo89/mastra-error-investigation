import { MCPClient } from '@mastra/mcp';

/**
 * Notion MCP Server に接続するクライアント（STDIO モード）
 *
 * このクライアントは Notion のインテグレーションキー（Internal Integration Secret）を使用して
 * ローカル STDIO モードで Notion MCP Server を起動します。
 *
 * 環境変数:
 * - NOTION_TOKEN: Notion Internal Integration Secret (必須)
 *   トークン形式: ntn_********
 *   トークン作成手順:
 *   1. https://www.notion.so/my-integrations にアクセス
 *   2. 新規統合を作成
 *   3. Configuration タブで Internal Integration Secret をコピー
 *   4. 対象ページで「...」→「Connect to integration」で統合を接続
 *
 * 参考:
 * - Notion MCP Server: https://github.com/makenotion/notion-mcp-server
 * - Notion Integrations: https://developers.notion.com/docs/create-a-notion-integration
 * - Mastra MCP Client: https://mastra.ai/reference/tools/mcp-client
 */

// シングルトンインスタンスをキャッシュ
let mcpClientInstance: MCPClient | null = null;

export function createNotionMCPClient(): MCPClient {
  // 既にインスタンスが存在する場合は再利用
  if (mcpClientInstance) {
    return mcpClientInstance;
  }

  const notionToken = process.env.NOTION_TOKEN;

  if (!notionToken) {
    throw new Error(
      'NOTION_TOKEN environment variable is required. ' +
      'Create a Notion Integration at https://www.notion.so/my-integrations ' +
      'and copy the Internal Integration Secret (format: ntn_********). ' +
      'Then connect the integration to your pages via "..." → "Connect to integration".'
    );
  }

  mcpClientInstance = new MCPClient({
    // ユニークIDを設定してメモリリークエラーを回避
    id: 'notion-mcp-client',
    servers: {
      notion: {
        // STDIO モード: ローカルで Notion MCP Server を起動
        command: 'npx',
        args: [
          '-y',
          '@notionhq/notion-mcp-server',
        ],
        // 環境変数経由で NOTION_TOKEN を渡す
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
          ),
          NOTION_TOKEN: notionToken,
        },
        // サーバー単位のタイムアウト（60秒）
        timeout: 60_000,
      },
    },
  });

  return mcpClientInstance;
}
