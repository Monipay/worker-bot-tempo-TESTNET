/**
 * Tempo Worker - P2P Command Processor
 * 
 * Polls Twitter for "@monibot send/pay ... on tempo" commands.
 * Executes AlphaUSD transfers with fee sponsorship.
 */

import { getTwitterClient } from './twitter.js';
import { executeTransfer, getAlphaUsdBalance } from './blockchain.js';
import { createClient } from '@supabase/supabase-js';

let supabase = null;
let lastProcessedTweetId = null;

const MONIBOT_PROFILE_ID = process.env.MONIBOT_PROFILE_ID;

export function initP2P(supabaseClient) {
  supabase = supabaseClient;
  console.log('✅ P2P command processor initialized');
}

// ============ Tempo Keyword Detection ============

const TEMPO_KEYWORDS = ['on tempo', 'tempo', 'alphausd', 'αusd'];

function isTempoRelated(text) {
  const lower = text.toLowerCase();
  return TEMPO_KEYWORDS.some(kw => lower.includes(kw));
}

// ============ Parse P2P Command ============

/**
 * Parses commands like:
 * "@monibot send $5 to @alice on tempo"
 * "@monibot pay @bob $10 on tempo"
 * "@monibot send $1 each to @alice, @bob on tempo"
 */
function parseP2PCommand(text) {
  const lower = text.toLowerCase();
  
  // Extract amount - supports "$5", "$5.50", "5 alphausd"
  const amountMatch = lower.match(/\$(\d+(?:\.\d+)?)/);
  if (!amountMatch) return null;
  
  const amount = parseFloat(amountMatch[1]);
  if (isNaN(amount) || amount <= 0 || amount > 10000) return null;

  // Extract recipients (all @mentions except @monibot and @monipay)
  const mentions = text.match(/@([a-zA-Z0-9_-]+)/g) || [];
  const recipients = mentions
    .map(m => m.slice(1).toLowerCase())
    .filter(m => m !== 'monibot' && m !== 'monipay');

  if (recipients.length === 0) return null;

  // Check if it's "each" (multi-recipient)
  const isEach = lower.includes('each');

  return { amount, recipients, isEach };
}

// ============ Poll Twitter for P2P Commands ============

export async function pollP2PCommands() {
  const twitter = getTwitterClient();
  if (!twitter) {
    console.log('   ⚠️ Twitter not available, skipping P2P poll');
    return 0;
  }

  let processed = 0;

  try {
    console.log('💬 [Tempo] Polling for P2P commands...');

    const searchParams = {
      query: '@monibot (send OR pay) (tempo OR alphausd) -is:retweet',
      max_results: 50,
      'tweet.fields': ['author_id', 'created_at', 'referenced_tweets'],
      'user.fields': ['username'],
      expansions: ['author_id'],
    };

    if (lastProcessedTweetId) {
      searchParams.since_id = lastProcessedTweetId;
    }

    const mentions = await twitter.v2.search(searchParams);

    if (!mentions?.data?.data) {
      console.log('   No new Tempo P2P commands found.');
      return 0;
    }

    console.log(`🔎 Found ${mentions.data.data.length} potential Tempo commands.`);
    lastProcessedTweetId = mentions.data.meta?.newest_id || lastProcessedTweetId;

    for (const tweet of mentions.data.data) {
      const author = mentions.includes?.users?.find(u => u.id === tweet.author_id);
      if (!author) continue;

      // Must contain Tempo keyword
      if (!isTempoRelated(tweet.text)) continue;

      try {
        const result = await processP2PCommand(tweet, author);
        if (result) processed++;
      } catch (err) {
        console.error(`❌ Error processing tweet ${tweet.id}:`, err.message);
      }
    }
  } catch (error) {
    console.error('❌ Error polling P2P commands:', error.message);
  }

  return processed;
}

// ============ Process Single P2P Command ============

async function processP2PCommand(tweet, author) {
  // Check if already processed
  const { data: existing } = await supabase
    .from('monibot_transactions')
    .select('id')
    .eq('tweet_id', tweet.id)
    .limit(1);

  if (existing?.length) return false;

  // Smart Command Detection for quote tweets
  const isQuote = tweet.referenced_tweets?.some(r => r.type === 'quoted');
  if (isQuote) {
    const hasDirectCommand = /(?:send\s+\$?\d|pay\s+@?\w+\s+\$?\d)/i.test(tweet.text);
    if (!hasDirectCommand) {
      console.log(`   ⏭️ Quote tweet, not a command. Skipping.`);
      await logSkip(tweet.id, 'SKIP_QUOTE_NOT_COMMAND', author.username);
      return false;
    }
  }

  // Parse command
  const parsed = parseP2PCommand(tweet.text);
  if (!parsed) {
    console.log(`   ⏭️ Could not parse command from @${author.username}: "${tweet.text.substring(0, 60)}"`);
    await logSkip(tweet.id, 'SKIP_PARSE_FAILED', author.username);
    return false;
  }

  console.log(`\n⚡ [Tempo] P2P from @${author.username}: $${parsed.amount} to ${parsed.recipients.join(', ')}`);

  // Resolve sender profile
  const { data: senderProfile } = await supabase
    .from('profiles')
    .select('id, wallet_address, tempo_address, pay_tag')
    .eq('x_username', author.username)
    .single();

  if (!senderProfile) {
    console.log(`   ❌ Sender @${author.username} not found`);
    await logSkip(tweet.id, 'ERROR_SENDER_NOT_FOUND', author.username, parsed.recipients[0]);
    return false;
  }

  const senderAddress = senderProfile.tempo_address || senderProfile.wallet_address;

  // Check sender balance
  const balance = await getAlphaUsdBalance(senderAddress);
  const totalNeeded = parsed.amount * parsed.recipients.length;

  if (parseFloat(balance) < totalNeeded) {
    console.log(`   ❌ Insufficient balance: ${balance} αUSD < ${totalNeeded} needed`);
    await supabase.from('monibot_transactions').insert({
      tweet_id: tweet.id,
      chain: 'tempo',
      tx_hash: 'ERROR_INSUFFICIENT_BALANCE',
      sender_id: senderProfile.id,
      receiver_id: senderProfile.id,
      amount: totalNeeded,
      fee: 0,
      type: 'p2p_command',
      status: 'failed',
      payer_pay_tag: senderProfile.pay_tag,
      recipient_pay_tag: parsed.recipients.join(','),
      error_reason: `Balance ${balance} < ${totalNeeded} αUSD`,
      replied: false,
    });
    return false;
  }

  // Process each recipient
  let successCount = 0;
  for (const recipientTag of parsed.recipients) {
    const { data: recipientProfile } = await supabase
      .from('profiles')
      .select('id, wallet_address, tempo_address, pay_tag')
      .or(`pay_tag.eq.${recipientTag},x_username.eq.${recipientTag}`)
      .single();

    if (!recipientProfile) {
      console.log(`   ❌ Recipient @${recipientTag} not found`);
      await supabase.from('monibot_transactions').insert({
        tweet_id: tweet.id,
        chain: 'tempo',
        tx_hash: 'ERROR_RECIPIENT_NOT_FOUND',
        sender_id: senderProfile.id,
        receiver_id: senderProfile.id,
        amount: parsed.amount,
        fee: 0,
        type: 'p2p_command',
        status: 'failed',
        payer_pay_tag: senderProfile.pay_tag,
        recipient_pay_tag: recipientTag,
        error_reason: `No profile for @${recipientTag}`,
        replied: false,
      });
      continue;
    }

    const recipientAddress = recipientProfile.tempo_address || recipientProfile.wallet_address;

    try {
      const result = await executeTransfer(recipientAddress, parsed.amount, `P2P: @${author.username} → @${recipientTag}`);

      await supabase.from('monibot_transactions').insert({
        tweet_id: tweet.id,
        chain: 'tempo',
        tx_hash: result.txHash,
        sender_id: senderProfile.id,
        receiver_id: recipientProfile.id,
        amount: parseFloat(result.netAmount),
        fee: parseFloat(result.fee),
        type: 'p2p_command',
        status: 'completed',
        payer_pay_tag: senderProfile.pay_tag,
        recipient_pay_tag: recipientProfile.pay_tag,
        replied: false,
      });

      successCount++;
      console.log(`   ✅ Sent ${result.netAmount} αUSD to @${recipientTag}: ${result.txHash}`);
    } catch (txError) {
      console.error(`   ❌ Transfer to @${recipientTag} failed:`, txError.message);
      await supabase.from('monibot_transactions').insert({
        tweet_id: tweet.id,
        chain: 'tempo',
        tx_hash: 'failed_' + Date.now(),
        sender_id: senderProfile.id,
        receiver_id: recipientProfile.id,
        amount: parsed.amount,
        fee: 0,
        type: 'p2p_command',
        status: 'failed',
        payer_pay_tag: senderProfile.pay_tag,
        recipient_pay_tag: recipientProfile.pay_tag,
        error_reason: txError.message,
        replied: false,
      });
    }
  }

  console.log(`   📊 P2P result: ${successCount}/${parsed.recipients.length} successful`);
  return successCount > 0;
}

// ============ Helpers ============

async function logSkip(tweetId, txHash, senderTag, recipientTag = null) {
  await supabase.from('monibot_transactions').insert({
    tweet_id: tweetId,
    chain: 'tempo',
    tx_hash: txHash,
    sender_id: MONIBOT_PROFILE_ID || '00000000-0000-0000-0000-000000000000',
    receiver_id: MONIBOT_PROFILE_ID || '00000000-0000-0000-0000-000000000000',
    amount: 0,
    fee: 0,
    type: 'p2p_command',
    status: 'skipped',
    payer_pay_tag: senderTag,
    recipient_pay_tag: recipientTag,
    replied: false,
  });
}
