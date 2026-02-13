# Water Drinking Reminder Bot for Google Chat

A simple, reliable chatbot that posts random water drinking reminders to Google Chat spaces at random intervals (15-30 minutes).

## Architecture

This bot uses:
- **Netlify Functions** for serverless execution
- **Google Chat Incoming Webhooks** for posting messages
- **External cron service** for scheduling (recommended) or Netlify Scheduled Functions

No databases, no state management, no complexity. Just a function that posts messages when called.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the root directory:

```bash
# Google Chat Webhook URL
GOOGLE_CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/SPACE_ID/messages?key=KEY&token=TOKEN

# Optional: Secret key for securing the endpoint
SECRET_KEY=your-secret-key-here
```

**Getting your Google Chat Webhook URL:**
1. Open your Google Chat space
2. Click on the space name → **Apps and integrations**
3. Click **Manage webhooks**
4. Create a new webhook or use an existing one
5. Copy the webhook URL to your `.env` file

### 3. Deploy to Netlify

1. Push your code to GitHub/GitLab
2. Connect your repository to Netlify
3. In Netlify dashboard, go to **Site settings** → **Environment variables**
4. Add your environment variables:
   - `GOOGLE_CHAT_WEBHOOK_URL`
   - `SECRET_KEY` (optional but recommended)

5. Deploy the site

### 4. Set Up Scheduling

For random intervals (15-30 minutes), use an external cron service:

#### Option A: Using cron-job.org (Free)

1. Sign up at [cron-job.org](https://cron-job.org)
2. Create a new cron job:
   - **URL**: `https://your-site.netlify.app/.netlify/functions/post-reminder?key=your-secret-key`
   - **Schedule**: Set multiple cron jobs with different intervals (15, 18, 20, 22, 25, 28, 30 minutes)
   - **Method**: GET or POST

#### Option B: Using EasyCron

1. Sign up at [EasyCron](https://www.easycron.com)
2. Create cron jobs with random intervals between 15-30 minutes

#### Option C: Using Netlify Scheduled Functions (Pro/Business Plan)

If you have Netlify Pro/Business, you can use scheduled functions. Add to `netlify.toml`:

```toml
[[plugins]]
  package = "@netlify/plugin-scheduled-functions"

[functions]
  node_bundler = "esbuild"
```

Then create a scheduled function that calls the reminder function.

## Testing Locally

1. Install Netlify CLI:
```bash
npm install -g netlify-cli
```

2. Start local development:
```bash
netlify dev
```

3. Test the function:
```bash
curl -X POST http://localhost:8888/.netlify/functions/post-reminder
```

## Function Endpoint

Once deployed, your function will be available at:
```
https://your-site.netlify.app/.netlify/functions/post-reminder
```

With optional secret key:
```
https://your-site.netlify.app/.netlify/functions/post-reminder?key=your-secret-key
```

## How It Works

1. External cron service calls the Netlify function at random intervals (15-30 mins)
2. Function selects a random reminder message from the pool
3. Function posts the message to Google Chat via webhook
4. Google Chat displays the reminder in the space

## Customization

### Adding More Reminder Messages

Edit `lib/messages.ts` and add more messages to the `REMINDER_MESSAGES` array.

### Changing Interval Range

Adjust your cron job schedules to match your desired interval range.

## Troubleshooting

- **Function returns 500**: Check that `GOOGLE_CHAT_WEBHOOK_URL` is set correctly
- **Messages not appearing**: Verify the webhook URL is valid and the webhook is enabled in Google Chat
- **Unauthorized errors**: Make sure the `SECRET_KEY` matches if you're using it

## License

MIT
