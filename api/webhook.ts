import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Telegraf } from 'telegraf';
import { google } from 'googleapis';

// Initialize bot and sheets clients (reused across requests)
let bot: Telegraf | null = null;
let sheets: any = null;

function initializeBot() {
  if (bot) return bot;

  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
  const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT;

  if (!TELEGRAM_BOT_TOKEN || !GOOGLE_SHEETS_ID || !GOOGLE_SERVICE_ACCOUNT) {
    throw new Error('Missing required environment variables');
  }

  // Parse service account JSON
  let serviceAccountCredentials: any;
  try {
    serviceAccountCredentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
  } catch (error) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT must be valid JSON');
  }

  // Create Google auth client
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccountCredentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  // Create Sheets client
  sheets = google.sheets({ version: 'v4', auth });

  // Create Telegraf bot
  bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  // Import shared functions and register handlers
  setupBotHandlers(bot, sheets, GOOGLE_SHEETS_ID);

  return bot;
}

// Username to table start row mapping
const USERNAME_TO_TABLE_START: Record<string, number> = {
  'hesong07': 6,   // HE_3 table data starts at row 6
  'boewu28': 24,  // AARON_3 table data starts at row 24
};

async function getLeftmostSheetTitle(sheetsClient: any, spreadsheetId: string): Promise<string> {
  const res = await sheetsClient.spreadsheets.get({
    spreadsheetId,
  });

  if (!res.data.sheets || res.data.sheets.length === 0) {
    throw new Error('No sheets found in the spreadsheet');
  }

  const firstSheet = res.data.sheets[0];
  if (!firstSheet.properties || !firstSheet.properties.title) {
    throw new Error('First sheet has no title');
  }

  return firstSheet.properties.title;
}

async function addTodoToTable(
  sheetsClient: any,
  spreadsheetId: string,
  username: string,
  text: string
): Promise<void> {
  const startRow = USERNAME_TO_TABLE_START[username];
  if (!startRow) {
    throw new Error(`Unknown username: @${username}. Supported usernames: ${Object.keys(USERNAME_TO_TABLE_START).map(u => `@${u}`).join(', ')}`);
  }

  const sheetTitle = await getLeftmostSheetTitle(sheetsClient, spreadsheetId);
  const insertRow = startRow;

  // Parse text: if it contains ",", split into purpose and goal
  let purpose = text.trim();
  let goal = '';

  if (text.includes(',')) {
    const parts = text.split(',').map(p => p.trim());
    purpose = parts[0] || '';
    goal = parts.slice(1).join(',').trim();
  }

  // Get the sheet ID
  const spreadsheet = await sheetsClient.spreadsheets.get({
    spreadsheetId,
  });
  
  if (!spreadsheet.data.sheets || spreadsheet.data.sheets.length === 0) {
    throw new Error('No sheets found in the spreadsheet');
  }
  
  const firstSheet = spreadsheet.data.sheets[0];
  const sheetId = firstSheet.properties?.sheetId;
  
  if (sheetId === undefined) {
    throw new Error('Could not get sheet ID');
  }

  // Insert a new row at insertRow
  await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId: sheetId,
              dimension: 'ROWS',
              startIndex: insertRow - 1,
              endIndex: insertRow,
            },
            inheritFromBefore: false,
          },
        },
      ],
    },
  });

  // Write the new data
  const range = `${sheetTitle}!B${insertRow}:C${insertRow}`;
  
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[purpose, goal]],
    },
  });
}

async function handleTodoCommand(
  ctx: any,
  sheetsClient: any,
  spreadsheetId: string,
  username: string,
  text: string
) {
  if (!text) {
    await ctx.reply('Please provide task text\nExample: /do @hesong07 add to the he table\nOr: /he add to my table');
    return;
  }

  let purpose = text.trim();
  let goal = '';
  
  if (text.includes(',')) {
    const parts = text.split(',').map(p => p.trim());
    purpose = parts[0] || '';
    goal = parts.slice(1).join(',').trim();
  }

  await addTodoToTable(sheetsClient, spreadsheetId, username, text);
  
  let responseMessage = `✅ Added ${purpose}`;
  if (goal) {
    responseMessage += ` for ${goal}`;
  }
  responseMessage += ` to @${username}'s todo list`;
  
  await ctx.reply(responseMessage);
}

function setupBotHandlers(bot: Telegraf, sheetsClient: any, spreadsheetId: string) {
  // Register /do command handler
  bot.command('do', async (ctx) => {
    try {
      const commandText = ctx.message.text || '';
      const argsText = commandText.replace(/^\/do\s*/i, '').trim();
      
      let username: string;
      let text: string;
      
      if (argsText.toLowerCase().startsWith('me ')) {
        const telegramUsername = ctx.from?.username;
        if (!telegramUsername) {
          await ctx.reply('❌ Could not determine your username. Please use /do @username text instead.');
          return;
        }
        
        if (!USERNAME_TO_TABLE_START[telegramUsername]) {
          await ctx.reply(`❌ Your username @${telegramUsername} is not registered. Please use /do @username text instead.`);
          return;
        }
        
        username = telegramUsername;
        text = argsText.substring(3).trim();
      } else {
        if (!argsText) {
          await ctx.reply('Usage: /do @username text\nExample: /do @hesong07 add to the he table\nOr: /do @boewu28 task name, goal description\nOr: /do me task name, goal description (self-assign)');
          return;
        }
        
        const usernameMatch = argsText.match(/^@(\w+)/);
        if (!usernameMatch) {
          await ctx.reply('Please mention a username starting with @\nExample: /do @hesong07 your task here\nOr use: /do me your task here (self-assign)');
          return;
        }
        
        username = usernameMatch[1];
        text = argsText.substring(usernameMatch[0].length).trim();
      }
      
      await handleTodoCommand(ctx, sheetsClient, spreadsheetId, username, text);
    } catch (error: any) {
      console.error('Error adding todo:', error);
      const errorMessage = error.message || 'Failed to add todo. Check logs for details.';
      await ctx.reply(`❌ ${errorMessage}`);
    }
  });

  // Register /he command handler
  bot.command('he', async (ctx) => {
    try {
      const commandText = ctx.message.text || '';
      const argsText = commandText.replace(/^\/he\s*/i, '').trim();
      
      if (!argsText) {
        await ctx.reply('Usage: /he task name, goal description\nExample: /he add to the he table, finish by Friday');
        return;
      }
      
      await handleTodoCommand(ctx, sheetsClient, spreadsheetId, 'hesong07', argsText);
    } catch (error: any) {
      console.error('Error adding todo:', error);
      const errorMessage = error.message || 'Failed to add todo. Check logs for details.';
      await ctx.reply(`❌ ${errorMessage}`);
    }
  });

  // Register /aaron command handler
  bot.command('aaron', async (ctx) => {
    try {
      const commandText = ctx.message.text || '';
      const argsText = commandText.replace(/^\/aaron\s*/i, '').trim();
      
      if (!argsText) {
        await ctx.reply('Usage: /aaron task name, goal description\nExample: /aaron add to aaron table, finish by Friday');
        return;
      }
      
      await handleTodoCommand(ctx, sheetsClient, spreadsheetId, 'boewu28', argsText);
    } catch (error: any) {
      console.error('Error adding todo:', error);
      const errorMessage = error.message || 'Failed to add todo. Check logs for details.';
      await ctx.reply(`❌ ${errorMessage}`);
    }
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Telegram requires 200 OK response immediately, even if processing fails
  // So we send the response first, then process the update
  res.status(200).json({ ok: true });

  // Now process the update asynchronously
  try {
    const botInstance = initializeBot();
    await botInstance.handleUpdate(req.body);
  } catch (error: any) {
    // Log errors but don't fail the webhook response
    // Telegram already got 200 OK, so it won't retry
    console.error('Webhook processing error:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      envVars: {
        hasToken: !!process.env.TELEGRAM_BOT_TOKEN,
        hasSheetsId: !!process.env.GOOGLE_SHEETS_ID,
        hasServiceAccount: !!process.env.GOOGLE_SERVICE_ACCOUNT,
      }
    });
  }
}

