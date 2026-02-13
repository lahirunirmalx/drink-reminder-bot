import { Handler } from '@netlify/functions';
import { postToGoogleChat } from '../../lib/google-chat';
import { getRandomReminderMessage } from '../../lib/messages';

/**
 * Netlify Function to post water drinking reminders to Google Chat.
 * 
 * This function can be triggered by:
 * 1. External cron service (recommended for random 15-30 min intervals)
 * 2. Netlify Scheduled Functions (if available on your plan)
 * 3. Manual HTTP request
 * 
 * For random intervals, use an external cron service that calls this
 * endpoint at random times between 15-30 minutes.
 */
export const handler: Handler = async (event, context) => {
  // Allow POST and GET for flexibility
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  // Optional: Check secret key if provided
  const secretKey = process.env.SECRET_KEY;
  if (secretKey) {
    let providedKey = event.queryStringParameters?.key;
    
    if (!providedKey && event.body) {
      try {
        const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        providedKey = body?.key;
      } catch {
        // Body is not JSON, ignore
      }
    }
    
    if (providedKey !== secretKey) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }
  }

  try {
    const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;
    
    if (!webhookUrl) {
      console.error('GOOGLE_CHAT_WEBHOOK_URL is not set');
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Webhook URL not configured' }),
      };
    }

    const message = getRandomReminderMessage();
    await postToGoogleChat(webhookUrl, message);

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        message: 'Reminder posted successfully',
        postedMessage: message 
      }),
    };
  } catch (error) {
    console.error('Error posting reminder:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to post reminder',
        details: error instanceof Error ? error.message : 'Unknown error'
      }),
    };
  }
};
