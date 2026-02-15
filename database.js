/**
 * Tempo Worker Database Module
 * 
 * Polls campaigns and P2P commands for Tempo network.
 */

import { createClient } from '@supabase/supabase-js';
import { executeGrant, executeTransfer } from './blockchain.js';
import { getTwitterClient } from './twitter.js';

let supabase = null;

export function initSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    console.error('❌ SUPABASE_URL or SUPABASE_SERVICE_KEY not set');
    process.exit(1);
  }

  supabase = createClient(url, key);
  console.log('✅ Supabase initialized');
}

/**
 * Process active Tempo campaigns
 */
export async function processCampaignQueue() {
  let processed = 0;

  try {
    console.log('📢 [Tempo] Checking active campaigns...');
    // Get active Tempo campaigns
    const { data: campaigns, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('network', 'tempo')
      .eq('status', 'active')
      .not('tweet_id', 'is', null);

    if (error) throw error;
    if (!campaigns?.length) {
      console.log('   No active Tempo campaigns.');
      return 0;
    }
    console.log(`   Found ${campaigns.length} active Tempo campaign(s).`);

    for (const campaign of campaigns) {
      try {
        // Get replies to campaign tweet
        const twitter = getTwitterClient();
        if (!twitter) continue;

        const replies = await twitter.v2.search(
          `conversation_id:${campaign.tweet_id} is:reply`,
          {
            expansions: ['author_id'],
            'user.fields': ['username'],
            max_results: 100,
          }
        );

        if (!replies?.data?.data?.length) continue;

        const users = replies?.data?.includes?.users || [];

        for (const reply of replies.data.data) {
          // Check if already processed
          const { data: existing } = await supabase
            .from('monibot_transactions')
            .select('id')
            .eq('tweet_id', reply.id)
            .limit(1);

          if (existing?.length) continue;

          // Check campaign limits
          if (campaign.max_participants && campaign.current_participants >= campaign.max_participants) {
            console.log(`⚠️ Campaign ${campaign.id} at capacity`);
            break;
          }

          // Resolve user's wallet
          const author = users.find(u => u.id === reply.author_id);
          if (!author) continue;

          const { data: profile } = await supabase
            .from('profiles')
            .select('id, wallet_address, tempo_address, pay_tag')
            .eq('x_username', author.username)
            .single();

          if (!profile) {
            // Log skip
            await supabase.from('monibot_transactions').insert({
              tweet_id: reply.id,
              chain: 'tempo',
              tx_hash: 'skip_no_profile',
              sender_id: campaign.id,
              receiver_id: campaign.id,
              amount: campaign.grant_amount,
              fee: 0,
              type: 'grant',
              status: 'skipped',
              error_reason: `No profile for @${author.username}`,
            });
            continue;
          }

          const recipientAddress = profile.tempo_address || profile.wallet_address;

          try {
            const result = await executeGrant(recipientAddress, campaign.grant_amount, campaign.id);

            await supabase.from('monibot_transactions').insert({
              tweet_id: reply.id,
              chain: 'tempo',
              tx_hash: result.txHash,
              sender_id: campaign.id,
              receiver_id: profile.id,
              recipient_pay_tag: profile.pay_tag,
              amount: campaign.grant_amount,
              fee: parseFloat(result.fee),
              type: 'grant',
              status: 'completed',
              campaign_id: campaign.id,
              replied: false,
            });

            // Update campaign
            await supabase
              .from('campaigns')
              .update({
                current_participants: (campaign.current_participants || 0) + 1,
                budget_spent: (campaign.budget_spent || 0) + campaign.grant_amount,
              })
              .eq('id', campaign.id);

            processed++;
            console.log(`✅ Grant to @${author.username} (${profile.pay_tag}): ${result.txHash}`);
          } catch (txError) {
            console.error(`❌ Grant failed for @${author.username}:`, txError.message);
            await supabase.from('monibot_transactions').insert({
              tweet_id: reply.id,
              chain: 'tempo',
              tx_hash: 'failed_' + Date.now(),
              sender_id: campaign.id,
              receiver_id: profile.id,
              amount: campaign.grant_amount,
              fee: 0,
              type: 'grant',
              status: 'failed',
              error_reason: txError.message,
            });
          }
        }
      } catch (campaignError) {
        console.error(`❌ Campaign ${campaign.id} error:`, campaignError.message);
      }
    }
  } catch (err) {
    console.error('❌ Campaign queue error:', err.message);
  }

  return processed;
}

export function getSupabase() {
  return supabase;
}

export { supabase };
