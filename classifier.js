const BOARD_RESULTS_PURPOSE =
  /\b(?:board\s+meeting|meeting\s+of\s+(?:the\s+)?board|board\s+of\s+directors)\b[^.;!?]{0,180}\b(?:consider(?:ation|ing)?|adopt(?:ion|ed)?|approve|approval|take\s+on\s+record)\b[^.;!?]{0,100}\b(?:financial\s+results?|quarterly\s+results?|half[\s-]yearly\s+results?|annual\s+results?)\b|\b(?:board\s+meeting|meeting\s+of\s+(?:the\s+)?board|board\s+of\s+directors)\b[^.;!?]{0,100}\b(?:financial\s+results?|quarterly\s+results?|half[\s-]yearly\s+results?|annual\s+results?)\b[^.;!?]{0,180}\b(?:consider(?:ation|ing)?|adopt(?:ion|ed)?|approve|approval|take\s+on\s+record)\b/i;

const ORDER_AWARD =
  /\b(?:(?:has|have)\s+been\s+awarded|(?:was|were|is|are)\s+awarded)\s+(?:a|an|the)?\s*(?:new\s+)?(?:order|contract|project|work|tender)\b|\b(?:received|secured|bagged)\s+(?:a|an|the)?\s*(?:new\s+)?(?:order|contract|project|work\s+order|letter\s+of\s+(?:award|acceptance))\b|\b(?:letter\s+of\s+(?:award|acceptance)|purchase\s+order)\s+(?:has\s+been\s+)?(?:received|issued)\b/i;
const NOT_AN_AWARD =
  /\b(?:participat(?:ed|ing)\s+in\s+(?:the\s+)?tender|submitted\s+(?:a\s+)?bid|bid\s+(?:has\s+been\s+)?submitted|unsuccessful\s+(?:bid|tender)|not\s+(?:been\s+)?awarded|no\s+order\s+(?:has\s+been\s+)?received|tender\s+(?:invitation|notice)|invited\s+to\s+(?:bid|tender)|emerged\s+as\s+(?:the\s+)?(?:lowest|successful)\s+bidder|letter\s+of\s+intent\s+only)\b/i;
const ISSUER_IS_AWARDER =
  /\b(?:we|(?:the\s+)?company|issuer|it)\s+(?:have\s+|has\s+)?(?:awarded|placed|issued|given)\s+(?:an?\s+)?(?:order|contract|work|purchase\s+order)\b|\b(?:order|contract)\s+(?:has\s+been\s+)?awarded\s+by\s+(?:us|the\s+company)\b/i;

function announcementText(announcement) {
  return [
    announcement.subject,
    announcement.desc,
    announcement.news_sub,
    announcement.attchmntText,
    announcement.voiceSummary,
    announcement.companyName,
    announcement.sm_name,
  ]
    .filter((value) => typeof value === "string")
    .join(" ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceDetails(announcement, fallback) {
  const details = [
    announcement.subject,
    announcement.attchmntText,
    announcement.voiceSummary,
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" — ");
  return details || fallback;
}

export function classifyAnnouncement(announcement) {
  const text = announcementText(announcement);
  if (!text) return null;
  const sourceText = [
    announcement.subject,
    announcement.desc,
    announcement.news_sub,
    announcement.attchmntText,
    announcement.voiceSummary,
  ]
    .filter((value) => typeof value === "string")
    .join(" ");
  const companyName = announcement.companyName ?? announcement.sm_name;
  let companyIsAwarder = false;
  let companyIsNamedRecipient = false;
  if (typeof companyName === "string" && companyName.trim()) {
    const escapedName = companyName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const issuerAction = new RegExp(
      `\\b(${escapedName}\\b\\s+(?:(?:has|have|had|will)\\s+)?(?:awards?|awarded|places?|placed|issues?|issued|gives?|given)\\s+(?:an?\\s+)?(?:order|contract|work|purchase\\s+order)\\b)`,
      "i",
    ).exec(sourceText);
    companyIsNamedRecipient = new RegExp(
      `\\b(?:order|contract|project|work)\\b[^.!?]{0,80}?\\bawarded\\s+to\\s+(?:the\\s+)?${escapedName}\\b|\\bawarded\\s+(?:a|an|the)?\\s*(?:order|contract|project|work)\\b[^.!?]{0,80}?\\bto\\s+(?:the\\s+)?${escapedName}\\b`,
      "i",
    ).test(sourceText);
    companyIsAwarder =
      Boolean(issuerAction) &&
      !/\b(?:has|have|is|are|was|were)\s+been\s+(?:awarded|placed|issued|given)\b/i.test(
        issuerAction[1],
      );
  }

  if (BOARD_RESULTS_PURPOSE.test(text)) {
    return {
      category: "board-results",
      details: sourceDetails(announcement, text),
    };
  }

  if (
    (ORDER_AWARD.test(text) || companyIsNamedRecipient) &&
    !NOT_AN_AWARD.test(text) &&
    !ISSUER_IS_AWARDER.test(text) &&
    !companyIsAwarder
  ) {
    return {
      category: "orders",
      details: sourceDetails(announcement, text),
    };
  }

  return null;
}

export function extractAwardingEntity(text) {
  const match = text.match(
    /\b(?:order|contract|project|work)\b[\s\S]{0,100}?\bfrom\s+([^.;\n]+)|\bawarded\s+(?:by|from)\s+([^.;\n]+)|\breceived\s+(?:an?\s+)?(?:order|contract)\s+from\s+([^.;\n]+)|\bawarded\s+(?:an?\s+)?(?:order|contract|project|work)\s+(?:by|from)\s+([^.;\n]+)|\b(?:order|contract|project|work)\b[^.;\n]{0,100}?\bby\s+([^.;\n]+)/i,
  );
  const entity = (match?.slice(1).find(Boolean) ?? "")
    .split(/\b(?:for|valued|worth|amounting|to execute|to supply|to provide)\b/i)[0]
    .replace(/[,:-]+$/, "")
    .trim();
  return entity || "N/A";
}

export function extractOrderValue(text) {
  const amountInWordsMatch =
    /\b(\d{1,3}(?:,\d{2})+,\d{3})\s*[\/|<({-]*\s*Rupees\b[\s\S]{0,120}?\bOnly\b([\s\S]{0,40}?\bincluding\s+GST\s*@?\s*\d{1,2}%?)?/i.exec(
      text,
    );
  if (amountInWordsMatch) {
    const gstText = amountInWordsMatch[2]?.match(
      /\bincluding\s+GST\s*@?\s*\d{1,2}%?/i,
    )?.[0];
    return `₹${amountInWordsMatch[1]}${gstText ? ` (${gstText})` : ""}`;
  }

  const amountPattern =
    "(?:(?:INR|Rs\\.?|₹|USD|US\\$|EUR|€|GBP|£|JPY|¥|AED|\\$)\\s*)?\\d[\\d,]*(?:\\.\\d+)?(?:\\s*(?:crores?|cr|lakhs?|lacs?|million|billion|mn|bn|thousand))?";
  const valueMatch =
    new RegExp(
      `\\b(?:total\\s+)?(?:order|contract|project|work|award)\\s+(?:(?:is\\s+)?(?:value|amount|cost|worth)|valued\\s+at|amounting\\s+to)\\s*(?:is|:|=|of)?\\s*(?:approximately\\s+|around\\s+)?(${amountPattern})\\b`,
      "i",
    ).exec(text) ??
    new RegExp(
      `\\b(?:value|amount|cost)\\s+of\\s+(?:the\\s+)?(?:order|contract|project|work|award)\\s*(?:is|:|=)?\\s*(${amountPattern})\\b`,
      "i",
    ).exec(text) ??
    new RegExp(
      `\\b(?:order|contract|project|work)\\s+(?:is\\s+)?for\\s+(${amountPattern})\\b`,
      "i",
    ).exec(text);
  return valueMatch?.[1]?.trim() ?? "N/A";
}

const DATE_PATTERN =
  "(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2})";

export function extractBoardMeetingDetails(text) {
  const date = new RegExp(
    `\\b(?:to\\s+be\\s+held|will\\s+be\\s+held|scheduled\\s+(?:to\\s+be\\s+held|for)|meeting\\s+(?:date\\s+is|is\\s+scheduled\\s+for|on))\\s+(?:on\\s+)?(${DATE_PATTERN})`,
    "i",
  ).exec(text)?.[1];
  const time =
    /\b(?:meeting|held|scheduled)\b[^.;!?]{0,120}?\bat\s+(\d{1,2}(?::|\.)\d{2}\s*(?:a\.?m\.?|p\.?m\.?|hrs?\.?|hours?)?|\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?|hrs?\.?|hours?))(?=$|[\s,.;])/i.exec(
      text,
    )?.[1];
  const period =
    /\b((?:Q[1-4]\s*(?:FY\s*)?\d{2,4}|(?:quarter(?:\s+and\s+(?:half[\s-]year|nine\s+months))?|half[\s-]year|financial year|year)\s+(?:ended|ending|of)\s+[^.;]{1,60}))\b/i.exec(
      text,
    )?.[1];

  return {
    scheduledMeetingDate: date ?? "N/A",
    scheduledMeetingTime: time?.trim() ?? "N/A",
    financialPeriod: period?.trim() ?? "N/A",
  };
}

export function classifyEntityOrigin(entity) {
  if (entity === "N/A") return "N/A";
  if (
    /\b(domestic|india|indian|government of india|state government|central government|nmdc|ntpc|bhel|ongc|gail|nhai|ircon|powergrid|power grid|indian railways)\b/i.test(
      entity,
    )
  ) {
    return "Domestic";
  }
  if (
    /\b(international|overseas|foreign|united states|usa|u\.s\.a\.|united kingdom|u\.k\.|uk|european union|uae|united arab emirates|saudi arabia|australia|canada|singapore|japan|germany|france)\b/i.test(
      entity,
    )
  ) {
    return "International";
  }
  return "N/A";
}
