import { API_CACHE_SECONDS, CACHEABLE_GET_PATHS } from "../config/constants.js";

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-admin-password"
    }
  });
}

export function cacheKey(request) {
  const url = new URL(request.url);
  url.searchParams.sort();
  return new Request(url.toString(), { method: "GET" });
}

export async function cachedJson(request, data, seconds = API_CACHE_SECONDS) {
  const response = json(data);
  if (request.method === "GET" && CACHEABLE_GET_PATHS.has(new URL(request.url).pathname)) {
    response.headers.set("cache-control", `public, max-age=${seconds}, s-maxage=${seconds}`);
    await caches.default.put(cacheKey(request), response.clone()).catch(() => {});
  }
  return response;
}

export async function cachedFallback(request) {
  if (request.method !== "GET" || !CACHEABLE_GET_PATHS.has(new URL(request.url).pathname)) return null;
  const cached = await caches.default.match(cacheKey(request)).catch(() => null);
  if (!cached) return null;
  const response = new Response(cached.body, cached);
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("x-dashboard-cache-fallback", "true");
  return response;
}

export function isNeonQuotaError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("exceeded the data transfer quota") || message.includes("http status 402");
}

export function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvResponse(headers, rows, filename) {
  const body = [headers, ...rows].map(row => row.map(csvEscape).join(",")).join("\n");
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "access-control-allow-origin": "*"
    }
  });
}

export function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
