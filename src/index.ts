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

// Username to approximate search range mapping (where to look for header row)
// These are approximate ranges to search for the "Purpose", "Goal", "Status" header row
const USERNAME_TO_SEARCH_RANGE: Record<string, { start: number; end: number }> = {
  'hesong07': { start: 1, end: 20 },   // Search rows 1-20 for He's table header
  'boewu28': { start: 15, end: 35 },  // Search rows 15-35 for Aaron's table header
};

// Shortcut commands to username mapping
const SHORTCUT_TO_USERNAME: Record<string, string> = {
  'he': 'hesong07',
  'aaron': 'boewu28',
};

/**
 * Finds the header row containing "Purpose", "Goal", "Status" for a user's table
 * Returns the row number where the header is found, or throws error if not found
 */
async function findHeaderRow(username: string): Promise<number> {
  const searchRange = USERNAME_TO_SEARCH_RANGE[username];
  if (!searchRange) {
    throw new Error(`Unknown username: @${username}. Supported usernames: ${Object.keys(USERNAME_TO_SEARCH_RANGE).map(u => `@${u}`).join(', ')}`);
  }

  const sheetTitle = await getLeftmostSheetTitle();
  
  // Read columns B, C, D in the search range to find the header row
  const range = `${sheetTitle}!B${searchRange.start}:D${searchRange.end}`;
  
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range,
  });

  const values = res.data.values || [];
  
  // Look for a row that contains "Purpose", "Goal", and "Status" (case-insensitive)
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (!row || row.length < 3) continue;
    
    const colB = (row[0] || '').toString().trim().toLowerCase();
    const colC = (row[1] || '').toString().trim().toLowerCase();
    const colD = (row[2] || '').toString().trim().toLowerCase();
    
    // Check if this row contains the header keywords
    if (colB.includes('purpose') && colC.includes('goal') && colD.includes('status')) {
      const headerRow = searchRange.start + i;
      console.log(`[DEBUG] Found header row for @${username} at row ${headerRow}`);
      return headerRow;
    }
  }
  
  throw new Error(`Could not find header row (Purpose/Goal/Status) for @${username} in range ${searchRange.start}-${searchRange.end}`);
}

/**
 * Gets the end row for a table (where the next table starts, or a safe limit)
 * Uses the header row to determine table boundaries
 */
async function getTableEndRow(username: string, headerRow: number): Promise<number> {
  // Get approximate search ranges for other users to find their headers
  const otherUsers = Object.keys(USERNAME_TO_SEARCH_RANGE).filter(u => u !== username);
  let nextTableHeaderRow: number | null = null;
  
  // Try to find the next table's header row
  for (const otherUser of otherUsers) {
    try {
      const otherHeaderRow = await findHeaderRow(otherUser);
      if (otherHeaderRow > headerRow) {
        if (!nextTableHeaderRow || otherHeaderRow < nextTableHeaderRow) {
          nextTableHeaderRow = otherHeaderRow;
        }
      }
    } catch (e) {
      // Ignore errors when searching for other tables
    }
  }
  
  // If there's a next table, stop 2 rows before its header (to avoid the header row)
  // Otherwise, use a safe limit (200 rows after header)
  return nextTableHeaderRow ? nextTableHeaderRow - 2 : headerRow + 200;
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
 * Inserts a new row right below the header row (Purpose/Goal/Status), shifting all existing rows down
 * This makes the newest item appear at the top of the table
 */
async function addTodoToTable(username: string, text: string): Promise<void> {
  const sheetTitle = await getLeftmostSheetTitle();
  
  // Find the header row dynamically
  const headerRow = await findHeaderRow(username);
  
  // Insert right below the header row (headerRow + 1)
  const insertRow = headerRow + 1;
  
  console.log(`[DEBUG] Username: ${username}, HeaderRow: ${headerRow}, InsertRow: ${insertRow}`);

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
 * Gets todos with their actual row numbers (for marking as done)
 * Returns array of todos with row numbers
 */
async function getTodosWithRowNumbers(username: string): Promise<Array<{ purpose: string; goal: string; rowNumber: number }>> {
  const sheetTitle = await getLeftmostSheetTitle();
  
  // Find the header row dynamically
  const headerRow = await findHeaderRow(username);
  const endRow = await getTableEndRow(username, headerRow);
  
  // Data starts right after the header row
  const startRow = headerRow + 1;
  
  // Read columns B (Purpose), C (Goal), and D (Status)
  const range = `${sheetTitle}!B${startRow}:D${endRow}`;
  
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range,
  });

  const values = res.data.values || [];
  const todos: Array<{ purpose: string; goal: string; rowNumber: number }> = [];
  
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
    
    // Calculate actual row number (startRow is 1-based, i is 0-based)
    const rowNumber = startRow + i;
    todos.push({ purpose, goal, rowNumber });
  }
  
  return todos;
}

/**
 * Lists all todos for a user that are not done
 * Returns formatted string with numbered list
 */
async function listTodos(username: string): Promise<string> {
  const todos = await getTodosWithRowNumbers(username);
  
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
 * Marks a task as done by updating the Status column
 */
async function markTaskAsDone(username: string, rowNumber: number): Promise<void> {
  const sheetTitle = await getLeftmostSheetTitle();
  
  // Update column D (Status) to "done"
  const range = `${sheetTitle}!D${rowNumber}`;
  
  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range,
    valueInputOption: 'RAW',
    requestBody: {
      values: [['done']],
    },
  });
  
  console.log(`[DEBUG] Marked task at row ${rowNumber} as done for @${username}`);
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
        if (!USERNAME_TO_SEARCH_RANGE[telegramUsername]) {
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

// Register /done command handler
bot.command('done', async (ctx) => {
  try {
    const commandText = ctx.message.text || '';
    const argsText = commandText.replace(/^\/done\s*/i, '').trim();
    
    let username: string;
    
    // If no argument, try to detect user from Telegram username (self-reflective)
    if (!argsText) {
      const telegramUsername = ctx.from?.username;
      if (telegramUsername && USERNAME_TO_SEARCH_RANGE[telegramUsername]) {
        username = telegramUsername;
      } else {
        await ctx.reply('❌ Could not determine your username. Please use /done [@username] or /done [shortcut]\nExample: /done @hesong07\nOr: /done he\nOr: /done aaron');
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
        } else if (USERNAME_TO_SEARCH_RANGE[inputUsername]) {
          username = inputUsername;
        } else {
          await ctx.reply(`❌ Unknown username: @${inputUsername}\nSupported: @hesong07, @boewu28, or shortcuts: he, aaron`);
          return;
        }
      } else {
        await ctx.reply('Usage: /done [@username]\nExample: /done @hesong07\nOr: /done he\nOr: /done aaron\nOr: /done (for your own list)');
        return;
      }
    }
    
    const todos = await getTodosWithRowNumbers(username);
    
    if (todos.length === 0) {
      await ctx.reply(`📋 No pending tasks for @${username}`);
      return;
    }
    
    // Show all tasks
    let message = `📋 Tasks for @${username}:\n\n`;
    todos.forEach((todo, index) => {
      const number = index + 1;
      if (todo.goal) {
        message += `${number}. ${todo.purpose} (${todo.goal})\n`;
      } else {
        message += `${number}. ${todo.purpose}\n`;
      }
    });
    
    // Add inline keyboard with "Mark as done" button
    await ctx.reply(message, {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Mark as done', callback_data: `mark_done:${username}:show_list` }]
        ]
      }
    });
  } catch (error: any) {
    console.error('Error in /done command:', error);
    const errorMessage = error.message || 'Failed to list todos. Check logs for details.';
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
      if (telegramUsername && USERNAME_TO_SEARCH_RANGE[telegramUsername]) {
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
          } else if (USERNAME_TO_SEARCH_RANGE[inputUsername]) {
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

// Handle callback queries (button clicks)
bot.on('callback_query', async (ctx) => {
  try {
    if (!('data' in ctx.callbackQuery)) return;
    const data = ctx.callbackQuery.data;
    if (!data) return;
    
    // Handle "Mark as done" button - show list of tasks
    if (data.startsWith('mark_done:')) {
      const parts = data.split(':');
      if (parts.length === 3 && parts[2] === 'show_list') {
        const username = parts[1];
        const todos = await getTodosWithRowNumbers(username);
        
        if (todos.length === 0) {
          await ctx.answerCbQuery('No pending tasks to mark as done');
          await ctx.editMessageText('📋 No pending tasks to mark as done');
          return;
        }
        
        // Create inline keyboard with numbered buttons
        const buttons = todos.map((todo, index) => {
          const number = index + 1;
          const label = todo.goal 
            ? `${number}. ${todo.purpose.substring(0, 30)}...` 
            : `${number}. ${todo.purpose.substring(0, 30)}${todo.purpose.length > 30 ? '...' : ''}`;
          return [{ text: label, callback_data: `mark_done:${username}:${todo.rowNumber}` }];
        });
        
        let message = `Select a task to mark as done:\n\n`;
        todos.forEach((todo, index) => {
          const number = index + 1;
          if (todo.goal) {
            message += `${number}. ${todo.purpose} (${todo.goal})\n`;
          } else {
            message += `${number}. ${todo.purpose}\n`;
          }
        });
        
        await ctx.answerCbQuery();
        await ctx.editMessageText(message, {
          reply_markup: {
            inline_keyboard: buttons
          }
        });
        return;
      }
      
      // Handle selecting a specific task to mark as done
      if (parts.length === 3 && !isNaN(parseInt(parts[2]))) {
        const username = parts[1];
        const rowNumber = parseInt(parts[2]);
        
        await markTaskAsDone(username, rowNumber);
        
        await ctx.answerCbQuery('Task marked as done! ✅');
        await ctx.editMessageText('✅ Task marked as done!');
        return;
      }
    }
  } catch (error: any) {
    console.error('Error handling callback query:', error);
    await ctx.answerCbQuery('An error occurred');
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

