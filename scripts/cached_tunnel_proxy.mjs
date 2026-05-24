#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const listenHost = process.env.CODEX_WEB_PROXY_HOST ?? "127.0.0.1";
const listenPort = Number(process.env.CODEX_WEB_PROXY_PORT ?? "6006");
const upstream = new URL(
  process.env.CODEX_WEB_UPSTREAM ?? "http://127.0.0.1:16006",
);
const cacheDir = path.resolve(
  process.env.CODEX_WEB_CACHE_DIR ?? ".cache/codex-web-assets",
);
const cacheVersion = process.env.CODEX_WEB_CACHE_VERSION ?? "v2";
let transformJavaScriptSync = null;

function hopByHopHeaders() {
  return new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
}

function cacheKeyForUrl(rawUrl) {
  const url = new URL(rawUrl, "http://codex-web.local");
  return createHash("sha256")
    .update(`${cacheVersion}:${url.pathname}${url.search}`)
    .digest("hex");
}

function isCacheableAssetRequest(request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }
  if (request.headers.range) {
    return false;
  }
  const url = new URL(request.url ?? "/", "http://codex-web.local");
  const acceptEncoding = String(request.headers["accept-encoding"] ?? "");
  return url.pathname.startsWith("/assets/") && /\bgzip\b/i.test(acceptEncoding);
}

function upstreamRequestOptions(request, forceGzip) {
  const headers = { ...request.headers, host: upstream.host };
  if (forceGzip) {
    headers["accept-encoding"] = "gzip";
  }
  return {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
    method: request.method,
    path: request.url,
    headers,
  };
}

function responseHeaders(headers, cacheStatus) {
  const blocked = hopByHopHeaders();
  const next = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!blocked.has(name.toLowerCase()) && value !== undefined) {
      next[name] = value;
    }
  }
  next["x-codex-web-cache"] = cacheStatus;
  if (cacheStatus === "HIT") {
    next["cache-control"] = "public, max-age=31536000, immutable";
  }
  return next;
}

function headerValue(headers, name) {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function setHeader(headers, name, value) {
  delete headers[name];
  delete headers[name.toLowerCase()];
  headers[name.toLowerCase()] = value;
}

function deleteHeader(headers, name) {
  delete headers[name];
  delete headers[name.toLowerCase()];
}

function shouldMinifyJavaScript(rawUrl) {
  if (process.env.CODEX_WEB_PROXY_MINIFY_JS === "0") {
    return false;
  }
  const url = new URL(rawUrl ?? "/", "http://codex-web.local");
  return url.pathname.startsWith("/assets/") && url.pathname.endsWith(".js");
}

function maybeMinifyJavaScript(rawUrl, headers, body) {
  if (!shouldMinifyJavaScript(rawUrl)) {
    return { headers, body };
  }

  const contentEncoding = String(headerValue(headers, "content-encoding") ?? "");
  if (contentEncoding && contentEncoding.toLowerCase() !== "gzip") {
    return { headers, body };
  }

  try {
    transformJavaScriptSync ??= require("esbuild").transformSync;
    const source = contentEncoding ? gunzipSync(body).toString("utf8") : body.toString("utf8");
    const result = transformJavaScriptSync(source, {
      format: "esm",
      legalComments: "none",
      minify: true,
      target: "es2022",
    });
    const nextBody = gzipSync(Buffer.from(result.code), { level: 9 });
    const nextHeaders = { ...headers };
    setHeader(nextHeaders, "content-encoding", "gzip");
    setHeader(nextHeaders, "content-length", String(nextBody.length));
    setHeader(nextHeaders, "x-codex-web-minified", "1");
    deleteHeader(nextHeaders, "etag");
    deleteHeader(nextHeaders, "last-modified");
    return { headers: nextHeaders, body: nextBody };
  } catch (error) {
    console.error(`[minify] ${rawUrl} failed: ${error.message}`);
    return { headers, body };
  }
}

async function cachedAssetPaths(key) {
  await mkdir(cacheDir, { recursive: true });
  return {
    bodyPath: path.join(cacheDir, `${key}.body`),
    metaPath: path.join(cacheDir, `${key}.json`),
  };
}

async function trySendCachedAsset(response, key, method) {
  const { bodyPath, metaPath } = await cachedAssetPaths(key);
  try {
    const [metadata] = await Promise.all([
      readFile(metaPath, "utf8").then(JSON.parse),
      stat(bodyPath),
    ]);
    response.writeHead(
      metadata.statusCode,
      responseHeaders(metadata.headers, "HIT"),
    );
    if (method === "HEAD") {
      response.end();
      return true;
    }
    createReadStream(bodyPath).pipe(response);
    return true;
  } catch {
    return false;
  }
}

async function storeCachedAsset(key, statusCode, headers, body) {
  const { bodyPath, metaPath } = await cachedAssetPaths(key);
  const bodyTmp = `${bodyPath}.${process.pid}.tmp`;
  const metaTmp = `${metaPath}.${process.pid}.tmp`;
  await writeFile(bodyTmp, body);
  await writeFile(metaTmp, JSON.stringify({ statusCode, headers }));
  await rename(bodyTmp, bodyPath);
  await rename(metaTmp, metaPath);
}

function proxyHttpRequest(request, response) {
  const cacheable = isCacheableAssetRequest(request);
  const key = cacheable ? cacheKeyForUrl(request.url ?? "/") : null;

  Promise.resolve()
    .then(async () => {
      if (cacheable && key && (await trySendCachedAsset(response, key, request.method))) {
        return;
      }

      const upstreamRequest = http.request(
        upstreamRequestOptions(request, cacheable),
        (upstreamResponse) => {
          const statusCode = upstreamResponse.statusCode ?? 502;
          const headers = responseHeaders(
            upstreamResponse.headers,
            cacheable ? "MISS" : "BYPASS",
          );

          if (!cacheable || statusCode !== 200) {
            response.writeHead(statusCode, headers);
            upstreamResponse.pipe(response);
            return;
          }

          const chunks = [];
          upstreamResponse.on("data", (chunk) => {
            chunks.push(Buffer.from(chunk));
          });
          upstreamResponse.on("end", () => {
            const optimized = maybeMinifyJavaScript(
              request.url,
              headers,
              Buffer.concat(chunks),
            );
            response.writeHead(statusCode, optimized.headers);
            if (request.method === "HEAD") {
              response.end();
            } else {
              response.end(optimized.body);
            }
            if (key) {
              storeCachedAsset(
                key,
                statusCode,
                optimized.headers,
                optimized.body,
              ).catch((error) => {
                console.error(`[cache] store failed: ${error.message}`);
              });
            }
          });
        },
      );

      upstreamRequest.on("error", (error) => {
        if (!response.headersSent) {
          response.writeHead(502, { "content-type": "text/plain" });
        }
        response.end(`Upstream request failed: ${error.message}`);
      });

      request.pipe(upstreamRequest);
    })
    .catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain" });
      }
      response.end(`Proxy failed: ${error.message}`);
    });
}

function proxyUpgrade(request, socket, head) {
  const upstreamSocket = net.connect(
    Number(upstream.port || 80),
    upstream.hostname,
    () => {
      const headers = { ...request.headers, host: upstream.host };
      upstreamSocket.write(
        `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`,
      );
      for (const [name, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            upstreamSocket.write(`${name}: ${item}\r\n`);
          }
        } else if (value !== undefined) {
          upstreamSocket.write(`${name}: ${value}\r\n`);
        }
      }
      upstreamSocket.write("\r\n");
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      socket.pipe(upstreamSocket).pipe(socket);
    },
  );

  upstreamSocket.on("error", () => {
    socket.destroy();
  });
}

const server = http.createServer(proxyHttpRequest);
server.on("upgrade", proxyUpgrade);
server.listen(listenPort, listenHost, () => {
  console.log(
    `codex-web cached proxy listening at http://${listenHost}:${listenPort} -> ${upstream.href}`,
  );
  console.log(`asset cache: ${cacheDir}`);
});

setInterval(() => {}, 1 << 30);
