import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { Client } from '@notionhq/client';
import { issueResearchAgent } from '../agents/issue-research-agent';
import { searchIssues, type SentryConfig } from '../clients/sentry-api';

// Sentry設定の初期化
function envOrThrow(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

// Notion クライアントの初期化
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const notionParentPageId = '299137fa-86a5-80ea-b239-de4819b28aff';

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
 * Notion API の直列化用レートリミッタ
 * foreach で並列調査中も Notion 呼び出しのみを順番に実行する
 */
class SerialLimiter {
  private last: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.last.then(fn, fn);
    this.last = next.then(() => undefined, () => undefined);
    return next;
  }
}
const notionLimiter = new SerialLimiter();

/**
 * リトライユーティリティ（指数バックオフ＋ジッター）
 * 5xx、ネットワークエラー、Cloudflareプロキシエラーを自動リトライ
 */
async function withRetry<T>(
  op: () => Promise<T>,
  opts = { retries: 6, baseMs: 500, maxMs: 8000 }
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await op();
    } catch (err: any) {
      attempt++;
      const status = err?.status ?? err?.code;

      // 一時的障害の判定
      const transient =
        // Notion/CDN/ネットワークの一時障害を広めに拾う
        (typeof status === 'number' && status >= 500) ||
        err?.code === 'ECONNRESET' ||
        err?.code === 'ETIMEDOUT' ||
        err?.message?.includes('http_response_incomplete') ||
        err?.message?.includes('proxy-status');

      // 429 レート制限の特別処理
      if (status === 429) {
        const retryAfter = Number(err.headers?.['retry-after']) || 1;
        console.warn(`Rate limited (429). Waiting ${retryAfter}s before retry...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }

      // リトライ不可または上限到達時はエラーを投げる
      if (!transient || attempt > opts.retries) {
        // デバッグ情報をログ出力
        console.error('Request failed after retries:', {
          attempt,
          status,
          code: err?.code,
          message: err?.message,
          cfRay: err?.headers?.['cf-ray'],
          proxyStatus: err?.headers?.['proxy-status'],
        });
        throw err;
      }

      // 退避：指数バックオフ＋フルジッター
      const delay = Math.min(opts.maxMs, Math.random() * (opts.baseMs * 2 ** attempt));
      console.warn(`Transient error detected (attempt ${attempt}/${opts.retries}). Retrying in ${Math.round(delay)}ms...`, {
        status,
        code: err?.code,
        message: err?.message?.substring(0, 100),
      });
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Sentry: 最新イベントから例外スタックトレースを取得してテキスト化
 * - issue.permalink (例: https://sentry.io/organizations/.../issues/1234567890/?...) から issueId を抽出
 * - GET /api/0/issues/{issue_id}/events/latest/
 * - exception エントリの stacktrace を可読テキスト化
 */
async function fetchLatestSentryStacktraceText(issuePermalink: string): Promise<string | null> {
  const match = issuePermalink.match(/\/issues\/(\d+)\//);
  const issueId = match?.[1];
  if (!issueId) {
    console.warn('Could not extract issueId from permalink:', issuePermalink);
    return null;
  }

  const url = `${sentryCfg.baseUrl}/api/0/issues/${issueId}/events/latest/`;

  const json = await withRetry(async () => {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${sentryCfg.authToken}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`Sentry latest event fetch failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  });

  // entries[].type === 'exception' を探す
  const entries = json?.entries ?? [];
  const exceptionEntry = entries.find((e: any) => e?.type === 'exception');
  const values = exceptionEntry?.data?.values ?? [];

  if (!values.length) {
    // 例外エントリが無い場合はイベント全体をサマリ出力（サイズ上限をかける）
    return `No exception entry in latest event.\n\n` +
           JSON.stringify(json, null, 2).slice(0, 20000);
  }

  // スタックをテキストに整形
  let out = '';
  for (const v of values) {
    const type = v?.type ?? 'Error';
    const value = v?.value ?? '';
    const mech = v?.mechanism?.type ? ` (${v.mechanism.type})` : '';
    out += `${type}: ${value}${mech}\n`;
    // Sentry は frames が古→新のことが多いので、新しい順で見やすく
    const frames = (v?.stacktrace?.frames ?? []).slice().reverse();
    for (const f of frames) {
      const fn = f?.function || '<anonymous>';
      const file = f?.filename ?? f?.abs_path ?? 'unknown';
      const line = f?.lineno ?? '?';
      const col = f?.colno ?? '?';
      out += `  at ${fn} (${file}:${line}:${col})\n`;
    }
    out += '\n';
  }

  // Safety: Notion 文字量や prompt サイズを圧迫しすぎないように上限
  return out.slice(0, 20000);
}

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
 * 調査結果のテキストを改行ごとにNotionブロックの配列に変換
 * - ## で見出し2ブロック
 * - ### で見出し3ブロック
 * - それ以外は段落ブロック（1行 = 1ブロック）
 * - 各テキストが2000文字を超える場合はさらに分割
 */
const parseInvestigationToBlocks = (text: string): NotionBlock[] => {
  const lines = text.split('\n');
  const blocks: NotionBlock[] = [];

  for (const line of lines) {
    if (line.startsWith('### ')) {
      // 見出し3を追加
      blocks.push(createHeading3Block(line.replace('### ', '')));
    } else if (line.startsWith('## ')) {
      // 見出し2を追加
      blocks.push(createHeading2Block(line.replace('## ', '')));
    } else if (line.trim()) {
      // 空行でない場合は段落ブロックを追加（1行 = 1ブロック）
      blocks.push(...createParagraphBlocks(line));
    }
    // 空行はスキップ
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

// foreach は Issue 単体を受け取る
const investigateInputSchema = issueSchema;

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
 * ステップ1: SentryからissueをAPI経由で直接検索
 */
const pickIssuesStep = createStep({
  id: 'pick-issues',
  description: 'SentryからissueをAPI経由で直接検索',
  inputSchema: z.object({
    days: z.number().optional().default(7).describe('調査対象の日数(直近N日)'),
  }),
  outputSchema: z.array(investigateInputSchema),
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
      type IssueType = z.infer<typeof issueSchema>;
      const issues: IssueType[] = data.map((issue: any) => {
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

      // 上位2件のみ次ステップへ
      const top2 = issues.slice(0, 2);
      console.log(`Limiting to top ${top2.length} issues`);

      return top2;
    } catch (error) {
      console.error('Error fetching Sentry issues:', error);
      throw error;
    }
  },
});

/**
 * ステップ2: 個別issueの詳細を調査し、Notionに報告
 */
const investigateSingleIssue = createStep({
  id: 'investigate-single-issue',
  description: '単一issueの詳細を調査し、Notionに報告',
  inputSchema: investigateInputSchema,
  outputSchema: notionReportResultSchema,
  execute: async ({ inputData }) => {
    const issue = inputData;

    console.log('=== Investigating Issue ===');
    console.log('Title:', issue.title);
    console.log('URL:', issue.url);
    console.log('=========================');

    // Sentry 最新イベントのスタックトレースを取得
    let stacktraceText: string | null = null;
    try {
      stacktraceText = await fetchLatestSentryStacktraceText(issue.url);
    } catch (e) {
      console.warn('Failed to fetch Sentry stacktrace:', (e as any)?.message ?? e);
    }

    // スタックトレースは冒頭と末尾だけ抜粋（トークン抑制）
    function compactText(input: string, keep = 2000) {
      if (!input) return '';
      if (input.length <= keep * 2) return input;
      const head = input.slice(0, keep);
      const tail = input.slice(-keep);
      const omitted = input.length - head.length - tail.length;
      return `${head}\n...<omitted ${omitted} chars>...\n${tail}`;
    }
    const condensedStack = stacktraceText ? compactText(stacktraceText, 2000) : null;

    const prompt = `
以下のSentry issueについて、詳細に調査してください。

## Issue情報:
- タイトル: ${issue.title}
- URL: ${issue.url}
- イベント数: ${issue.events}
- 最初の発生: ${issue.firstSeen}
- 最後の発生: ${issue.lastSeen}
${issue.assignee ? `- 担当者: ${issue.assignee}` : ''}

${condensedStack ? `## Sentryスタックトレース（要点抜粋）\n\`\`\`\n${condensedStack}\n\`\`\`\n` : ''}

## 調査してほしいこと:
1. エラーの詳細情報（スタックトレース、発生環境など）
2. エラーの発生箇所と発生原因
3. 詳しい人の抽出（関連ファイルの直近のコミット履歴から最大3名）

調査結果をマークダウン形式で整理して報告してください。

## フォーマット:

\`\`\`
## エラーの詳細情報

{詳細情報}

## 発生箇所と発生原因

{発生箇所と発生原因の調査結果}

## 詳しい人

{リスト形式で最大3名(理由つき)}
\`\`\`
`.trim();

    console.log('=== Prompt Preview (first 500 chars) ===');
    console.log(prompt.slice(0, 500));

    let investigation: string;

    try {
      console.log('=== Calling issueResearchAgent.generate ===');
      console.log('Prompt length:', prompt.length);
      console.log('maxSteps:', 10);

      const response = await issueResearchAgent.generate(prompt, {
        maxSteps: 10,
      });

      console.log('=== Agent Response Debug ===');
      console.log('Response object keys:', Object.keys(response));

      // レスポンスの各プロパティの値を確認（冒頭のみ）
      console.log('\n--- Response Properties ---');
      Object.keys(response).forEach((key) => {
        const value = (response as any)[key];
        const valueType = typeof value;

        if (value === null) {
          console.log(`${key}: null`);
        } else if (value === undefined) {
          console.log(`${key}: undefined`);
        } else if (valueType === 'string') {
          console.log(`${key} (string, length ${value.length}):`, value.slice(0, 200));
        } else if (valueType === 'number' || valueType === 'boolean') {
          console.log(`${key} (${valueType}):`, value);
        } else if (Array.isArray(value)) {
          console.log(`${key} (array, length ${value.length}):`, `[${value.length} items]`);
        } else if (valueType === 'object') {
          const objKeys = Object.keys(value);
          console.log(`${key} (object, ${objKeys.length} keys):`, objKeys.slice(0, 10));
        } else {
          console.log(`${key} (${valueType}):`, String(value).slice(0, 100));
        }
      });

      console.log('\n--- response.text Details ---');
      console.log('Type:', typeof response.text);
      console.log('Length:', response.text?.length ?? 0);
      console.log('Value (first 500 chars):', response.text ? String(response.text).slice(0, 500) : '(empty)');
      console.log('Value (last 200 chars):', response.text && response.text.length > 200 ? String(response.text).slice(-200) : '(n/a)');

      // Steps の詳細調査
      console.log('\n=== Steps Analysis ===');
      const steps = (response as any)?.steps;
      if (steps && Array.isArray(steps)) {
        console.log(`Total steps: ${steps.length}`);
        steps.forEach((step: any, idx: number) => {
          console.log(`\n--- Step ${idx + 1} ---`);
          console.log('Step keys:', Object.keys(step));

          // 各プロパティの値を確認
          console.log('Step properties:');
          Object.keys(step).forEach((key) => {
            const value = step[key];
            const valueType = typeof value;

            if (value === null || value === undefined) {
              console.log(`  ${key}: ${value}`);
            } else if (valueType === 'string') {
              console.log(`  ${key} (string, ${value.length} chars):`, value.slice(0, 100));
            } else if (valueType === 'number' || valueType === 'boolean') {
              console.log(`  ${key}:`, value);
            } else if (Array.isArray(value)) {
              console.log(`  ${key}: [array, ${value.length} items]`);
            } else if (valueType === 'object') {
              console.log(`  ${key}: {object, ${Object.keys(value).length} keys}`);
            }
          });

          console.log('Step type:', step?.stepType || step?.type);

          // text が存在する場合のみ slice
          const stepText = step?.text;
          if (stepText && typeof stepText === 'string') {
            console.log('Step text (first 200 chars):', stepText.slice(0, 200));
          } else {
            console.log('Step text: (none)');
          }

          // ToolCalls の詳細（複数の可能性のある構造に対応）
          const toolCalls = step?.toolCalls || step?.dynamicToolCalls || step?.staticToolCalls;
          if (toolCalls && Array.isArray(toolCalls)) {
            console.log(`\nTool calls: ${toolCalls.length}`);
            toolCalls.forEach((tc: any, tcIdx: number) => {
              console.log(`\n  === Tool Call ${tcIdx + 1} ===`);
              console.log('  Keys:', Object.keys(tc));

              // 各プロパティの値を確認
              console.log('  Properties:');
              Object.keys(tc).forEach((key) => {
                const value = tc[key];
                const valueType = typeof value;

                if (value === null || value === undefined) {
                  console.log(`    ${key}: ${value}`);
                } else if (valueType === 'string') {
                  console.log(`    ${key} (string, ${value.length} chars):`, value.slice(0, 100));
                } else if (valueType === 'number' || valueType === 'boolean') {
                  console.log(`    ${key}:`, value);
                } else if (Array.isArray(value)) {
                  console.log(`    ${key}: [array, ${value.length} items]`);
                } else if (valueType === 'object') {
                  const objKeys = Object.keys(value);
                  console.log(`    ${key}: {object, ${objKeys.length} keys}`, objKeys.slice(0, 5));
                }
              });

              console.log('  Extracted values:');
              console.log('    Name:', tc?.toolName || tc?.name || tc?.type);
              console.log('    IsError:', tc?.isError || tc?.error);
              console.log('    Error:', tc?.error || tc?.errorMessage);

              // Result の確認
              const result = tc?.result || tc?.output;
              if (result) {
                if (typeof result === 'object') {
                  console.log('    Result keys:', Object.keys(result));
                  const resultStr = JSON.stringify(result);
                  if (resultStr && resultStr.length > 0) {
                    console.log('    Result (first 300 chars):', resultStr.slice(0, 300));
                  }
                } else {
                  console.log('    Result (non-object):', String(result).slice(0, 300));
                }
              } else {
                console.log('    Result: (none)');
              }
            });
          } else {
            console.log('\nNo tool calls in this step');
          }
        });
      } else {
        console.log('No steps found in response');
      }

      // Messages の確認
      console.log('\n=== Messages Analysis ===');
      const messages = (response as any)?.messages;
      if (messages && Array.isArray(messages)) {
        console.log(`Total messages: ${messages.length}`);
        messages.forEach((msg: any, idx: number) => {
          console.log(`\n--- Message ${idx + 1} ---`);
          console.log('Role:', msg?.role);
          console.log('Content type:', typeof msg?.content);

          // content を安全に処理
          const content = msg?.content;
          if (content) {
            const contentStr = JSON.stringify(content);
            if (contentStr && contentStr.length > 0) {
              console.log('Content (truncated):', contentStr.slice(0, 300));
            } else {
              console.log('Content: (empty string)');
            }
          } else {
            console.log('Content: (none)');
          }
        });
      } else {
        console.log('No messages found in response');
      }
      console.log('===========================');

      // 空テキストは失敗として扱い、エラーメッセージを記録する
      if (!response.text || !response.text.trim()) {
        console.warn('!!! Empty response detected !!!');

        const toolErrors =
          (response as any)?.steps?.flatMap((s: any) => s?.toolCalls ?? [])
            .filter((tc: any) => tc?.isError)
            .map((tc: any) => `- ${tc?.toolName ?? 'tool'}: ${tc?.error ?? 'unknown error'}`) ?? [];

        console.log('Tool errors found:', toolErrors.length);

        // すべてのツール呼び出しの結果を確認
        const allToolCalls = (response as any)?.steps?.flatMap((s: any) => s?.toolCalls ?? []) ?? [];
        console.log('All tool calls count:', allToolCalls.length);
        allToolCalls.forEach((tc: any, idx: number) => {
          console.log(`Tool call ${idx + 1}: ${tc?.toolName}, isError: ${tc?.isError}`);
        });

        let reason = '';
        if (toolErrors.length > 0) {
          reason = `ツール実行時にエラーが発生しました:\n${toolErrors.join('\n')}`;
        } else if (allToolCalls.length === 0) {
          reason = 'エージェントがツールを使用せずに空の応答を返しました。プロンプトの問題またはエージェントの初期化失敗の可能性があります。';
        } else {
          reason = `エージェントから空の応答が返されました。\n- ツール呼び出し数: ${allToolCalls.length}\n- エラー数: ${toolErrors.length}\n- GitHub API のレート制限またはツール失敗の可能性があります。`;
        }

        investigation = `## 調査に失敗しました\n\n${reason}\n\n### デバッグ情報\n- Steps: ${steps?.length ?? 0}\n- Tool calls: ${allToolCalls.length}\n- Response keys: ${Object.keys(response).join(', ')}\n`;
      } else {
        investigation = response.text;
      }

      console.log('=== Investigation Result ===');
      console.log('Final investigation length:', investigation.length);
      console.log('Final investigation:', investigation);
      console.log('===========================');
    } catch (error) {
      console.error('Error in issueResearchAgent.generate:', error);

      // エラーの詳細情報を構造化して記録
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      investigation = '## 調査中にエラーが発生しました\n\n';
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
    }

    // Notion 作成処理を直列化
    const { notionPageUrl, success } = await notionLimiter.run(async () => {
      try {
        console.log('=== Reporting to Notion ===');
        console.log('Title:', issue.title);
        console.log('==========================');

        // ページタイトルと Issue 情報ブロック作成
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

        // Notion ページ作成（リトライ付き）
        const page = await withRetry(() =>
          notion.pages.create({
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
          })
        );

        const pageId = page.id;
        const createdUrl = 'url' in page ? page.url : null;

        console.log('Page created:', createdUrl);

        // 「調査結果」見出し追加（リトライ付き）
        await withRetry(() =>
          notion.blocks.children.append({
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
          })
        );

        // Rate limit 対策: 軽い間隔
        await new Promise((resolve) => setTimeout(resolve, 400));

        // 調査結果をブロック化
        const investigationBlocks = parseInvestigationToBlocks(investigation);

        console.log(`Adding ${investigationBlocks.length} investigation blocks...`);

        // バルク追加（50件ずつのチャンクに分けて送信）
        const CHUNK_SIZE = 50;
        for (let i = 0; i < investigationBlocks.length; i += CHUNK_SIZE) {
          const chunk = investigationBlocks.slice(i, i + CHUNK_SIZE);
          console.log(`Adding blocks ${i + 1}-${Math.min(i + CHUNK_SIZE, investigationBlocks.length)}/${investigationBlocks.length}...`);

          await withRetry(() =>
            notion.blocks.children.append({
              block_id: pageId,
              children: chunk,
            })
          );

          // 軽い間隔（混雑時の平準化）
          if (i + CHUNK_SIZE < investigationBlocks.length) {
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
        }

        console.log('All blocks added successfully.');

        return { notionPageUrl: createdUrl, success: !!createdUrl };
      } catch (error: any) {
        // 詳細なエラー情報をログ出力（トレーサビリティ向上）
        console.error('Error reporting to Notion inside investigateSingleIssue:', {
          message: error?.message,
          status: error?.status,
          code: error?.code,
          cfRay: error?.headers?.['cf-ray'],
          proxyStatus: error?.headers?.['proxy-status'],
          requestId: error?.headers?.['x-request-id'],
          stack: error?.stack?.substring(0, 500), // スタックトレースの一部
        });
        return { notionPageUrl: null, success: false };
      }
    });

    // ★ 各 Issue ごとに 1 分待機（rate limit 衝突回避）
    try {
      console.log('=== Cooldown: waiting 60s for rate-limit safety ===');
      await new Promise((r) => setTimeout(r, 60_000));
    } catch {}

    return {
      issue,
      investigation,
      notionPageUrl,
      success,
    };
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
  // ★ 順次実行に変更（rate limit 衝突を避ける）
  .foreach(investigateSingleIssue, { concurrency: 1 })
  .then(summarizeResults);

sentryInvestigationWorkflow.commit();
