# Aliasist News Worker

Cloudflare Worker that aggregates live news from Google News RSS across 4 categories:
- AI & Tech
- Finance & Markets  
- Defense & Security
- AI Security

Auto-refreshes every 30 minutes via cron trigger. Caches in KV. Serves to aliasist.com.

## Deploy
```bash
npm install
npx wrangler kv:namespace create NEWS_CACHE
# Add KV ID to wrangler.toml
npx wrangler secret put GROQ_API_KEY
npx wrangler deploy
```
