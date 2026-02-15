/**
 * Tempo Worker Twitter Module
 * Uses OAuth 2.0 for Twitter API access.
 */

import { TwitterApi } from 'twitter-api-v2';

let twitterClient = null;

export async function initTwitter() {
  const clientId = process.env.TWITTER_CLIENT_ID;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;

  if (!clientId || !clientSecret) {
    console.warn('⚠️ Twitter credentials not set - running without Twitter');
    return;
  }

  try {
    if (accessToken) {
      twitterClient = new TwitterApi(accessToken);
      console.log('✅ Twitter initialized (Bearer token)');
    } else {
      const client = new TwitterApi({ clientId, clientSecret });
      twitterClient = await client.appLogin();
      console.log('✅ Twitter initialized (App-only auth)');
    }
  } catch (error) {
    console.error('❌ Twitter init failed:', error.message);
  }
}

export function getTwitterClient() {
  return twitterClient;
}
