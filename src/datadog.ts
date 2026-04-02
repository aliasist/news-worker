/**
 * Datadog metrics helper for Aliasist Pulse Worker
 * Uses the Datadog HTTP API (metrics v2) — no native SDK needed in CF Workers
 * Site: us5.datadoghq.com
 */

const DD_SITE = "us5.datadoghq.com"
const DD_METRICS_URL = `https://api.${DD_SITE}/api/v2/series`
const DD_LOGS_URL = `https://http-intake.logs.${DD_SITE}/api/v2/logs`

export type DDMetric = {
  metric: string       // e.g. "aliasist.api.request"
  value: number
  tags?: string[]      // e.g. ["route:/api/quotes", "env:production"]
  type?: "count" | "gauge" | "rate"
}

/**
 * Send one or more metrics to Datadog (fire-and-forget, non-blocking)
 */
export function sendMetrics(apiKey: string, metrics: DDMetric[]): void {
  const now = Math.floor(Date.now() / 1000)

  const series = metrics.map((m) => ({
    metric: m.metric,
    type: m.type === "gauge" ? 3 : m.type === "rate" ? 2 : 1, // 1=count, 2=rate, 3=gauge
    points: [{ timestamp: now, value: m.value }],
    tags: ["service:aliasist-pulse", "env:production", ...(m.tags ?? [])],
  }))

  fetch(DD_METRICS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "DD-API-KEY": apiKey,
    },
    body: JSON.stringify({ series }),
  }).catch(() => {
    // Silently swallow — never let DD errors affect the main response
  })
}

/**
 * Send a structured log event to Datadog
 */
export function sendLog(
  apiKey: string,
  level: "info" | "warn" | "error",
  message: string,
  attributes?: Record<string, unknown>
): void {
  fetch(DD_LOGS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "DD-API-KEY": apiKey,
    },
    body: JSON.stringify([
      {
        ddsource: "cloudflare-worker",
        ddtags: "service:aliasist-pulse,env:production",
        hostname: "aliasist-pulse.workers.dev",
        service: "aliasist-pulse",
        status: level,
        message,
        ...attributes,
      },
    ]),
  }).catch(() => {})
}

/**
 * Wraps a Worker fetch handler, automatically tracking:
 *  - Request count per route
 *  - Response status codes
 *  - Latency (ms)
 *  - Errors
 */
export async function withDatadog(
  apiKey: string | undefined,
  pathname: string,
  method: string,
  handler: () => Promise<Response>
): Promise<Response> {
  if (!apiKey) return handler()

  const start = Date.now()
  // Normalize route tag: /api/fmp/pitch/NVDA → /api/fmp/pitch/:ticker
  const routeTag = `route:${normalizeRoute(pathname)}`
  const methodTag = `method:${method}`

  try {
    const response = await handler()
    const latency = Date.now() - start
    const statusTag = `status:${response.status}`

    sendMetrics(apiKey, [
      { metric: "aliasist.api.request", value: 1, tags: [routeTag, methodTag, statusTag] },
      { metric: "aliasist.api.latency_ms", value: latency, type: "gauge", tags: [routeTag, methodTag] },
    ])

    if (response.status >= 400) {
      sendLog(apiKey, response.status >= 500 ? "error" : "warn", `HTTP ${response.status} on ${method} ${pathname}`, {
        route: pathname,
        method,
        status: response.status,
        latency_ms: latency,
      })
    }

    return response
  } catch (err) {
    const latency = Date.now() - start
    sendMetrics(apiKey, [
      { metric: "aliasist.api.error", value: 1, tags: [routeTag, methodTag, "error:unhandled"] },
      { metric: "aliasist.api.latency_ms", value: latency, type: "gauge", tags: [routeTag, methodTag] },
    ])
    sendLog(apiKey, "error", `Unhandled error on ${method} ${pathname}`, {
      route: pathname,
      method,
      error: String(err),
      latency_ms: latency,
    })
    throw err
  }
}

/**
 * Track AI provider usage — call after each AI response
 */
export function trackAIUsage(
  apiKey: string | undefined,
  provider: "groq" | "gemini" | "cloudflare-workers-ai" | "fmp",
  operation: string,
  success: boolean,
  latencyMs?: number
): void {
  if (!apiKey) return
  const tags = [`provider:${provider}`, `operation:${operation}`, `success:${success}`]
  const metrics: DDMetric[] = [
    { metric: "aliasist.ai.call", value: 1, tags },
  ]
  if (latencyMs !== undefined) {
    metrics.push({ metric: "aliasist.ai.latency_ms", value: latencyMs, type: "gauge", tags })
  }
  sendMetrics(apiKey, metrics)
}

/**
 * Track D1 database operations
 */
export function trackD1(
  apiKey: string | undefined,
  operation: string,
  success: boolean,
  latencyMs?: number
): void {
  if (!apiKey) return
  const tags = [`operation:${operation}`, `success:${success}`]
  sendMetrics(apiKey, [
    { metric: "aliasist.d1.query", value: 1, tags },
    ...(latencyMs !== undefined
      ? [{ metric: "aliasist.d1.latency_ms", value: latencyMs, type: "gauge" as const, tags }]
      : []),
  ])
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function normalizeRoute(pathname: string): string {
  return pathname
    .replace(/\/api\/chart\/[^/]+/, "/api/chart/:ticker")
    .replace(/\/api\/predict\/[^/]+/, "/api/predict/:ticker")
    .replace(/\/api\/eli5\/[^/]+/, "/api/eli5/:term")
    .replace(/\/api\/vectors\/[^/]+/, "/api/vectors/:ticker")
    .replace(/\/api\/watchlist\/[^/]+/, "/api/watchlist/:ticker")
    .replace(/\/api\/fmp\/pitch\/[^/]+/, "/api/fmp/pitch/:ticker")
    .replace(/\/api\/fmp\/profile\/[^/]+/, "/api/fmp/profile/:ticker")
    .replace(/\/api\/fmp\/metrics\/[^/]+/, "/api/fmp/metrics/:ticker")
    .replace(/\/api\/fmp\/ratings\/[^/]+/, "/api/fmp/ratings/:ticker")
    .replace(/\/api\/fmp\/peers\/[^/]+/, "/api/fmp/peers/:ticker")
    .replace(/\/api\/fmp\/earnings\/[^/]+/, "/api/fmp/earnings/:ticker")
    .replace(/\/api\/fmp\/income\/[^/]+/, "/api/fmp/income/:ticker")
    .replace(/\/api\/fmp\/balance\/[^/]+/, "/api/fmp/balance/:ticker")
    .replace(/\/api\/auth\/[^/]+/, "/api/auth/:action")
    .replace(/\/api\/pitches\/[^/]+/, "/api/pitches/:action")
}
