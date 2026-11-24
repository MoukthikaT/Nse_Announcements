import { createServer } from "node:http";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyAnnouncement,
  classifyEntityOrigin,
  extractBoardMeetingDetails,
  extractAwardingEntity,
  extractOrderValue,
} from "./classifier.js";
import { NSEClient, normalizeAnnouncement } from "./nse.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DATA_FILE = join(ROOT, "data", "announcements.json");
const PORT = Number(process.env.PORT ?? 3000);
const POLL_INTERVAL_MS = 60 * 1000;
const ORDER_VALUE_EXTRACTION_VERSION = 2;
const nse = new NSEClient();

let state = {
  announcements: [],
  sourceCount: 0,
  lastSuccessfulUpdate: null,
  lastError: null,
  refreshing: false,
};
let pollPromise = null;

async function loadState() {
  try {
    const saved = JSON.parse(await readFile(DATA_FILE, "utf8"));
    if (Array.isArray(saved.announcements)) {
      state = {
        ...state,
        announcements: saved.announcements,
        sourceCount: saved.sourceCount ?? 0,
        lastSuccessfulUpdate: saved.lastSuccessfulUpdate ?? null,
      };
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function saveState(announcements, sourceCount, lastSuccessfulUpdate) {
  const serialized = JSON.stringify(
    {
      announcements,
      sourceCount,
      lastSuccessfulUpdate,
    },
    null,
    2,
  );
  await mkdir(dirname(DATA_FILE), { recursive: true });
  const temporary = `${DATA_FILE}.tmp`;
  await writeFile(temporary, serialized, "utf8");
  await rename(temporary, DATA_FILE);
}

async function pollAnnouncements() {
  if (pollPromise) return pollPromise;

  pollPromise = (async () => {
    state.refreshing = true;
    state.lastError = null;
    try {
      const sourceAnnouncements = await nse.getAnnouncements();
      const sourceCount = sourceAnnouncements.length;
      const candidates = sourceAnnouncements.flatMap((source) => {
        const classification = classifyAnnouncement(source);
        if (!classification) return [];

        let categoryDetails;
        if (classification.category === "orders") {
          const awardingEntity = extractAwardingEntity(classification.details);
          categoryDetails = {
            awardingEntity,
            entityOrigin: classifyEntityOrigin(awardingEntity),
            orderValue: extractOrderValue(classification.details),
          };
        } else {
          categoryDetails = extractBoardMeetingDetails(classification.details);
        }
        const normalized = normalizeAnnouncement({
          ...source,
          ...classification,
          ...categoryDetails,
        });
        return normalized.symbol === "N/A" ? [] : [normalized];
      });

      const storedById = new Map(state.announcements.map((item) => [item.id, item]));
      for (let offset = 0; offset < candidates.length; offset += 2) {
        await Promise.all(
          candidates.slice(offset, offset + 2).map(async (announcement) => {
            if (announcement.category !== "orders") return;
            const stored = storedById.get(announcement.id);
            if (
              (stored?.orderValueStatus === "disclosed" ||
                stored?.orderValueStatus === "not-disclosed") &&
              stored.orderValueExtractionVersion ===
                ORDER_VALUE_EXTRACTION_VERSION
            ) {
              announcement.orderValue = stored.orderValue;
              announcement.orderValueStatus = stored.orderValueStatus;
              announcement.orderValueSource = stored.orderValueSource;
              announcement.orderValueExtractionVersion =
                ORDER_VALUE_EXTRACTION_VERSION;
              return;
            }
            if (announcement.orderValue !== "N/A") {
              announcement.orderValueStatus = "disclosed";
              announcement.orderValueSource = "NSE announcement";
              announcement.orderValueExtractionVersion =
                ORDER_VALUE_EXTRACTION_VERSION;
              return;
            }
            if (!announcement.link) {
              announcement.orderValueStatus = "unavailable";
              announcement.orderValueSource = null;
              announcement.orderValueExtractionVersion =
                ORDER_VALUE_EXTRACTION_VERSION;
              return;
            }

            try {
              const documentText = await nse.getAnnouncementDocumentText(
                announcement.link,
              );
              const disclosedValue = extractOrderValue(documentText);
              announcement.orderValue = disclosedValue;
              announcement.orderValueStatus =
                disclosedValue === "N/A" ? "not-disclosed" : "disclosed";
              announcement.orderValueSource =
                disclosedValue === "N/A" ? "NSE PDF checked" : "NSE PDF";
              announcement.orderValueExtractionVersion =
                ORDER_VALUE_EXTRACTION_VERSION;
            } catch (error) {
              announcement.orderValueStatus = "unavailable";
              announcement.orderValueSource = null;
              announcement.orderValueExtractionVersion =
                ORDER_VALUE_EXTRACTION_VERSION;
              console.error(
                `[${new Date().toISOString()}] Could not check order value for ${announcement.symbol}: ${error.message}`,
              );
            }
          }),
        );
      }

      const seenIds = new Set(state.announcements.map(({ id }) => id));
      const fresh = candidates.filter(({ id }) => {
        if (seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
      });
      const currentById = new Map(candidates.map(({ id, ...item }) => [id, item]));
      const symbols = [...new Set(fresh.map(({ symbol }) => symbol))];
      const marketBySymbol = new Map();
      const errors = [];

      for (let offset = 0; offset < symbols.length; offset += 3) {
        await Promise.all(
          symbols.slice(offset, offset + 3).map(async (symbol) => {
            try {
              marketBySymbol.set(symbol, await nse.getMarketData(symbol));
            } catch (error) {
              errors.push(`${symbol}: ${error.message}`);
            }
          }),
        );
      }

      for (const announcement of fresh) {
        announcement.market = marketBySymbol.get(announcement.symbol) ?? null;
      }

      const updatedAnnouncements = [
        ...fresh,
        ...state.announcements.map((existing) => {
          const current = currentById.get(existing.id);
          return current
            ? { ...existing, ...current, market: existing.market ?? current.market }
            : existing;
        }),
      ];
      const updatedAt = new Date().toISOString();
      await saveState(updatedAnnouncements, sourceCount, updatedAt);
      state.announcements = updatedAnnouncements;
      state.sourceCount = sourceCount;
      state.lastSuccessfulUpdate = updatedAt;
      state.lastError =
        errors.length > 0
          ? `Announcements refreshed; market data unavailable: ${errors.join("; ")}`
          : null;
    } catch (error) {
      state.lastError = error.message || "NSE refresh failed";
      console.error(`[${new Date().toISOString()}] NSE refresh failed: ${state.lastError}`);
    } finally {
      state.refreshing = false;
      pollPromise = null;
    }
    return publicState();
  })();

  return pollPromise;
}

function publicState() {
  return {
    announcements: state.announcements,
    sourceCount: state.sourceCount,
    lastSuccessfulUpdate: state.lastSuccessfulUpdate,
    lastError: state.lastError,
    refreshing: state.refreshing,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

async function serveStatic(pathname, response) {
  const relativePath =
    pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = resolve(PUBLIC_DIR, normalize(relativePath));
  if (!filePath.startsWith(`${resolve(PUBLIC_DIR)}${sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 500);
    response.end(error.code === "ENOENT" ? "Not found" : "Internal server error");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJson(response, 200, publicState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/refresh") {
    try {
      await pollAnnouncements();
      sendJson(response, state.lastError ? 502 : 200, publicState());
    } catch (error) {
      sendJson(response, 502, { error: error.message });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      status: state.lastError ? "degraded" : "ok",
      lastSuccessfulUpdate: state.lastSuccessfulUpdate,
      lastError: state.lastError,
      refreshing: state.refreshing,
    });
    return;
  }

  if (request.method === "GET") {
    await serveStatic(url.pathname, response);
    return;
  }

  response.writeHead(405, { Allow: "GET, POST" });
  response.end("Method not allowed");
});

await loadState();
server.listen(PORT, () => {
  console.log(`NSE announcement monitor listening on http://localhost:${PORT}`);
  void pollAnnouncements();
});
setInterval(() => void pollAnnouncements(), POLL_INTERVAL_MS).unref();
