const state = {
  announcements: [],
  sourceCount: 0,
  category: "all",
  search: "",
  since: "",
  refreshing: false,
};

const elements = {
  list: document.querySelector("#announcement-list"),
  totalCount: document.querySelector("#total-count"),
  ordersCount: document.querySelector("#orders-count"),
  boardCount: document.querySelector("#board-count"),
  allTabCount: document.querySelector("#tab-all-count"),
  ordersTabCount: document.querySelector("#tab-orders-count"),
  boardTabCount: document.querySelector("#tab-board-count"),
  resultCount: document.querySelector("#result-count"),
  lastUpdated: document.querySelector("#last-updated"),
  notice: document.querySelector("#notice"),
  refreshButton: document.querySelector("#refresh-button"),
  search: document.querySelector("#search-input"),
  categoryFilter: document.querySelector("#category-filter"),
  dateFilter: document.querySelector("#date-filter"),
};

function escapeHtml(value) {
  return String(value ?? "N/A").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatNumber(value, currency = false) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 2,
    ...(currency ? { style: "currency", currency: "INR", maximumFractionDigits: 2 } : {}),
  }).format(value);
}

function formatDate(value) {
  if (!value || value === "N/A") return "N/A";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

function formatDateTime(value) {
  if (!value) return "Waiting for first sync";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(parsed);
}

function announcementTimestamp(item) {
  const value = item.announcementDate;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
  const fallback = new Date(item.announcementTime);
  return Number.isNaN(fallback.getTime()) ? 0 : fallback.getTime();
}

function fact(label, value, className = "") {
  return `<div class="fact ${className}"><span class="fact-label">${escapeHtml(label)}</span><span class="fact-value">${escapeHtml(value || "N/A")}</span></div>`;
}

function marketStats(market) {
  const data = market ?? {};
  return `
    <div class="market-row">
      <div class="market-meta"><strong>MARKET DATA · ${escapeHtml(data.source || "N/A")}</strong>As of ${escapeHtml(formatDate(data.tradingDate))}</div>
      <div class="market-stats">
        <div class="market-stat"><span>Prev. close</span><strong>${escapeHtml(formatNumber(data.previousClose, true))}</strong></div>
        <div class="market-stat"><span>52W high</span><strong>${escapeHtml(formatNumber(data.weekHigh, true))}</strong></div>
        <div class="market-stat"><span>52W low</span><strong>${escapeHtml(formatNumber(data.weekLow, true))}</strong></div>
        <div class="market-stat"><span>Volume</span><strong>${escapeHtml(formatNumber(data.tradedVolume))}</strong></div>
        <div class="market-stat"><span>Turnover</span><strong>${escapeHtml(formatNumber(data.tradedTurnover, true))}</strong></div>
      </div>
    </div>`;
}

function sourceLink(item) {
  if (!item.link) return '<span class="source-link unavailable">Source link unavailable</span>';
  return `<a class="source-link" href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">View NSE source ↗</a>`;
}

function renderCard(item) {
  const isOrder = item.category === "orders";
  const badge = isOrder ? "Order / contract" : "Results meeting";
  const orderValue =
    item.orderValueStatus === "not-disclosed"
      ? "Not disclosed in NSE filing"
      : item.orderValueStatus === "unavailable"
        ? "N/A · NSE document unavailable"
        : item.orderValue ?? "N/A";
  const facts = isOrder
    ? [
        fact("Awarded by", item.awardingEntity),
        fact("Entity origin", item.entityOrigin),
        fact(
          "Order value",
          orderValue,
          item.orderValueStatus === "disclosed" ? "value-disclosed" : "",
        ),
        fact("Announcement date", item.announcementDate),
        fact("Announcement time", item.announcementTime),
      ]
    : [
        fact("Meeting date", item.scheduledMeetingDate),
        fact("Meeting time", item.scheduledMeetingTime),
        fact("Financial period", item.financialPeriod),
        fact("Announcement date", item.announcementDate),
        fact("Announcement time", item.announcementTime),
      ];

  return `
    <article class="announcement-card">
      <div class="announcement-main">
        <div class="card-top">
          <div class="company-ident">
            <span class="symbol-chip">${escapeHtml(item.symbol)}</span>
            <span class="company-name">${escapeHtml(item.companyName)}</span>
          </div>
          <span class="category-tag ${isOrder ? "orders" : "board"}">${badge}</span>
        </div>
        <p class="card-subject">${escapeHtml(item.details || item.subject)}</p>
        <div class="card-facts">${facts.join("")}</div>
      </div>
      ${marketStats(item.market)}
      <div class="announcement-main source-footer">${sourceLink(item)}</div>
    </article>`;
}

function render() {
  const orders = state.announcements.filter((item) => item.category === "orders");
  const board = state.announcements.filter((item) => item.category === "board-results");
  elements.totalCount.textContent = state.announcements.length.toLocaleString("en-IN");
  elements.ordersCount.textContent = orders.length.toLocaleString("en-IN");
  elements.boardCount.textContent = board.length.toLocaleString("en-IN");
  elements.allTabCount.textContent = state.announcements.length;
  elements.ordersTabCount.textContent = orders.length;
  elements.boardTabCount.textContent = board.length;

  const query = state.search.trim().toLocaleLowerCase();
  const sinceTime = state.since ? new Date(`${state.since}T00:00:00`).getTime() : null;
  const filtered = state.announcements
    .filter((item) => state.category === "all" || item.category === state.category)
    .filter((item) => {
      if (!query) return true;
      return `${item.companyName} ${item.symbol}`.toLocaleLowerCase().includes(query);
    })
    .filter((item) => sinceTime === null || announcementTimestamp(item) >= sinceTime)
    .sort((a, b) => announcementTimestamp(b) - announcementTimestamp(a));

  elements.resultCount.textContent = `${filtered.length} announcement${filtered.length === 1 ? "" : "s"}`;
  if (filtered.length === 0) {
    const hasData = state.announcements.length > 0;
    const emptyMessage = hasData
      ? "Try a different company, category, or date."
      : `Checked ${state.sourceCount} recent NSE announcements. No matching order award or financial-results board meeting was found in the current feed.`;
    elements.list.innerHTML = `<div class="empty-state">
      <span class="empty-icon" aria-hidden="true">${hasData ? "⌕" : "↗"}</span>
      <strong>${hasData ? "No announcements match these filters" : "No matching announcements yet"}</strong>
      <p>${escapeHtml(emptyMessage)}</p>
    </div>`;
  } else {
    elements.list.innerHTML = filtered.map(renderCard).join("");
  }
}

function showNotice(message) {
  elements.notice.textContent = message;
  elements.notice.hidden = !message;
}

function setRefreshing(refreshing) {
  state.refreshing = refreshing;
  elements.refreshButton.disabled = refreshing;
  elements.refreshButton.querySelector("span").textContent = refreshing ? "Refreshing…" : "Refresh";
}

function applyResponse(payload) {
  if (Array.isArray(payload.announcements)) state.announcements = payload.announcements;
  state.sourceCount = payload.sourceCount ?? 0;
  const scannedCount = Number(payload.sourceCount ?? 0);
  document.querySelector(".update-frequency").textContent =
    `Scanned ${scannedCount} recent NSE announcements · auto-refresh every minute`;
  elements.lastUpdated.textContent = formatDateTime(payload.lastSuccessfulUpdate);
  showNotice(payload.lastError || "");
  render();
}

async function loadState() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
    applyResponse(await response.json());
  } catch (error) {
    showNotice(`Could not load announcements: ${error.message}. Check that the backend is running.`);
  }
}

async function refresh() {
  if (state.refreshing) return;
  setRefreshing(true);
  showNotice("");
  try {
    const response = await fetch("/api/refresh", { method: "POST" });
    const payload = await response.json();
    applyResponse(payload);
    if (!response.ok && !payload.lastError) {
      showNotice(payload.error || `Refresh failed (HTTP ${response.status}).`);
    }
  } catch (error) {
    showNotice(`Refresh failed: ${error.message}`);
  } finally {
    setRefreshing(false);
  }
}

elements.search.addEventListener("input", (event) => {
  state.search = event.target.value;
  render();
});
elements.categoryFilter.addEventListener("change", (event) => {
  state.category = event.target.value;
  document.querySelectorAll(".category-tab").forEach((tab) => {
    const active = tab.dataset.tab === state.category;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  render();
});
elements.dateFilter.addEventListener("change", (event) => {
  state.since = event.target.value;
  render();
});
document.querySelectorAll(".category-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.category = tab.dataset.tab;
    elements.categoryFilter.value = state.category;
    document.querySelectorAll(".category-tab").forEach((candidate) => {
      const active = candidate === tab;
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-selected", String(active));
    });
    render();
  });
});
elements.refreshButton.addEventListener("click", refresh);

void loadState();
window.setInterval(() => void loadState(), 30_000);
