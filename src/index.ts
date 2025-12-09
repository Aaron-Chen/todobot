import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import { google } from 'googleapis';

// Load environment variables
dotenv.config();

// Validate environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT;

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is required');
}
if (!GOOGLE_SHEETS_ID) {
  throw new Error('GOOGLE_SHEETS_ID is required');
}
if (!GOOGLE_SERVICE_ACCOUNT) {
  throw new Error('GOOGLE_SERVICE_ACCOUNT is required');
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
const sheets = google.sheets({ version: 'v4', auth });

// Create Telegraf bot
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// Username to table start row mapping
// HE_3 table: starts at row 4, data starts at row 6
// AARON_3 table: starts at row 22, data starts at row 24
const USERNAME_TO_TABLE_START: Record<string, number> = {
  'hesong07': 6,   // HE_3 table data starts at row 6
  'boewu28': 24,  // AARON_3 table data starts at row 24
};

// Shortcut commands to username mapping
const SHORTCUT_TO_USERNAME: Record<string, string> = {
  'he': 'hesong07',
  'aaron': 'boewu28',
};

/**
 * Gets the end row for a table (where the next table starts, or a safe limit)
 * Returns the row BEFORE the next table starts, so we don't include the next table's header
 */
function getTableEndRow(username: string): number {
  const startRows = Object.values(USERNAME_TO_TABLE_START).sort((a, b) => a - b);
  const currentStart = USERNAME_TO_TABLE_START[username];
  
  // Find the next table's start row
  const nextTableStart = startRows.find(row => row > currentStart);
  
  // If there's a next table, stop 2 rows before it (to avoid the header row)
  // Otherwise, use a safe limit (current + 200)
  return nextTableStart ? nextTableStart - 2 : currentStart + 200;
}

/**
 * Gets the title of the leftmost sheet tab
 */
async function getLeftmostSheetTitle(): Promise<string> {
  const res = await sheets.spreadsheets.get({
    spreadsheetId: GOOGLE_SHEETS_ID,
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

/**
 * Finds the last non-empty row in column B (Purpose) starting from the given row
 * Returns the row number of the last row with data, or startRow - 1 if no data exists
 */
async function findLastDataRow(sheetTitle: string, startRow: number, endRow: number): Promise<number> {
  // Read a range starting from the table start row up to the end row (checking column B for Purpose)
  const range = `${sheetTitle}!B${startRow}:B${endRow}`;
  
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range,
  });

  const values = res.data.values || [];
  
  // Find the last non-empty row
  let lastRow = startRow - 1; // Default to row before start if no data
  
  for (let i = 0; i < values.length; i++) {
    if (values[i] && values[i].length > 0 && values[i][0] && values[i][0].trim() !== '') {
      lastRow = startRow + i;
    }
  }
  
  return lastRow;
}

/**
 * Adds a todo item to the specified user's table
 * Inserts a new row at the first data row position, shifting all existing rows down
 * This makes the newest item appear at the top of the table
 */
async function addTodoToTable(username: string, text: string): Promise<void> {
  const startRow = USERNAME_TO_TABLE_START[username];
  if (!startRow) {
    throw new Error(`Unknown username: @${username}. Supported usernames: ${Object.keys(USERNAME_TO_TABLE_START).map(u => `@${u}`).join(', ')}`);
  }

  const sheetTitle = await getLeftmostSheetTitle();
  
  console.log(`[DEBUG] Username: ${username}, StartRow: ${startRow}`);
  
  // The new row will be inserted at the first data row position (startRow)
  // This will push all existing rows down, making the newest item appear at the top
  const insertRow = startRow;
  
  console.log(`[DEBUG] Will insert at row: ${insertRow} (top of table)`);

  // Parse text: if it contains ",", split into purpose and goal
  // Otherwise, use the whole text as purpose and leave goal empty
  let purpose = text.trim();
  let goal = '';

  if (text.includes(',')) {
    const parts = text.split(',').map(p => p.trim());
    purpose = parts[0] || '';
    goal = parts.slice(1).join(',').trim(); // In case there are multiple commas, join the rest
  }

  // Get the sheet ID for the leftmost sheet
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: GOOGLE_SHEETS_ID,
  });
  
  if (!spreadsheet.data.sheets || spreadsheet.data.sheets.length === 0) {
    throw new Error('No sheets found in the spreadsheet');
  }
  
  const firstSheet = spreadsheet.data.sheets[0];
  const sheetId = firstSheet.properties?.sheetId;
  
  if (sheetId === undefined) {
    throw new Error('Could not get sheet ID');
  }

  // Insert a new row at insertRow and shift everything below down
  console.log(`[DEBUG] Inserting row at index ${insertRow - 1} (0-based)`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: GOOGLE_SHEETS_ID,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId: sheetId,
              dimension: 'ROWS',
              startIndex: insertRow - 1, // API uses 0-based indexing
              endIndex: insertRow, // Insert one row
            },
            inheritFromBefore: false,
          },
        },
      ],
    },
  });

  // Write the new data to the inserted row (columns B and C - Purpose and Goal)
  const range = `${sheetTitle}!B${insertRow}:C${insertRow}`;
  console.log(`[DEBUG] Writing to range: ${range}, Purpose: "${purpose}", Goal: "${goal}"`);
  
  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[purpose, goal]],
    },
  });
  
  console.log(`[DEBUG] Successfully added todo for ${username}`);
}

/**
 * Lists all todos for a user that are not done
 * Returns formatted string with numbered list
 */
async function listTodos(username: string): Promise<string> {
  const startRow = USERNAME_TO_TABLE_START[username];
  if (!startRow) {
    throw new Error(`Unknown username: @${username}. Supported usernames: ${Object.keys(USERNAME_TO_TABLE_START).map(u => `@${u}`).join(', ')}`);
  }

  const sheetTitle = await getLeftmostSheetTitle();
  const endRow = getTableEndRow(username);
  
  // Read columns B (Purpose), C (Goal), and D (Status)
  // We'll check column D for status, but handle cases where it might not exist
  const range = `${sheetTitle}!B${startRow}:D${endRow}`;
  
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEETS_ID,
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

/**
 * Helper function to handle adding todos (shared by /do, /he, /aaron commands)
 */
async function handleTodoCommand(ctx: any, username: string, text: string) {
  if (!text) {
    await ctx.reply('Please provide task text\nExample: /do @hesong07 add to the he table\nOr: /he add to my table');
    return;
  }

  // Parse text to get purpose and goal for the response message
  let purpose = text.trim();
  let goal = '';
  
  if (text.includes(',')) {
    const parts = text.split(',').map(p => p.trim());
    purpose = parts[0] || '';
    goal = parts.slice(1).join(',').trim();
  }

  await addTodoToTable(username, text);
  
  // Format response message
  let responseMessage = `✅ Added ${purpose}`;
  if (goal) {
    responseMessage += ` for ${goal}`;
  }
  responseMessage += ` to @${username}'s todo list`;
  
  await ctx.reply(responseMessage);
}

// Register /do command handler
bot.command('do', async (ctx) => {
  try {
    const commandText = ctx.message.text || '';
    
    // Remove '/do' prefix and trim
    const argsText = commandText.replace(/^\/do\s*/i, '').trim();
    
    let username: string;
    let text: string;
    
    // Check if user said "me" - self-assign task
    if (argsText.toLowerCase().startsWith('me ')) {
      // Get the Telegram username from the message sender
      const telegramUsername = ctx.from?.username;
      if (!telegramUsername) {
        await ctx.reply('❌ Could not determine your username. Please use /do @username text instead.');
        return;
      }
      
      // Check if the Telegram username matches a known table username
      if (!USERNAME_TO_TABLE_START[telegramUsername]) {
        await ctx.reply(`❌ Your username @${telegramUsername} is not registered. Please use /do @username text instead.`);
        return;
      }
      
      username = telegramUsername;
      text = argsText.substring(3).trim(); // Remove "me " prefix
    } else {
      // Regular usage: /do @username text
      if (!argsText) {
        await ctx.reply('Usage: /do @username text\nExample: /do @hesong07 add to the he table\nOr: /do @boewu28 task name, goal description\nOr: /do me task name, goal description (self-assign)');
        return;
      }
      
      // Find the username (starts with @, followed by alphanumeric/underscore)
      const usernameMatch = argsText.match(/^@(\w+)/);
      if (!usernameMatch) {
        await ctx.reply('Please mention a username starting with @\nExample: /do @hesong07 your task here\nOr use: /do me your task here (self-assign)');
        return;
      }
      
      username = usernameMatch[1];
      text = argsText.substring(usernameMatch[0].length).trim(); // Extract text after "@username"
    }
    
    await handleTodoCommand(ctx, username, text);
  } catch (error: any) {
    console.error('Error adding todo:', error);
    const errorMessage = error.message || 'Failed to add todo. Check logs for details.';
    await ctx.reply(`❌ ${errorMessage}`);
  }
});

// Register /he command handler (shortcut for HE's table)
bot.command('he', async (ctx) => {
  try {
    const commandText = ctx.message.text || '';
    const argsText = commandText.replace(/^\/he\s*/i, '').trim();
    
    if (!argsText) {
      await ctx.reply('Usage: /he task name, goal description\nExample: /he add to the he table, finish by Friday');
      return;
    }
    
    await handleTodoCommand(ctx, 'hesong07', argsText);
  } catch (error: any) {
    console.error('Error adding todo:', error);
    const errorMessage = error.message || 'Failed to add todo. Check logs for details.';
    await ctx.reply(`❌ ${errorMessage}`);
  }
});

// Register /aaron command handler (shortcut for Aaron's table)
bot.command('aaron', async (ctx) => {
  try {
    const commandText = ctx.message.text || '';
    const argsText = commandText.replace(/^\/aaron\s*/i, '').trim();
    
    if (!argsText) {
      await ctx.reply('Usage: /aaron task name, goal description\nExample: /aaron add to aaron table, finish by Friday');
      return;
    }
    
    await handleTodoCommand(ctx, 'boewu28', argsText);
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
    
    let username: string;
    
    // If no argument, try to detect user from Telegram username
    if (!argsText) {
      const telegramUsername = ctx.from?.username;
      if (telegramUsername && USERNAME_TO_TABLE_START[telegramUsername]) {
        username = telegramUsername;
      } else {
        await ctx.reply('Usage: /list [@username]\nExample: /list @hesong07\nOr: /list @boewu28\nOr: /list (to see your own list if you\'re registered)');
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
    
    const listMessage = await listTodos(username);
    await ctx.reply(listMessage);
  } catch (error: any) {
    console.error('Error listing todos:', error);
    const errorMessage = error.message || 'Failed to list todos. Check logs for details.';
    await ctx.reply(`❌ ${errorMessage}`);
  }
});

// Start the bot
bot.launch().then(() => {
  console.log('Bot started');
});

// Handle graceful shutdown
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  process.exit(0);
});

