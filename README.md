# Paena Todo Bot

A minimal Telegram bot that tests Google Sheets integration.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the project root with the following variables:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_from_botfather
GOOGLE_SHEETS_ID=your_spreadsheet_id_from_url
GOOGLE_SERVICE_ACCOUNT={"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}
```

**Important notes:**
- `TELEGRAM_BOT_TOKEN`: Get this from [@BotFather](https://t.me/botfather) on Telegram
- `GOOGLE_SHEETS_ID`: Extract from your Google Sheet URL (the long ID between `/d/` and `/edit`)
- `GOOGLE_SERVICE_ACCOUNT`: The full JSON of your service account credentials as a **single line string**. Make sure to properly escape quotes if needed, or use a JSON minifier.

### 3. Start the Bot

```bash
npm run dev
```

You should see `Bot started` in the console when the bot is ready.

## Testing

1. Add your bot to a Telegram group or start a direct chat with it
2. Send the command `/hello` in the chat
3. The bot should:
   - Write the string `"hello"` to cell `A1` of the leftmost sheet tab
   - Reply with a confirmation message

If there's an error, check the console logs for details.

