import { PDFParse } from "pdf-parse";
import { createWorker } from "tesseract.js";
import { extractOrderValue } from "./classifier.js";

const NSE_ORIGIN = "https://www.nseindia.com";
const ANNOUNCEMENTS_URL = `${NSE_ORIGIN}/api/corporate-announcements?index=equities`;
const NSE_PAGE_URL = `${NSE_ORIGIN}/`;
const REQUEST_TIMEOUT_MS = 25_000;
const ANNOUNCEMENT_LOOKBACK_DAYS = 2;
let ocrWorkerPromise;

export function formatNSEDate(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })
    .format(date)
    .replaceAll("/", "-");
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker("eng").catch((error) => {
      ocrWorkerPromise = null;
      throw error;
    });
  }
  return ocrWorkerPromise;
}

function valueCellRectangles(hocr, width, height) {
  const rectangles = [];
  const lines = hocr.split("<span class='ocr_line'");
  for (const line of lines.slice(1)) {
    const text = line
      .slice(0, line.indexOf("<span class='ocr_line'") === -1
        ? undefined
        : line.indexOf("<span class='ocr_line'"))
      .replace(/<[^>]*>/g, " ");
    if (!/\b(?:rupees|crores?|lakhs?|GST)\b/i.test(text)) continue;

    const bounds = /bbox (\d+) (\d+) (\d+) (\d+)/.exec(line);
    if (!bounds) continue;
    const [left, top, right, bottom] = bounds.slice(1).map(Number);
    const cropLeft = Math.floor(width * 0.45);
    const cropTop = Math.max(0, top - Math.floor(height * 0.036));
    rectangles.push({
      left: cropLeft,
      top: cropTop,
      width: width - cropLeft,
      height: Math.min(
        height - cropTop,
        bottom - top + Math.floor(height * 0.036) + 10,
      ),
    });
  }
  return rectangles;
}

function isRetryable(error) {
  if (error.message.includes("invalid JSON")) return true;
  if (/\bHTTP (?:401|403|408|425|429|5\d{2})\b/.test(error.message)) return true;
  return (
    error.cause?.name === "TimeoutError" ||
    error.cause?.name === "AbortError" ||
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH"].includes(
      error.cause?.cause?.code ?? error.cause?.code,
    )
  );
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function numberOrNA(value) {
  if (value === null || value === undefined || value === "") return "N/A";
  const number = Number(String(value).replaceAll(",", "").replaceAll("₹", "").trim());
  return Number.isFinite(number) ? number : "N/A";
}

function firstAvailable(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== "");
}

export function normalizeAnnouncementDate(announcement) {
  return (
    firstAvailable(
      announcement.an_dt,
      announcement.sort_date,
      announcement.dissemDT,
      announcement.dt,
      announcement.date,
    ) ?? "N/A"
  );
}

function normalizeAnnouncementTime(announcement) {
  const value = firstAvailable(
    announcement.exchdisstime,
    announcement.dissemDT,
    announcement.an_dt,
    announcement.sort_date,
  );
  if (typeof value !== "string") return "N/A";
  const match = value.match(/(?:^|[ T])(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  return match?.[1] ?? "N/A";
}

export function normalizeAnnouncement(announcement) {
  const category = announcement.category;
  const symbol = firstAvailable(announcement.symbol, announcement.scrip);
  const companyName = firstAvailable(
    announcement.companyName,
    announcement.sm_name,
    announcement.company,
  );
  const rawLink = firstAvailable(announcement.attchmntFile, announcement.attachment);
  let link = null;
  if (typeof rawLink === "string" && rawLink.trim()) {
    try {
      const sourceUrl = new URL(rawLink.trim(), NSE_ORIGIN);
      if (
        sourceUrl.protocol === "https:" &&
        (sourceUrl.hostname === "nseindia.com" ||
          sourceUrl.hostname.endsWith(".nseindia.com") ||
          sourceUrl.hostname === "nseindia.in" ||
          sourceUrl.hostname.endsWith(".nseindia.in"))
      ) {
        link = sourceUrl.toString();
      }
    } catch {
      link = null;
    }
  }
  const id =
    firstAvailable(announcement.seq_id, announcement.id) ??
    [
      symbol,
      normalizeAnnouncementDate(announcement),
      announcement.subject ?? "",
      link ?? "",
    ].join("|");
  const details =
    announcement.details ??
    [announcement.subject, announcement.desc]
      .filter((value) => typeof value === "string" && value.trim())
      .join(" — ");

  return {
    id: String(id),
    category,
    symbol: typeof symbol === "string" ? symbol : "N/A",
    companyName: typeof companyName === "string" ? companyName : "N/A",
    subject: announcement.subject || "N/A",
    details: details || "N/A",
    awardingEntity:
      category === "orders" ? announcement.awardingEntity ?? "N/A" : undefined,
    entityOrigin:
      category === "orders" ? announcement.entityOrigin ?? "N/A" : undefined,
    orderValue: category === "orders" ? announcement.orderValue ?? "N/A" : undefined,
    orderValueStatus:
      category === "orders" ? announcement.orderValueStatus ?? null : undefined,
    orderValueSource:
      category === "orders" ? announcement.orderValueSource ?? null : undefined,
    scheduledMeetingDate:
      category === "board-results"
        ? announcement.scheduledMeetingDate ?? "N/A"
        : undefined,
    scheduledMeetingTime:
      category === "board-results"
        ? announcement.scheduledMeetingTime ?? "N/A"
        : undefined,
    financialPeriod:
      category === "board-results"
        ? announcement.financialPeriod ?? "N/A"
        : undefined,
    announcementDate: normalizeAnnouncementDate(announcement),
    announcementTime: normalizeAnnouncementTime(announcement),
    link,
    market: announcement.market ?? null,
  };
}

export function normalizeYahooMarketData(payload) {
  const chart = payload?.chart?.result?.[0];
  if (!chart) {
    throw new Error(
      payload?.chart?.error?.description ?? "Yahoo Finance returned no chart data",
    );
  }

  const timestamps = chart.timestamp ?? [];
  const closes = chart.indicators?.quote?.[0]?.close ?? [];
  const volumes = chart.indicators?.quote?.[0]?.volume ?? [];
  let lastValidIndex = -1;
  for (let index = timestamps.length - 1; index >= 0; index--) {
    if (Number.isFinite(closes[index])) {
      lastValidIndex = index;
      break;
    }
  }

  const meta = chart.meta ?? {};
  const lastDate =
    lastValidIndex >= 0
      ? new Date(timestamps[lastValidIndex] * 1000).toISOString().slice(0, 10)
      : "N/A";

  return {
    tradingDate: lastDate,
    source: "Yahoo Finance",
    previousClose:
      lastValidIndex > 0 ? numberOrNA(closes[lastValidIndex - 1]) : "N/A",
    weekHigh: numberOrNA(meta.fiftyTwoWeekHigh),
    weekLow: numberOrNA(meta.fiftyTwoWeekLow),
    tradedVolume:
      lastValidIndex >= 0 ? numberOrNA(volumes[lastValidIndex]) : "N/A",
    tradedTurnover: "N/A",
  };
}

export class NSEClient {
  #cookie = "";

  async getAnnouncementDocumentText(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      throw new Error("NSE announcement document URL is invalid", { cause: error });
    }

    if (
      url.protocol !== "https:" ||
      !(
        url.hostname === "nseindia.com" ||
        url.hostname.endsWith(".nseindia.com") ||
        url.hostname === "nseindia.in" ||
        url.hostname.endsWith(".nseindia.in")
      )
    ) {
      throw new Error("Refusing to fetch a document outside the NSE domain");
    }

    const response = await fetch(url, {
      headers: {
        Accept: "application/pdf",
        Referer: NSE_PAGE_URL,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`NSE document returned HTTP ${response.status}`);
    }
    if (!response.headers.get("content-type")?.toLowerCase().includes("pdf")) {
      throw new Error("NSE document response is not a PDF");
    }

    const contentLength = Number(response.headers.get("content-length"));
    const maxDocumentSize = 10 * 1024 * 1024;
    if (Number.isFinite(contentLength) && contentLength > maxDocumentSize) {
      throw new Error("NSE announcement PDF exceeds the 10 MB processing limit");
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxDocumentSize) {
      throw new Error("NSE announcement PDF exceeds the 10 MB processing limit");
    }

    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      if (extractOrderValue(result.text) !== "N/A") return result.text;

      const worker = await getOcrWorker();
      const ocrPages = [];
      for (const page of result.pages) {
        await worker.setParameters({ tessedit_pageseg_mode: "3" });
        const screenshot = await parser.getScreenshot({
          partial: [page.num],
          desiredWidth: 3000,
        });
        const image = screenshot.pages[0]?.data;
        if (!image) continue;

        const pageOcr = await worker.recognize(image, {}, { hocr: true });
        ocrPages.push(pageOcr.data.text);
        for (const rectangle of valueCellRectangles(
          pageOcr.data.hocr ?? "",
          screenshot.pages[0].width,
          screenshot.pages[0].height,
        )) {
          await worker.setParameters({ tessedit_pageseg_mode: "6" });
          const valueCell = await worker.recognize(
            image,
            { rectangle },
            { hocr: true },
          );
          ocrPages.push(valueCell.data.text);
          if (extractOrderValue(`${result.text}\n${ocrPages.join("\n")}`) !== "N/A") {
            return `${result.text}\n${ocrPages.join("\n")}`;
          }
        }
        if (extractOrderValue(`${result.text}\n${ocrPages.join("\n")}`) !== "N/A") {
          return `${result.text}\n${ocrPages.join("\n")}`;
        }
      }
      return `${result.text}\n${ocrPages.join("\n")}`;
    } finally {
      await parser.destroy();
    }
  }

  async #fetch(url) {
    let response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Referer: NSE_PAGE_URL,
          ...(this.#cookie ? { Cookie: this.#cookie } : {}),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `NSE request failed for ${new URL(url).pathname}: ${error.message}`,
        { cause: error },
      );
    }

    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (setCookies.length) {
      this.#cookie = setCookies.map((cookie) => cookie.split(";")[0]).join("; ");
    }

    if (!response.ok) {
      throw new Error(`NSE returned HTTP ${response.status} for ${new URL(url).pathname}`);
    }
    return response;
  }

  async #bootstrap() {
    try {
      await this.#fetch(NSE_PAGE_URL);
    } catch (error) {
      if (!isRetryable(error)) throw error;
      this.#cookie = "";
      await pause(500);
      await this.#fetch(NSE_PAGE_URL);
    }
  }

  async #requestJson(url) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.#fetch(url);
        try {
          return await response.json();
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new Error(`NSE returned invalid JSON for ${new URL(url).pathname}`);
          }
          throw error;
        }
      } catch (error) {
        if (attempt === 1 || !isRetryable(error)) throw error;
        this.#cookie = "";
        await pause(500);
        await this.#bootstrap();
      }
    }
    throw new Error("NSE request failed after retry");
  }

  async getAnnouncements() {
    const now = new Date();
    const fromDate = new Date(
      now.getTime() - ANNOUNCEMENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );
    const url = new URL(ANNOUNCEMENTS_URL);
    url.searchParams.set("from_date", formatNSEDate(fromDate));
    url.searchParams.set("to_date", formatNSEDate(now));
    const data = await this.#requestJson(url);
    if (!Array.isArray(data)) {
      throw new Error("NSE announcement feed did not return an announcement list");
    }
    return data;
  }

  async getMarketData(symbol) {
    if (!symbol || symbol === "N/A") return null;
    try {
      return await this.#getNSEMarketData(symbol);
    } catch (nseError) {
      try {
        return await this.#getYahooMarketData(symbol);
      } catch (yahooError) {
        throw new Error(
          `NSE market data failed (${nseError.message}); Yahoo Finance fallback failed (${yahooError.message})`,
        );
      }
    }
  }

  async #getNSEMarketData(symbol) {
    const url = new URL("/api/quote-equity", NSE_ORIGIN);
    url.searchParams.set("symbol", symbol);
    const quote = await this.#requestJson(url);
    const price = quote?.priceInfo ?? {};
    const week = price.weekHighLow ?? {};
    const trade = quote?.marketDeptOrderBook?.tradeInfo ?? {};
    const security = quote?.securityWiseDP ?? {};
    const updateTime =
      quote?.metadata?.lastUpdateTime ??
      quote?.priceInfo?.lastUpdateTime ??
      quote?.marketDeptOrderBook?.tradeInfo?.lastUpdateTime ??
      "N/A";

    return {
      tradingDate: updateTime,
      previousClose: numberOrNA(price.previousClose),
      weekHigh: numberOrNA(week.max),
      weekLow: numberOrNA(week.min),
      source: "NSE",
      tradedVolume: numberOrNA(
        firstAvailable(trade.totalTradedVolume, security.quantityTraded),
      ),
      tradedTurnover: numberOrNA(
        firstAvailable(trade.totalTradedValue, trade.totalTradedValueRs),
      ),
    };
  }

  async #getYahooMarketData(symbol) {
    const url = new URL(
      `/v8/finance/chart/${encodeURIComponent(`${symbol}.NS`)}`,
      "https://query1.finance.yahoo.com",
    );
    url.searchParams.set("range", "1y");
    url.searchParams.set("interval", "1d");
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Yahoo Finance returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    return normalizeYahooMarketData(payload);
  }
}
