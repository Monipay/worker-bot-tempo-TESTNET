# MoniBot Tempo Worker v1.0

Processes campaign grants and P2P commands on Tempo Testnet (Chain ID: 42431).

## Features
- Native fee sponsorship (no EIP-712 relayer needed)
- AlphaUSD (TIP-20, 18 decimals) transfers
- Campaign grant processing from Twitter replies
- Batch transfer support for multi-recipient campaigns

## Setup
```bash
cp .env.example .env
# Fill in your credentials
npm install
npm start
```

## Docker
```bash
docker build -t monibot-worker-tempo .
docker run -d --env-file .env monibot-worker-tempo
```

## Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| SUPABASE_URL | ✅ | Supabase project URL |
| SUPABASE_SERVICE_KEY | ✅ | Supabase service role key |
| TEMPO_EXECUTOR_PRIVATE_KEY | ✅ | Wallet that executes transfers |
| TEMPO_SPONSOR_PRIVATE_KEY | ❌ | Fee sponsor wallet (defaults to executor) |
| TWITTER_CLIENT_ID | ✅ | Twitter OAuth 2.0 client ID |
| TWITTER_CLIENT_SECRET | ✅ | Twitter OAuth 2.0 client secret |
