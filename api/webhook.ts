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

function getTableEndRow(username: string): number {
  const startRows = Object.values(USERNAME_TO_TABLE_START).sort((a, b) => a - b);
  const currentStart = USERNAME_TO_TABLE_START[username];
  
  // Find the next table's start row
  const nextTableStart = startRows.find(row => row > currentStart);
  
  // If there's a next table, stop 2 rows before it (to avoid the header row)
  // Otherwise, use a safe limit (current + 200)
  return nextTableStart ? nextTableStart - 2 : currentStart + 200;
}

async function listTodos(
  sheetsClient: any,
  spreadsheetId: string,
  username: string
): Promise<string> {
  const startRow = USERNAME_TO_TABLE_START[username];
  if (!startRow) {
    throw new Error(`Unknown username: @${username}. Supported usernames: ${Object.keys(USERNAME_TO_TABLE_START).map(u => `@${u}`).join(', ')}`);
  }

  const sheetTitle = await getLeftmostSheetTitle(sheetsClient, spreadsheetId);
  const endRow = getTableEndRow(username);
  
  // Read columns B (Purpose), C (Goal), and D (Status)
  // We'll check column D for status, but handle cases where it might not exist
  const range = `${sheetTitle}!B${startRow}:D${endRow}`;
  
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const values = res.data.values || [];
  const todos: Array<{ purpose: string; goal: string }> = [];
  
  // Filter tasks that are not done
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (!row || row.length === 0) continue;
    
    const purpose = row[0]?.trim() || '';
    const goal = row[1]?.trim() || '';
    const status = (row[2]?.trim() || '').toLowerCase();
    
    // Skip empty rows
    if (!purpose) continue;
    
    // Skip tasks marked as "done" (case-insensitive)
    if (status === 'done') continue;
    
    todos.push({ purpose, goal });
  }
  
  // Format as numbered list
  if (todos.length === 0) {
    return `📋 No pending tasks for @${username}`;
  }
  
  let message = `📋 Tasks for @${username}:\n\n`;
  todos.forEach((todo, index) => {
    const number = index + 1;
    if (todo.goal) {
      message += `${number}. ${todo.purpose} (${todo.goal})\n`;
    } else {
      message += `${number}. ${todo.purpose}\n`;
    }
  });
  
  return message.trim();
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

  // Register /list command handler
  bot.command('list', async (ctx) => {
    try {
      const commandText = ctx.message.text || '';
      const argsText = commandText.replace(/^\/list\s*/i, '').trim();
      
      // Shortcut commands to username mapping
      const SHORTCUT_TO_USERNAME: Record<string, string> = {
        'he': 'hesong07',
        'aaron': 'boewu28',
      };
      
      let username: string;
      
      // If no argument, try to detect user from Telegram username
      if (!argsText) {
        const telegramUsername = ctx.from?.username;
        if (telegramUsername && USERNAME_TO_TABLE_START[telegramUsername]) {
          username = telegramUsername;
        } else {
          await ctx.reply('Usage: /list [@username]\nExample: /list @hesong07\nOr: /list @boewu28\nOr: /list he\nOr: /list aaron\nOr: /list (to see your own list if you\'re registered)');
          return;
        }
      } else {
        // Check if user specified a username or shortcut
        const usernameMatch = argsText.match(/^@?(\w+)/);
        if (usernameMatch) {
          const inputUsername = usernameMatch[1].toLowerCase();
          
          // Check if it's a shortcut
          if (SHORTCUT_TO_USERNAME[inputUsername]) {
            username = SHORTCUT_TO_USERNAME[inputUsername];
          } else if (USERNAME_TO_TABLE_START[inputUsername]) {
            username = inputUsername;
          } else {
            await ctx.reply(`❌ Unknown username: @${inputUsername}\nSupported: @hesong07, @boewu28, or shortcuts: he, aaron`);
            return;
          }
        } else {
          await ctx.reply('Usage: /list [@username]\nExample: /list @hesong07\nOr: /list he\nOr: /list aaron');
          return;
        }
      }
      
      const listMessage = await listTodos(sheetsClient, spreadsheetId, username);
      await ctx.reply(listMessage);
    } catch (error: any) {
      console.error('Error listing todos:', error);
      const errorMessage = error.message || 'Failed to list todos. Check logs for details.';
      await ctx.reply(`❌ ${errorMessage}`);
    }
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Telegram requires 200 OK response immediately, even if processing fails
  try {
    // Immediately send 200 OK to Telegram - this is critical!
    res.status(200).json({ ok: true });
    
    // Process the update asynchronously (don't await - let it run in background)
    // This ensures Telegram gets the response immediately
    setImmediate(async () => {
      try {
        if (!req.body) {
          console.error('No request body received');
          return;
        }
        
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
    });
  } catch (error: any) {
    // If even sending the response fails, log it but still try to send 200
    console.error('Critical error in webhook handler:', error);
    try {
      res.status(200).json({ ok: true });
    } catch (e) {
      // Last resort - if we can't send response, log it
      console.error('Failed to send response to Telegram:', e);
    }
  }
}

