# Deployment Guide for Vercel

## Prerequisites
1. A Vercel account (sign up at [vercel.com](https://vercel.com))
2. Your GitHub repository connected to Vercel

## Steps to Deploy

### 1. Connect Repository to Vercel
1. Go to [vercel.com](https://vercel.com) and sign in
2. Click "Add New..." → "Project"
3. Import your GitHub repository (`Aaron-Chen/todobot`)
4. Vercel will auto-detect the settings

### 2. Configure Environment Variables
In Vercel project settings, add these environment variables:
- `TELEGRAM_BOT_TOKEN` - Your Telegram bot token from BotFather
- `GOOGLE_SHEETS_ID` - Your Google Sheets ID
- `GOOGLE_SERVICE_ACCOUNT` - Your service account JSON (as a single-line string)

### 3. Set Up Telegram Webhook
After deployment, you'll get a URL like: `https://your-project.vercel.app/api/webhook`

Set the webhook using:
```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://your-project.vercel.app/api/webhook"
```

Or use this URL in your browser:
```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://your-project.vercel.app/api/webhook
```

### 4. Verify Webhook
Check if webhook is set correctly:
```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo
```

## Important Notes

- **Webhook vs Polling**: Vercel uses webhooks (serverless), not polling. The bot will only run when Telegram sends updates.
- **Cold Starts**: There may be a slight delay on the first request after inactivity (cold start).
- **Local Development**: For local testing, continue using `npm run dev` which uses polling.

## Troubleshooting

- If the bot doesn't respond, check Vercel function logs
- Make sure all environment variables are set correctly
- Verify the webhook URL is correct and accessible

