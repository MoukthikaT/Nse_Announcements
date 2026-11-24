import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAnnouncement,
  classifyEntityOrigin,
  extractBoardMeetingDetails,
  extractAwardingEntity,
  extractOrderValue,
} from "../classifier.js";
import {
  formatNSEDate,
  normalizeAnnouncement,
  normalizeYahooMarketData,
} from "../nse.js";

test("includes a company announcement confirming an order award", () => {
  const match = classifyAnnouncement({
    subject: "Company has received an order from Government of India",
  });
  assert.equal(match?.category, "orders");
});

test("classifies real NSE feed fields when subject is absent", () => {
  const order = classifyAnnouncement({
    desc: "Bagging/Receiving of orders/contracts",
    sm_name: "Rail Vikas Nigam Limited",
    symbol: "RVNL",
    attchmntText:
      "Rail Vikas Nigam Limited has informed the Exchange about Bagging/Receiving of orders/contracts",
    voiceSummary:
      "Rail Vikas Nigam Limited has received a Letter of Award of Contract from NMDC Limited for the construction of a Super-Speciality Hospital.",
  });
  assert.equal(order?.category, "orders");
  assert.match(order.details, /NMDC Limited/);
  assert.equal(
    extractAwardingEntity(order.details),
    "NMDC Limited",
  );

  const resultsMeeting = classifyAnnouncement({
    desc: "Board Meeting",
    sm_name: "Example Limited",
    attchmntText:
      "The Board of Directors is scheduled to be held on November 27, 2026 to consider and approve unaudited financial results for the quarter ended September 30, 2026.",
  });
  assert.equal(resultsMeeting?.category, "board-results");
  assert.match(resultsMeeting.details, /November 27, 2026/);
});

test("classifies only NSE feed categories that report an order award", () => {
  const award = {
    desc: "Awarding of order(s)/contract(s)",
    sm_name: "Example Engineering Limited",
    symbol: "EXAMPLE",
    attchmntText:
      "Example Engineering Limited received a Letter of Intent from Example Authority for construction work.",
  };
  assert.equal(classifyAnnouncement(award)?.category, "orders");

  for (const desc of [
    "Action(s) taken or orders passed",
    "Corporate Insolvency Resolution Process",
    "Analysts/Institutional Investor Meet/Con. Call Updates",
  ]) {
    assert.equal(
      classifyAnnouncement({
        ...award,
        desc,
        voiceSummary:
          "The company received an order from the tribunal concerning a legal matter.",
      }),
      null,
      desc,
    );
  }
});

test("formats NSE feed date ranges in India-local date format", () => {
  assert.equal(formatNSEDate(new Date("2026-11-24T10:00:00Z")), "24-11-2026");
});

test("excludes bids, tender participation, and unconfirmed awards", () => {
  for (const subject of [
    "Company submitted a bid for a government tender",
    "Company emerged as the lowest bidder for a project",
    "Company has not been awarded the order",
    "Company is participating in the tender",
    "Company awarded a contract to another entity",
    "Company Ltd awarded a contract to a supplier",
  ]) {
    assert.equal(
      classifyAnnouncement({ subject, companyName: "Company Ltd" }),
      null,
      subject,
    );
  }
});

test("does not confuse a company receiving an award with awarding it", () => {
  assert.equal(
    classifyAnnouncement({
      companyName: "Company Ltd",
      subject: "Company Ltd has been awarded a contract by the authority",
    })?.category,
    "orders",
  );
  assert.equal(
    classifyAnnouncement({
      companyName: "Company Ltd",
      subject: "Contract awarded to Company Ltd by the authority",
    })?.category,
    "orders",
  );
  assert.equal(
    classifyAnnouncement({
      companyName: "Company Ltd",
      subject: "Another Ltd awarded a contract to Company Ltd",
    })?.category,
    "orders",
  );
});

test("only includes board meetings whose stated purpose is financial results", () => {
  assert.equal(
    classifyAnnouncement({
      subject: "Board Meeting to consider and approve quarterly financial results",
    })?.category,
    "board-results",
  );
  assert.equal(
    classifyAnnouncement({ subject: "Board meeting to discuss fund raising" }),
    null,
  );
  assert.equal(
    classifyAnnouncement({
      subject:
        "Board meeting to discuss fund raising; the prior annual results were approved last month.",
    }),
    null,
  );
  assert.equal(
    classifyAnnouncement({ subject: "Financial results declared by the company" }),
    null,
  );
});

test("leaves an awarding entity and origin unavailable when not stated", () => {
  assert.equal(extractAwardingEntity("Company received a significant order."), "N/A");
  assert.equal(classifyEntityOrigin("N/A"), "N/A");
});

test("extracts a disclosed awarding entity and clear origin", () => {
  const entity = extractAwardingEntity(
    "The company received an order from the Government of India for infrastructure work.",
  );
  assert.equal(entity, "the Government of India");
  assert.equal(classifyEntityOrigin(entity), "Domestic");
  assert.equal(classifyEntityOrigin("NMDC Limited"), "Domestic");
  assert.equal(
    extractAwardingEntity(
      "A contract was awarded to Company Ltd by International Power Inc.",
    ),
    "International Power Inc",
  );
});

test("extracts explicitly stated order value and board meeting details", () => {
  assert.equal(
    extractOrderValue("The company received an order worth Rs. 12.5 crore."),
    "Rs. 12.5 crore",
  );
  assert.equal(
    extractOrderValue("The order value is Rs. 75 crore."),
    "Rs. 75 crore",
  );
  assert.equal(
    extractOrderValue("The estimated value of the contract: INR 420 million."),
    "INR 420 million",
  );
  assert.equal(
    extractOrderValue("The contract is worth USD 12.5 million."),
    "USD 12.5 million",
  );
  assert.equal(
    extractOrderValue("The disclosed order value: EUR 2 million."),
    "EUR 2 million",
  );
  assert.equal(
    extractOrderValue(
      "86,58,00,000 /-(Rupees Eighty Six Crores Fifty Eighty Lakhs Only) including GST @ 18%",
    ),
    "₹86,58,00,000 (including GST @ 18%)",
  );
  assert.equal(extractOrderValue("The order was received."), "N/A");
  assert.deepEqual(
    extractBoardMeetingDetails(
      "The board meeting will be held on 25 November 2026 at 11:30 a.m. to consider results for the quarter ended September 30, 2026.",
    ),
    {
      scheduledMeetingDate: "25 November 2026",
      scheduledMeetingTime: "11:30 a.m.",
      financialPeriod: "quarter ended September 30, 2026",
    },
  );
  assert.equal(
    extractBoardMeetingDetails(
      "The Board of Directors meeting is scheduled for November 25, 2026 at 10.30 hrs to approve annual results for the quarter and half year ended September 30, 2026.",
    ).scheduledMeetingTime,
    "10.30 hrs",
  );
});

test("preserves an NSE attachment link and leaves undisclosed value as N/A", () => {
  const normalized = normalizeAnnouncement({
    category: "orders",
    symbol: "TESTCO",
    companyName: "Test Company",
    subject: "Received an order",
    attchmntFile: "https://nsearchives.nseindia.in/corporate/attachment.pdf",
    an_dt: "24-Nov-2026 09:00:00",
  });
  assert.equal(
    normalized.link,
    "https://nsearchives.nseindia.in/corporate/attachment.pdf",
  );
  assert.equal(normalized.orderValue, "N/A");
  assert.equal(normalized.symbol, "TESTCO");
  assert.equal(normalized.announcementTime, "09:00:00");
  assert.equal(
    normalizeAnnouncement({
      category: "orders",
      symbol: "TESTCO",
      companyName: "Test Company",
      subject: "Received an order",
      attchmntFile: "javascript:alert(1)",
    }).link,
    null,
  );
});

test("uses the preceding daily close and never estimates traded turnover", () => {
  const market = normalizeYahooMarketData({
    chart: {
      result: [
        {
          timestamp: [1795225500, 1795311900, 1795398300],
          meta: { fiftyTwoWeekHigh: 200, fiftyTwoWeekLow: 90 },
          indicators: {
            quote: [{ close: [110, 115, 120], volume: [1000, 1200, 1400] }],
          },
        },
      ],
    },
  });
  assert.equal(market.previousClose, 115);
  assert.equal(market.tradedVolume, 1400);
  assert.equal(market.tradedTurnover, "N/A");
  assert.equal(market.weekHigh, 200);
  assert.equal(market.weekLow, 90);
  assert.equal(market.source, "Yahoo Finance");
});
