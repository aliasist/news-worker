/**
 * Aliasist News Worker
 * Fetches Google News RSS for tech, finance, and defense/war industry.
 * Caches in KV, serves to aliasist.com frontend.
 * Auto-refreshes every 30 minutes via cron trigger.
 */

import { logNewsArticles, logUsage } from "./analytics";

export interface Env {
  NEWS_CACHE: KVNamespace;
  GROQ_API_KEY: string;
  ANALYTICS: D1Database;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Google News RSS feeds — no API key needed
const FEEDS = [
  {
    category: "AI & Tech",
    tag: "tech",
    color: "#00C97B",
    url: "https://feeds.arstechnica.com/arstechnica/index",
    backup: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",
  },
  {
    category: "Finance & Markets",
    tag: "finance",
    color: "#5EF6FF",
    url: "https://feeds.content.dowjones.io/public/rss/mw_topstories",
    backup: "https://hnrss.org/frontpage",
  },
  {
    category: "Defense & Security",
    tag: "defense",
    color: "#FFB347",
    url: "https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml",
    backup: "https://krebsonsecurity.com/feed/",
  },
  {
    category: "AI Security",
    tag: "aisec",
    color: "#FF5555",
    url: "https://www.darkreading.com/rss.xml",
    backup: "https://feeds.feedburner.com/TheHackersNews",
  },
];

interface NewsItem {
  id: string;
  title: string;
  source: string;
  url: string;
  published: string;
  category: string;
  tag: string;
  color: string;
  summary?: string;
}

// Parse Google News RSS XML
function parseRSS(xml: string, feed: typeof FEEDS[0]): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && items.length < 5) {
    const item = match[1];
    const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
      ?? item.match(/<title>(.*?)<\/title>/)?.[1] ?? "";
    const rawLink = item.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/)?.[1]
      ?? item.match(/<guid[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/guid>/)?.[1] ?? "";
    // Strip any residual CDATA wrappers and whitespace from URL
    const link = rawLink.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/\s+/g, "").trim();
    const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? "";
    const source = item.match(/<source[^>]*>(.*?)<\/source>/)?.[1]
      ?? title.split(" - ").pop() ?? "Unknown";

    // Clean title — remove source suffix
    const cleanTitle = title.replace(/ - [^-]*$/, "").trim();

    if (cleanTitle && link) {
      items.push({
        id: Buffer.from(link).toString("base64").slice(0, 16),
        title: cleanTitle,
        source: source.replace(/<!\[CDATA\[|\]\]>/g, "").trim(),
        url: link,
        published: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        category: feed.category,
        tag: feed.tag,
        color: feed.color,
      });
    }
  }
  return items;
}

// Fetch a single RSS URL with fallback
async function fetchFeed(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/rss+xml, application/xml, text/xml, */*",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Fetch all feeds and return combined news
async function fetchAllNews(): Promise<NewsItem[]> {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      let xml = "";
      try {
        xml = await fetchFeed(feed.url);
      } catch {
        try {
          xml = await fetchFeed((feed as any).backup ?? feed.url);
        } catch {
          return [];
        }
      }
      const items = parseRSS(xml, feed);
      if (items.length === 0 && (feed as any).backup) {
        try {
          const backupXml = await fetchFeed((feed as any).backup);
          return parseRSS(backupXml, feed);
        } catch { return []; }
      }
      return items;
    })
  );

  const all: NewsItem[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
  }

  // Sort by published date, newest first
  return all.sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());
}

// Refresh cache
async function refreshCache(env: Env): Promise<NewsItem[]> {
  const news = await fetchAllNews();
  await env.NEWS_CACHE.put("latest", JSON.stringify(news), { expirationTtl: 3600 });
  await env.NEWS_CACHE.put("last_updated", new Date().toISOString(), { expirationTtl: 3600 });
  // Log all articles to D1 analytics (deduped by URL via ON CONFLICT)
  if (env.ANALYTICS) {
    await logNewsArticles(env.ANALYTICS, news).catch(() => {});
    await logUsage(env.ANALYTICS, "aliasist-news", "refresh", "complete", undefined, { count: news.length }).catch(() => {});
  }
  return news;
}

export default {
  // Handle HTTP requests
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // GET /api/news — return cached news
    if (url.pathname === "/api/news") {
      let news = await env.NEWS_CACHE.get("latest");
      const lastUpdated = await env.NEWS_CACHE.get("last_updated");

      // If no cache, fetch fresh
      if (!news) {
        const fresh = await refreshCache(env);
        news = JSON.stringify(fresh);
      }

      return new Response(
        JSON.stringify({
          articles: JSON.parse(news),
          lastUpdated: lastUpdated ?? new Date().toISOString(),
          sources: FEEDS.map(f => ({ tag: f.tag, category: f.category, color: f.color })),
        }),
        { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=900" } }
      );
    }

    // GET /api/news/refresh — force refresh (protected by secret)
    if (url.pathname === "/api/news/refresh") {
      await refreshCache(env);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ status: "ok", app: "aliasist-news" }), {
        headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    return new Response("Not found", { status: 404 });
  },

  // Cron trigger — auto-refresh every 30 minutes
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await refreshCache(env);
  },
};
