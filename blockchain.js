/**
 * Tempo Blockchain Module
 * 
 * Uses the deployed MoniBotRouter contract for grants/P2P.
 * AlphaUSD (TIP-20) at 0x20c0000000000000000000000000000000000001
 */

import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, encodeFunctionData, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const TEMPO_CHAIN = {
  id: 42431,
  name: 'Tempo Testnet',
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.moderato.tempo.xyz'] } },
  blockExplorers: { default: { name: 'Tempo Explorer', url: 'https://explore.tempo.xyz' } },
};

const ALPHA_USD = '0x20c0000000000000000000000000000000000001';
const DECIMALS = 6;
const TREASURY = '0xDC9B47551734bE984D7Aa2a365251E002f8FF2D7';
const FEE_BPS = 130; // 1.3%

// Deployed contracts
const MONIBOT_ROUTER = '0x78A824fDE7Ee3E69B2e2Ee52d1136EECD76749fc';
const MONIPAY_ROUTER = '0xa39C3B7e02686cf7F226337525515c694318BDb9';

// MoniBotRouter ABI (only functions we need)
const MONIBOT_ROUTER_ABI = [
  {
    name: 'executeGrant',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'campaignId', type: 'string' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'executeP2P',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'tweetId', type: 'string' },
    ],
    outputs: [{ type: 'bool' }],
  },
];

let executorAccount = null;
let sponsorAccount = null;
let publicClient = null;
let walletClient = null;

export async function initBlockchain() {
  const executorKey = process.env.TEMPO_EXECUTOR_PRIVATE_KEY;
  const sponsorKey = process.env.TEMPO_SPONSOR_PRIVATE_KEY || executorKey;

  if (!executorKey) {
    console.error('❌ TEMPO_EXECUTOR_PRIVATE_KEY not set');
    process.exit(1);
  }

  executorAccount = privateKeyToAccount(executorKey);
  sponsorAccount = privateKeyToAccount(sponsorKey);

  publicClient = createPublicClient({
    chain: TEMPO_CHAIN,
    transport: http('https://rpc.moderato.tempo.xyz'),
  });

  walletClient = createWalletClient({
    account: executorAccount,
    chain: TEMPO_CHAIN,
    transport: http('https://rpc.moderato.tempo.xyz'),
  });

  console.log(`⛓️  Executor: ${executorAccount.address}`);
  console.log(`💰 Sponsor:  ${sponsorAccount.address}`);
  console.log(`📄 MoniBotRouter: ${MONIBOT_ROUTER}`);
  console.log(`📄 MoniPayRouter: ${MONIPAY_ROUTER}`);

  // Check router's AlphaUSD balance (for grants)
  try {
    const routerBalance = await publicClient.readContract({
      address: ALPHA_USD,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [MONIBOT_ROUTER],
    });
    console.log(`💵 MoniBotRouter αUSD: ${formatUnits(routerBalance, DECIMALS)}`);
  } catch (e) {
    console.warn('⚠️ Could not read router balance:', e.message);
  }

  // Check sponsor balance
  try {
    const balance = await publicClient.readContract({
      address: ALPHA_USD,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [sponsorAccount.address],
    });
    console.log(`💵 Sponsor αUSD: ${formatUnits(balance, DECIMALS)}`);
  } catch (e) {
    console.warn('⚠️ Could not read sponsor balance:', e.message);
  }
}

/**
 * Execute a grant via MoniBotRouter contract
 * The contract handles fee splitting to treasury automatically.
 */
export async function executeGrant(recipientAddress, amount, campaignId = '') {
  const amountWei = parseUnits(amount.toString(), DECIMALS);

  console.log(`📤 Executing grant of ${amount} αUSD to ${recipientAddress} via MoniBotRouter`);

  const hash = await walletClient.writeContract({
    address: MONIBOT_ROUTER,
    abi: MONIBOT_ROUTER_ABI,
    functionName: 'executeGrant',
    args: [recipientAddress, amountWei, campaignId],
  });

  // Wait for receipt
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });

  const fee = (amountWei * BigInt(FEE_BPS)) / 10000n;
  const netAmount = amountWei - fee;

  console.log(`✅ Grant complete: ${hash} (block ${receipt.blockNumber})`);
  return {
    txHash: hash,
    amount: formatUnits(amountWei, DECIMALS),
    fee: formatUnits(fee, DECIMALS),
    netAmount: formatUnits(netAmount, DECIMALS),
    blockNumber: receipt.blockNumber.toString(),
  };
}

/**
 * Execute a direct AlphaUSD transfer (fallback, used for P2P without contract)
 */
export async function executeTransfer(recipientAddress, amount, memo = '') {
  const amountWei = parseUnits(amount.toString(), DECIMALS);
  const fee = (amountWei * BigInt(FEE_BPS)) / 10000n;
  const netAmount = amountWei - fee;

  console.log(`📤 Sending ${formatUnits(netAmount, DECIMALS)} αUSD to ${recipientAddress}`);
  console.log(`   Fee: ${formatUnits(fee, DECIMALS)} αUSD → Treasury`);

  // Transfer net amount to recipient
  const hash1 = await walletClient.writeContract({
    address: ALPHA_USD,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [recipientAddress, netAmount],
  });

  // Transfer fee to treasury
  if (fee > 0n) {
    await walletClient.writeContract({
      address: ALPHA_USD,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [TREASURY, fee],
    });
  }

  console.log(`✅ Transfer complete: ${hash1}`);
  return {
    txHash: hash1,
    amount: formatUnits(amountWei, DECIMALS),
    fee: formatUnits(fee, DECIMALS),
    netAmount: formatUnits(netAmount, DECIMALS),
  };
}

/**
 * Execute batch grants via MoniBotRouter (multiple recipients)
 */
export async function executeBatchGrants(recipients, campaignId = '') {
  const results = [];
  for (const r of recipients) {
    try {
      const result = await executeGrant(r.address, r.amount, campaignId);
      results.push({ ...result, recipient: r.address, success: true });
    } catch (error) {
      console.error(`❌ Failed grant to ${r.address}:`, error.message);
      results.push({ recipient: r.address, success: false, error: error.message });
    }
  }
  return results;
}

export async function getAlphaUsdBalance(address) {
  try {
    const balance = await publicClient.readContract({
      address: ALPHA_USD,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address],
    });
    return formatUnits(balance, DECIMALS);
  } catch {
    return '0';
  }
}

export { ALPHA_USD, DECIMALS, TREASURY, MONIBOT_ROUTER, MONIPAY_ROUTER, publicClient, executorAccount };
