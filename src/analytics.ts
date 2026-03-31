/**
 * Aliasist Analytics Logger
 * Fire-and-forget D1 logging for all workers.
 * Uses ctx.waitUntil() so logging never delays responses.
 * DB binding: ANALYTICS (aliasist-analytics D1)
 */

export interface AnalyticsDB {
  prepare(sql: string): D1PreparedStatement;
  batch(stmts: D1PreparedStatement[]): Promise<D1Result[]>;
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Date.now();
}

// ── Chat logging ────────────────────────────────────────────────

export async function logChat(
  db: AnalyticsDB,
  app: string,
  userMessage: string,
  aiResponse: string,
  model?: string
): Promise<void> {
  try {
    const sessionId = uuid();
    const msgId1 = uuid();
    const msgId2 = uuid();
    const ts = now();

    await db.batch([
      db.prepare(
        "INSERT INTO chat_sessions (id, app, started_at, model) VALUES (?, ?, ?, ?)"
      ).bind(sessionId, app, ts, model ?? null),

      db.prepare(
        "INSERT INTO chat_messages (id, session_id, app, role, content, timestamp) VALUES (?, ?, ?, 'user', ?, ?)"
      ).bind(msgId1, sessionId, app, userMessage, ts),

      db.prepare(
        "INSERT INTO chat_messages (id, session_id, app, role, content, model, timestamp) VALUES (?, ?, ?, 'assistant', ?, ?, ?)"
      ).bind(msgId2, sessionId, app, aiResponse, model ?? null, ts + 1),
    ]);
  } catch {
    // silent — never break the response
  }
}

// ── News article logging ─────────────────────────────────────────

export interface NewsArticle {
  id: string;
  title: string;
  source: string;
  url: string;
  published?: string;
  category?: string;
  tag?: string;
  color?: string;
}

export async function logNewsArticles(
  db: AnalyticsDB,
  articles: NewsArticle[]
): Promise<void> {
  try {
    const ts = now();
    const stmts = articles.map((a) =>
      db.prepare(
        `INSERT INTO news_articles (id, title, source, url, published, category, tag, color, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, title = excluded.title
         ON CONFLICT(url) DO UPDATE SET last_seen = excluded.last_seen, title = excluded.title`
      ).bind(
        a.id,
        a.title,
        a.source,
        a.url,
        a.published ? new Date(a.published).getTime() : ts,
        a.category ?? null,
        a.tag ?? null,
        a.color ?? null,
        ts,
        ts
      )
    );
    // D1 batch max 100 — chunk if needed
    for (let i = 0; i < stmts.length; i += 100) {
      await db.batch(stmts.slice(i, i + 100));
    }
  } catch {
    // silent
  }
}

// ── Image request logging ────────────────────────────────────────

export async function logImageRequest(
  db: AnalyticsDB,
  type: string,
  prompt: string,
  model?: string,
  status: "success" | "failed" = "success",
  durationMs?: number
): Promise<void> {
  try {
    await db.prepare(
      "INSERT INTO image_requests (id, type, prompt, model, status, duration_ms, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(uuid(), type, prompt, model ?? null, status, durationMs ?? null, now()).run();
  } catch {
    // silent
  }
}

// ── Usage event logging ──────────────────────────────────────────

export async function logUsage(
  db: AnalyticsDB,
  worker: string,
  feature: string,
  action?: string,
  refId?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await db.prepare(
      "INSERT INTO usage_events (id, worker, feature, action, ref_id, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      uuid(),
      worker,
      feature,
      action ?? null,
      refId ?? null,
      metadata ? JSON.stringify(metadata) : null,
      now()
    ).run();
  } catch {
    // silent
  }
}

// ── TikaSist scan logging ────────────────────────────────────────

export async function logTikaScan(
  db: AnalyticsDB,
  scanId: string,
  keywordId: string,
  keywordText: string,
  status: "running" | "completed" | "failed",
  videosFound?: number,
  startedAt?: number,
  completedAt?: number,
  errorMessage?: string
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO tika_scans (id, keyword_id, keyword_text, status, videos_found, started_at, completed_at, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, videos_found=excluded.videos_found,
       completed_at=excluded.completed_at, error_message=excluded.error_message`
    ).bind(
      scanId,
      keywordId,
      keywordText,
      status,
      videosFound ?? 0,
      startedAt ?? now(),
      completedAt ?? null,
      errorMessage ?? null
    ).run();
  } catch {
    // silent
  }
}
