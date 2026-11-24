# NSE Signal

A no-login dashboard for NSE corporate announcements that match two categories:

- Confirmed orders, contracts, projects, and work awards received by the listed company.
- Board meetings explicitly concerning consideration, adoption, or approval of financial results.

The Node.js backend polls NSE's official corporate-announcements and equity-quote endpoints every minute, screens announcement text conservatively, deduplicates records, and stores announcement history in `data/announcements.json`. The backend must remain running for automatic monitoring to continue when the browser is closed. For always-on monitoring, deploy the Node process on an always-on server; opening the dashboard on a personal computer alone cannot run a closed-device background service.

## Run locally

Requires Node.js 20 or later. On first use of a PDF whose order value is not available as selectable text, the monitor downloads the English OCR model used to read scanned NSE tables.

```powershell
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). The first feed sync runs when the server starts. Use the dashboard's Refresh button to request a manual sync.

Run the screening tests:

```powershell
npm test
```

## Deploy to Render

1. Push this project to a GitHub repository.
2. In Render, choose **New → Blueprint**, connect the repository, and deploy its `render.yaml`.
3. Use the generated `*.onrender.com` URL to open the dashboard.

The Blueprint uses an always-on Starter web service in Singapore and a 1 GB persistent disk for `data/announcements.json`. A free, ephemeral web service is not suitable for continuous one-minute monitoring or retaining announcement history. Render's `/api/health` endpoint reports the monitor's degraded state in its response body while returning HTTP 200, so a temporary NSE outage does not cause the platform to restart a healthy app process.

## Data notes

- NSE is the source for announcements and equity quote data. An announcement's attachment link is preserved from the NSE feed.
- NSE is tried first for market data. If its quote endpoint is unavailable, the dashboard falls back to Yahoo Finance daily history and labels that source. The prior close is taken from the preceding daily bar, not the current/last price. Any field not supplied by that source (including Yahoo Finance traded turnover) is shown as N/A; turnover is never calculated from price and volume.
- Confirmed order awards are checked against the linked NSE PDF when the announcement feed does not state an order value. Disclosed values are extracted from that primary-source document; if the checked filing gives no value, the dashboard says "Not disclosed in NSE filing." If the attachment is unavailable or cannot be read, it says so rather than inventing a value.
- Scanned or image-based PDF tables are checked with OCR when selectable PDF text does not disclose an order value.
- Screening uses explicit text rules, not a human verification service. Open the linked NSE document to verify an announcement before relying on it; matching rules can miss unusual wording.
- NSE availability, access policies, and response fields can change. Feed or field errors are displayed in the dashboard rather than replaced with invented data.
- The app is designed for deployment behind a managed service/process supervisor and HTTPS. Its JSON history file is local to the server and should be backed up if retained history matters.

## Endpoints

- `GET /api/state` — stored announcements and update status.
- `POST /api/refresh` — manually run a poll.
- `GET /api/health` — backend health status.
