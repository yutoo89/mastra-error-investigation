import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { Client } from '@notionhq/client';
import { issueResearchAgent } from '../agents/issue-research-agent';
import { searchIssues, type SentryConfig } from '../clients/sentry-api';

// Notion クライアントの初期化
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

// Sentry設定の初期化
function envOrThrow(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const sentryCfg: SentryConfig = {
  baseUrl: envOrThrow('SENTRY_MCP_URL'),       // 例: https://us.sentry.io
  organizationSlug: 'mov-inc',
  authToken: envOrThrow('SENTRY_MCP_TOKEN'),
};

/**
 * Sentry調査ワークフロー
 *
 * Sentryからissueを収集し、詳細を調査してNotionにレポートを作成
 *
 * フロー:
 * 1. sentry-agentを使ってSentryからissueを検索し構造化出力
 * 2. 各issueに対して詳細を調査
 * 3. 調査結果をNotionにレポートとして作成
 */

/**
 * Notionブロックの型定義
 */
type NotionBlock =
  | {
      object: 'block';
      type: 'heading_2';
      heading_2: {
        rich_text: Array<{
          type: 'text';
          text: {
            content: string;
          };
        }>;
      };
    }
  | {
      object: 'block';
      type: 'heading_3';
      heading_3: {
        rich_text: Array<{
          type: 'text';
          text: {
            content: string;
          };
        }>;
      };
    }
  | {
      object: 'block';
      type: 'paragraph';
      paragraph: {
        rich_text: Array<{
          type: 'text';
          text: {
            content: string;
          };
        }>;
      };
    };

/**
 * 2000文字を超えるテキストを分割して複数の段落ブロックを作成
 */
const createParagraphBlocks = (text: string): NotionBlock[] => {
  const MAX_LENGTH = 2000;
  const blocks: NotionBlock[] = [];

  for (let i = 0; i < text.length; i += MAX_LENGTH) {
    const chunk = text.slice(i, i + MAX_LENGTH);
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: chunk,
            },
          },
        ],
      },
    });
  }

  return blocks;
};

/**
 * 見出し2ブロックを作成
 */
const createHeading2Block = (text: string): NotionBlock => ({
  object: 'block',
  type: 'heading_2',
  heading_2: {
    rich_text: [
      {
        type: 'text',
        text: {
          content: text.slice(0, 2000), // 見出しも2000文字制限
        },
      },
    ],
  },
});

/**
 * 見出し3ブロックを作成
 */
const createHeading3Block = (text: string): NotionBlock => ({
  object: 'block',
  type: 'heading_3',
  heading_3: {
    rich_text: [
      {
        type: 'text',
        text: {
          content: text.slice(0, 2000), // 見出しも2000文字制限
        },
      },
    ],
  },
});

/**
 * 調査結果のテキストを見出しで分割し、Notionブロックの配列に変換
 * - ## で見出し2ブロック
 * - ### で見出し3ブロック
 * - それ以外は段落ブロック
 * - 各テキストが2000文字を超える場合はさらに分割
 */
const parseInvestigationToBlocks = (text: string): NotionBlock[] => {
  const lines = text.split('\n');
  const blocks: NotionBlock[] = [];
  let currentParagraph = '';

  for (const line of lines) {
    if (line.startsWith('### ')) {
      // 現在の段落を追加
      if (currentParagraph.trim()) {
        blocks.push(...createParagraphBlocks(currentParagraph.trim()));
        currentParagraph = '';
      }
      // 見出し3を追加
      blocks.push(createHeading3Block(line.replace('### ', '')));
    } else if (line.startsWith('## ')) {
      // 現在の段落を追加
      if (currentParagraph.trim()) {
        blocks.push(...createParagraphBlocks(currentParagraph.trim()));
        currentParagraph = '';
      }
      // 見出し2を追加
      blocks.push(createHeading2Block(line.replace('## ', '')));
    } else {
      currentParagraph += line + '\n';
    }
  }

  // 最後の段落を追加
  if (currentParagraph.trim()) {
    blocks.push(...createParagraphBlocks(currentParagraph.trim()));
  }

  return blocks;
};

// Issue情報のスキーマ（構造化出力用）
const issueSchema = z.object({
  title: z.string().describe('Issue title'),
  url: z.string().describe('Issue URL'),
  events: z.number().describe('Events count'),
  firstSeen: z.string().describe('最初に発生した時期'),
  lastSeen: z.string().describe('最後に発生した時期'),
  assignee: z.string().nullable().optional().describe('担当者'),
  recommendedActions: z.array(z.string()).describe('推奨初動対応のリスト'),
});


// 構造化出力のスキーマ
const issuesOutputSchema = z.object({
  issues: z.array(issueSchema).describe('検出されたissueのリスト'),
});

/**
 * ステップ1: SentryからissueをAPI経由で直接検索
 */
const pickIssuesStep = createStep({
  id: 'pick-issues',
  description: 'SentryからissueをAPI経由で直接検索',
  inputSchema: z.object({
    days: z.number().optional().default(7).describe('調査対象の日数(直近N日)'),
  }),
  outputSchema: issuesOutputSchema,
  execute: async ({ inputData }) => {
    const { days } = inputData;

    console.log('days: ', days);
    console.log('=== Fetching Sentry Issues via API ===');

    try {
      // kutikomi-com プロジェクトのID（ハードコード）
      const projectId = '5340846';

      // Sentry検索クエリ: lastSeen:-7d の形式（>= は不要）
      const query = `environment:production is:unresolved lastSeen:-${days}d`;

      console.log(`Query: ${query}`);

      const { data } = await searchIssues(sentryCfg, {
        project: projectId,
        query,
        limit: 50,
      });

      console.log(`=== Found ${data.length} issues ===`);

      // Sentry APIレスポンスを構造化スキーマに変換
      const issues = data.map((issue: any) => {
        // firstSeen と lastSeen を人間が読みやすい形式に変換
        const firstSeenDate = new Date(issue.firstSeen);
        const lastSeenDate = new Date(issue.lastSeen);
        const formatDate = (date: Date) => {
          const now = new Date();
          const diffMs = now.getTime() - date.getTime();
          const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
          const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

          if (diffDays > 0) {
            return `${diffDays}日前 (${date.toLocaleDateString('ja-JP')})`;
          } else if (diffHours > 0) {
            return `${diffHours}時間前`;
          } else {
            return '1時間以内';
          }
        };

        // 推奨初動対応を生成
        const recommendedActions: string[] = [];
        if (issue.count > 1000) {
          recommendedActions.push('高頻度エラーのため優先的に対応が必要');
        }
        if (issue.userCount > 100) {
          recommendedActions.push('多数のユーザーに影響しているため緊急対応を検討');
        }
        if (issue.level === 'error' || issue.level === 'fatal') {
          recommendedActions.push('エラーレベルが高いため早急な調査が必要');
        }
        if (recommendedActions.length === 0) {
          recommendedActions.push('通常の優先度で調査・対応');
        }

        return {
          title: issue.title || issue.metadata?.title || 'タイトルなし',
          url: issue.permalink || `https://mov-inc.sentry.io/issues/${issue.id}/`,
          events: issue.count || 0,
          firstSeen: formatDate(firstSeenDate),
          lastSeen: formatDate(lastSeenDate),
          assignee: issue.assignedTo?.name || null,
          recommendedActions,
        };
      });

      console.log('=== Result Debug ===');
      console.log('issues count:', issues.length);
      console.log('sample issue:', issues[0]);

      return { issues };
    } catch (error) {
      console.error('Error fetching Sentry issues:', error);
      throw error;
    }
  },
});

/**
 * ステップ2の準備: foreach用にissueの配列を準備
 */
const prepareIssueInvestigation = createStep({
  id: 'prepare-issue-investigation',
  description: 'Issue詳細調査のためのissue配列を準備',
  inputSchema: issuesOutputSchema,
  outputSchema: z.array(issueSchema),
  execute: async ({ inputData }) => {
    const { issues } = inputData;
    return issues;
  },
});

/**
 * ステップ2: 個別issueの詳細を調査
 */
const investigateSingleIssue = createStep({
  id: 'investigate-single-issue',
  description: '単一issueの詳細を調査',
  inputSchema: issueSchema,
  outputSchema: z.object({
    issue: issueSchema.describe('元のissue情報'),
    investigation: z.string().describe('調査結果'),
  }),
  execute: async ({ inputData }) => {
    const issue = inputData;

    console.log('=== Investigating Issue ===');
    console.log('Title:', issue.title);
    console.log('URL:', issue.url);
    console.log('=========================');

    const prompt = `
以下のSentry issueについて、詳細に調査してください。

## Issue情報:
- タイトル: ${issue.title}
- URL: ${issue.url}
- イベント数: ${issue.events}
- 最初の発生: ${issue.firstSeen}
- 最後の発生: ${issue.lastSeen}
${issue.assignee ? `- 担当者: ${issue.assignee}` : ''}

## 調査してほしいこと:
1. このエラーの詳細情報（スタックトレース、発生環境など）
2. エラーの発生パターンや傾向
3. 影響を受けているユーザー数
4. 関連する他のissueがあれば特定
5. 推奨される修正アプローチ

調査結果をマークダウン形式で整理して報告してください。
`.trim();

    try {
      const response = await issueResearchAgent.generate(prompt, {
        maxSteps: 10,
      });

      const investigation = response.text || '調査結果を取得できませんでした';

      console.log('=== Investigation Result ===');
      console.log(investigation);
      console.log('===========================');

      return {
        issue,
        investigation,
      };
    } catch (error) {
      console.error('Error in issueResearchAgent.generate:', error);

      // エラーの詳細情報を構造化して記録
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      let investigation = '## 調査中にエラーが発生しました\n\n';
      investigation += `**エラー概要**: ${errorMessage}\n\n`;

      // GitHub MCP接続エラーの場合は具体的なアドバイスを追加
      if (errorMessage.includes('Failed to connect to MCP server') ||
          errorMessage.includes('Could not connect to server')) {
        investigation += '### 考えられる原因\n\n';
        investigation += '1. **環境変数の未設定**: `GITHUB_MCP_TOKEN` が設定されていない可能性があります\n';
        investigation += '2. **トークンの無効化**: GitHub Personal Access Token が期限切れまたは無効化されている可能性があります\n';
        investigation += '3. **ネットワーク接続**: GitHub MCP サーバー（`https://api.githubcopilot.com/mcp/`）への接続に失敗している可能性があります\n';
        investigation += '4. **権限不足**: トークンに必要なスコープ（repo, read:org）が付与されていない可能性があります\n\n';
        investigation += '### 推奨対応\n\n';
        investigation += '- `.env` ファイルで `GITHUB_MCP_TOKEN` の設定を確認してください\n';
        investigation += '- トークンの有効性を https://github.com/settings/tokens で確認してください\n';
        investigation += '- 必要に応じて新しいトークンを作成してください（スコープ: repo, read:org）\n';
      }

      if (errorStack) {
        investigation += '\n### 詳細スタックトレース\n\n```\n' + errorStack + '\n```\n';
      }

      return {
        issue,
        investigation,
      };
    }
  },
});

/**
 * ステップ3の準備: Notion報告用にデータを準備
 */
const prepareNotionReporting = createStep({
  id: 'prepare-notion-reporting',
  description: 'Notion報告のためのデータ準備',
  inputSchema: z.array(
    z.object({
      issue: issueSchema,
      investigation: z.string(),
    })
  ),
  outputSchema: z.array(
    z.object({
      issue: issueSchema,
      investigation: z.string(),
    })
  ),
  execute: async ({ inputData }) => {
    return inputData;
  },
});

/**
 * Notion報告結果のスキーマ
 */
const notionReportResultSchema = z.object({
  issue: issueSchema,
  investigation: z.string(),
  notionPageUrl: z.string().nullable().describe('作成されたNotionページのURL'),
  success: z.boolean().describe('Notion報告の成功/失敗'),
});

/**
 * ステップ3-foreach: 個別issueの調査結果をNotionに報告
 */
const reportSingleIssueToNotion = createStep({
  id: 'report-single-issue-to-notion',
  description: '単一issueの調査結果をNotionに報告',
  inputSchema: z.object({
    issue: issueSchema,
    investigation: z.string(),
  }),
  outputSchema: notionReportResultSchema,
  execute: async ({ inputData }) => {
    const { issue, investigation } = inputData;

    console.log('=== Reporting to Notion ===');
    console.log('Title:', issue.title);
    console.log('URL:', issue.url);
    console.log('==========================');

    try {
      // ステップ1: Notion ページを作成（Issue情報のみ）
      const pageTitle = `Sentry Issue: ${issue.title}`;

      const issueInfoBlocks = [
        {
          object: 'block' as const,
          type: 'heading_2' as const,
          heading_2: {
            rich_text: [
              {
                type: 'text' as const,
                text: {
                  content: 'Issue情報',
                },
              },
            ],
          },
        },
        {
          object: 'block' as const,
          type: 'bulleted_list_item' as const,
          bulleted_list_item: {
            rich_text: [
              {
                type: 'text' as const,
                text: {
                  content: `タイトル: ${issue.title}`,
                },
              },
            ],
          },
        },
        {
          object: 'block' as const,
          type: 'bulleted_list_item' as const,
          bulleted_list_item: {
            rich_text: [
              {
                type: 'text' as const,
                text: {
                  content: 'URL: ',
                },
              },
              {
                type: 'text' as const,
                text: {
                  content: issue.url,
                  link: {
                    url: issue.url,
                  },
                },
              },
            ],
          },
        },
        {
          object: 'block' as const,
          type: 'bulleted_list_item' as const,
          bulleted_list_item: {
            rich_text: [
              {
                type: 'text' as const,
                text: {
                  content: `イベント数: ${issue.events}`,
                },
              },
            ],
          },
        },
        {
          object: 'block' as const,
          type: 'bulleted_list_item' as const,
          bulleted_list_item: {
            rich_text: [
              {
                type: 'text' as const,
                text: {
                  content: `最初の発生: ${issue.firstSeen}`,
                },
              },
            ],
          },
        },
        {
          object: 'block' as const,
          type: 'bulleted_list_item' as const,
          bulleted_list_item: {
            rich_text: [
              {
                type: 'text' as const,
                text: {
                  content: `最後の発生: ${issue.lastSeen}`,
                },
              },
            ],
          },
        },
        ...(issue.assignee
          ? [
              {
                object: 'block' as const,
                type: 'bulleted_list_item' as const,
                bulleted_list_item: {
                  rich_text: [
                    {
                      type: 'text' as const,
                      text: {
                        content: `担当者: ${issue.assignee}`,
                      },
                    },
                  ],
                },
              },
            ]
          : []),
      ];

      // 環境変数からNotion親ページIDを取得（設定されていない場合はエラー）
      const notionParentPageId = '299137fa-86a5-80ea-b239-de4819b28aff';
      const response = await notion.pages.create({
        parent: {
          page_id: notionParentPageId,
        },
        properties: {
          title: {
            title: [
              {
                type: 'text',
                text: {
                  content: pageTitle,
                },
              },
            ],
          },
        },
        children: issueInfoBlocks,
      });

      // PageObjectResponse の場合のみ url プロパティが存在する
      const notionPageUrl = 'url' in response ? response.url : null;
      const pageId = response.id;

      console.log('Page created:', notionPageUrl);

      // ステップ2: 調査結果を見出しで分割してブロックとして追加
      // まず「調査結果」見出しを追加
      await notion.blocks.children.append({
        block_id: pageId,
        children: [
          {
            object: 'block',
            type: 'heading_2',
            heading_2: {
              rich_text: [
                {
                  type: 'text',
                  text: {
                    content: '調査結果',
                  },
                },
              ],
            },
          },
        ],
      });

      // Rate limit対策: 1秒待機
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // 調査結果を見出しで分割してブロックに変換
      const investigationBlocks = parseInvestigationToBlocks(investigation);

      console.log(`Adding ${investigationBlocks.length} investigation blocks...`);

      // 調査結果のブロックを1つずつ追加（1秒間隔）
      for (let i = 0; i < investigationBlocks.length; i++) {
        const block = investigationBlocks[i];
        console.log(`Adding block ${i + 1}/${investigationBlocks.length}...`);

        await notion.blocks.children.append({
          block_id: pageId,
          children: [block],
        });

        // 最後のブロック以外は1秒待機
        if (i < investigationBlocks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      console.log('All blocks added successfully.');

      console.log('=== Notion Report Result ===');
      console.log('Success:', !!notionPageUrl);
      console.log('Page URL:', notionPageUrl);
      console.log('===========================');

      return {
        issue,
        investigation,
        notionPageUrl,
        success: !!notionPageUrl,
      };
    } catch (error) {
      console.error('Error reporting to Notion:', error);
      return {
        issue,
        investigation,
        notionPageUrl: null,
        success: false,
      };
    }
  },
});

/**
 * 最終出力のスキーマ
 */
const finalOutputSchema = z.object({
  summary: z.string().describe('調査結果の概要'),
  totalIssues: z.number().describe('総issue数'),
  successCount: z.number().describe('Notion報告成功数'),
  failureCount: z.number().describe('Notion報告失敗数'),
});

/**
 * ステップ4: 全結果を整形して概要を作成
 */
const summarizeResults = createStep({
  id: 'summarize-results',
  description: '全結果を整形して概要を作成',
  inputSchema: z.array(notionReportResultSchema),
  outputSchema: finalOutputSchema,
  execute: async ({ inputData }) => {
    const totalIssues = inputData.length;
    const successCount = inputData.filter((r) => r.success).length;
    const failureCount = totalIssues - successCount;

    let summary = `## Sentry調査ワークフロー 実行結果\n\n`;
    summary += `- 総Issue数: ${totalIssues}\n`;
    summary += `- Notion報告成功: ${successCount}\n`;
    summary += `- Notion報告失敗: ${failureCount}\n\n`;
    summary += `### 調査済みIssue一覧\n\n`;

    for (const result of inputData) {
      const status = result.success ? '✅' : '❌';
      summary += `${status} **${result.issue.title}**\n`;
      summary += `  - Sentry: ${result.issue.url}\n`;
      if (result.notionPageUrl) {
        summary += `  - Notion: ${result.notionPageUrl}\n`;
      }
      summary += `\n`;
    }

    console.log('=== Final Summary ===');
    console.log(summary);
    console.log('====================');

    return {
      summary,
      totalIssues,
      successCount,
      failureCount,
    };
  },
});


/**
 * Sentry調査ワークフロー
 */
export const sentryInvestigationWorkflow = createWorkflow({
  id: 'sentry-investigation-workflow',
  inputSchema: z.object({
    days: z.number().optional().default(7).describe('調査対象の日数(直近N日)'),
  }),
  outputSchema: finalOutputSchema,
})
  .then(pickIssuesStep)
  .then(prepareIssueInvestigation)
  .foreach(investigateSingleIssue, { concurrency: 5 })
  .then(prepareNotionReporting)
  .foreach(reportSingleIssueToNotion, { concurrency: 1 }) // notion APIのrate limitがあるため直列実行
  .then(summarizeResults);

sentryInvestigationWorkflow.commit();
