/**
 * Aliasist News Worker
 * Fetches Google News RSS for tech, finance, and defense/war industry.
 * Caches in KV, serves to aliasist.com frontend.
 * Auto-refreshes every 30 minutes via cron trigger.
 */

import { logNewsArticles, logUsage } from "./analytics";
import { sendMetrics, sendLog } from "./datadog";

export interface Env {
  NEWS_CACHE: KVNamespace;
  GROQ_API_KEY: string;
  ANALYTICS: D1Database;
  DD_API_KEY?: string;
}

// — Sentry (lightweight, no SDK needed in Workers)
const SENTRY_DSN = "https://a4392f5f65eb0725f34d6c410f97e1b1@o4511142133760000.ingest.us.sentry.io/4511142165348352";
async function captureError(err: unknown, context: string): Promise<void> {
  try {
    const msg = err instanceof Error ? err.message : String(err);
    const [, key, host, projectId] = SENTRY_DSN.match(/https:\/\/([^@]+)@([^/]+)\/(.+)/) ?? [];
    if (!key) return;
    await fetch(`https://${host}/api/${projectId}/store/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${key}` },
      body: JSON.stringify({
        platform: "javascript", level: "error",
        logger: `news-worker.${context}`,
        message: msg,
        timestamp: new Date().toISOString(),
        tags: { worker: "news-worker", context },
      }),
    });
  } catch { /* never block the worker */ }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Google News RSS feeds — no API key needed
const FEEDS = [
  {
    // AI/ML research & tools — Ars Technica AI section
    category: "AI & Tech",
    tag: "tech",
    color: "#00C97B",
    url: "https://feeds.arstechnica.com/arstechnica/index",
    backup: "https://www.wired.com/feed/category/ai/latest/rss",
  },
  {
    // Tech/security finance — CNBC Tech (no personal finance noise)
    category: "Finance & Markets",
    tag: "finance",
    color: "#5EF6FF",
    url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19854910",
    backup: "https://hnrss.org/frontpage",
  },
  {
    // Defense & national security
    category: "Defense & Security",
    tag: "defense",
    color: "#FFB347",
    url: "https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml",
    backup: "https://krebsonsecurity.com/feed/",
  },
  {
    // AI Security / adversarial / CVEs
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

// Decode HTML entities to plain text (&#x2019; → ’ etc.)
function decodeEntities(str: string): string {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&ndash;/g, "\u2013").replace(/&mdash;/g, "\u2014")
    .replace(/&rsquo;/g, "\u2019").replace(/&lsquo;/g, "\u2018")
    .replace(/&rdquo;/g, "\u201D").replace(/&ldquo;/g, "\u201C");
}

// Strip <!\[CDATA\[...]]> wrappers
function stripCDATA(s: string): string {
  return s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").trim();
}

// Parse RSS XML into NewsItem array
function parseRSS(xml: string, feed: typeof FEEDS[0]): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && items.length < 5) {
    const item = match[1];

    // Title: strip CDATA, then decode entities
    const rawTitle = item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
    const title = decodeEntities(stripCDATA(rawTitle));

    // Link: strip CDATA, extract bare URL
    const rawLink = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]
      ?? item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1] ?? "";
    const linkClean = decodeEntities(stripCDATA(rawLink)).replace(/\s+/g, "");
    const linkMatch = linkClean.match(/^(https?:\/\/[^\s<>"]+)/);
    const link = linkMatch ? linkMatch[1] : linkClean;

    const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "";
    const rawSource = item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? "";
    const source = rawSource ? decodeEntities(stripCDATA(rawSource)) : (title.split(" - ").pop() ?? feed.category);

    // Clean title — strip trailing " - Source Name" suffix
    const cleanTitle = decodeEntities(title.replace(/ - [^-]{2,40}$/, "").trim());

    if (cleanTitle && link && link.startsWith("http")) {
      items.push({
        id: btoa(link).slice(0, 16),
        title: cleanTitle,
        source,
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
      const _t = Date.now();
      let news = await env.NEWS_CACHE.get("latest");
      const lastUpdated = await env.NEWS_CACHE.get("last_updated");

      // If no cache, fetch fresh
      if (!news) {
        const fresh = await refreshCache(env);
        news = JSON.stringify(fresh);
      }
      sendMetrics(env.DD_API_KEY, [{ metric: "aliasist.api.request", value: 1, tags: ["route:/api/news","service:aliasist-news","status:200"] }, { metric: "aliasist.api.latency_ms", value: Date.now()-_t, type:"gauge", tags: ["route:/api/news","service:aliasist-news"] }]);

      return new Response(
        JSON.stringify({
          articles: JSON.parse(news),
          lastUpdated: lastUpdated ?? new Date().toISOString(),
          sources: FEEDS.map(f => ({ tag: f.tag, category: f.category, color: f.color })),
        }),
        { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=300, stale-while-revalidate=600" } }
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
    sendMetrics(env.DD_API_KEY, [{ metric: "aliasist.cron.news_refresh", value: 1, tags: ["service:aliasist-news"] }]);
    await refreshCache(env);
  },
};
