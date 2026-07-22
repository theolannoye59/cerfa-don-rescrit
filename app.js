/* CERFA 2041-RD (11580*05) — overlay on flat PDF template */

const PAGE_H = 842;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const form = $("#cerfa-form");
const statusEl = $("#status");
const amountInput = form.elements.amount;
const amountWordsInput = form.elements.amountWords;
const signatureCanvas = $("#signature-pad");
const signatureCtx = signatureCanvas.getContext("2d");
let signatureDrawing = false;
let signatureHasInk = false;

/* ---------- French number → words ---------- */

const UNITS = [
  "", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf",
  "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize",
  "dix-sept", "dix-huit", "dix-neuf",
];
const TENS = [
  "", "", "vingt", "trente", "quarante", "cinquante", "soixante",
  "soixante", "quatre-vingt", "quatre-vingt",
];

function underHundred(n) {
  if (n < 20) return UNITS[n];
  if (n < 70) {
    const t = Math.floor(n / 10);
    const u = n % 10;
    if (u === 1 && t !== 8) return `${TENS[t]} et un`;
    return u ? `${TENS[t]}-${UNITS[u]}` : TENS[t];
  }
  if (n < 80) {
    // 70-79 → soixante-dix ...
    return n === 71 ? "soixante et onze" : `soixante-${UNITS[n - 60]}`;
  }
  // 80-99
  if (n === 80) return "quatre-vingts";
  return `quatre-vingt-${UNITS[n - 80]}`;
}

function underThousand(n) {
  if (n < 100) return underHundred(n);
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const head = h === 1 ? "cent" : `${UNITS[h]} cent${rest === 0 && h > 1 ? "s" : ""}`;
  return rest ? `${head} ${underHundred(rest)}` : head;
}

function integerToFrench(n) {
  if (n === 0) return "zéro";
  if (n < 0) return `moins ${integerToFrench(-n)}`;

  const parts = [];
  const billions = Math.floor(n / 1_000_000_000);
  const millions = Math.floor((n % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;

  if (billions) {
    parts.push(
      billions === 1 ? "un milliard" : `${underThousand(billions)} milliards`
    );
  }
  if (millions) {
    parts.push(
      millions === 1 ? "un million" : `${underThousand(millions)} millions`
    );
  }
  if (thousands) {
    parts.push(thousands === 1 ? "mille" : `${underThousand(thousands)} mille`);
  }
  if (rest) parts.push(underThousand(rest));
  return parts.join(" ");
}

function amountToFrenchWords(value) {
  if (value === "" || value == null || Number.isNaN(Number(value))) return "";
  const num = Math.round(Number(value) * 100) / 100;
  const euros = Math.floor(num);
  const cents = Math.round((num - euros) * 100);
  let text = `${integerToFrench(euros)} euro${euros > 1 ? "s" : ""}`;
  if (cents > 0) {
    text += ` et ${integerToFrench(cents)} centime${cents > 1 ? "s" : ""}`;
  }
  return text;
}

/* ---------- PDF helpers (pymupdf top-left → pdf-lib bottom-left) ---------- */

/** Baseline clearly above a dotted line (lineBottomY = bottom of dots, from page top). */
function yAboveLine(lineBottomY, lift = 2.2) {
  return PAGE_H - lineBottomY + lift;
}

/** Baseline so an "X" is vertically centered in a checkbox. */
function yCheckCenter(boxTopY, boxH = 9, glyphSize = 7.5) {
  const centerFromTop = boxTopY + boxH / 2;
  return PAGE_H - centerFromTop - glyphSize * 0.36;
}

function formatDateFR(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d} / ${m} / ${y}`;
}

/** WinAnsi-safe text for StandardFonts (Helvetica). */
function normalizePdfText(text) {
  if (!text) return "";
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0152/g, "OE")
    .replace(/\u0153/g, "oe")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u00a0\u202f\u2009\u2007\u2008\u2060]/g, " ")
    .replace(/\u2026/g, "...");
}

function formatAmount(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return "";
  const sign = num < 0 ? "-" : "";
  const abs = Math.abs(num);
  const intPart = String(Math.trunc(abs));
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  if (Number.isInteger(num)) return `${sign}${grouped}`;
  const cents = abs.toFixed(2).split(".")[1];
  return `${sign}${grouped},${cents}`;
}

/** Fit object text on the 2 dotted lines, shrinking font if needed. */
function fitObjectText(raw, font) {
  const text = normalizePdfText(raw).trim().replace(/\s+/g, " ");
  if (!text) return { lines: [], size: 8 };

  const line1Max = 480; // from x≈72 to ≈552
  const line2Max = 520; // from x≈34 to ≈554

  for (let size = 8; size >= 5.5; size -= 0.5) {
    const words = text.split(" ");
    let line1 = "";
    let i = 0;
    while (i < words.length) {
      const trial = line1 ? `${line1} ${words[i]}` : words[i];
      if (font.widthOfTextAtSize(trial, size) <= line1Max) {
        line1 = trial;
        i += 1;
      } else break;
    }
    const rest = words.slice(i).join(" ");
    if (!rest) return { lines: [line1], size };
    if (font.widthOfTextAtSize(rest, size) <= line2Max) {
      return { lines: [line1, rest], size };
    }
  }

  // Last resort: truncate line 2 with ellipsis
  const size = 5.5;
  const words = text.split(" ");
  let line1 = "";
  let i = 0;
  while (i < words.length) {
    const trial = line1 ? `${line1} ${words[i]}` : words[i];
    if (font.widthOfTextAtSize(trial, size) <= line1Max) {
      line1 = trial;
      i += 1;
    } else break;
  }
  let line2 = words.slice(i).join(" ");
  while (line2 && font.widthOfTextAtSize(`${line2}...`, size) > line2Max) {
    line2 = line2.replace(/\s+\S+$/, "");
  }
  return { lines: [line1, line2 ? `${line2}...` : ""], size };
}

/* Checkbox coordinates from template (top-left origin) */

const ORG_CATEGORY = {
  oeuvre: { page: 0, x: 34.0, y: 390.6 },
  cultuelle: { page: 0, x: 35.3, y: 508.7 },
  fonds: { page: 0, x: 35.3, y: 526.1 },
  presse: { page: 0, x: 35.3, y: 543.6 },
  enseignement: { page: 0, x: 35.3, y: 572.0 },
  consulaire: { page: 0, x: 35.3, y: 600.4 },
  pme: { page: 0, x: 35.3, y: 617.9 },
  spectacle: { page: 0, x: 35.3, y: 646.3 },
  patrimoine: { page: 0, x: 35.3, y: 685.7 },
  conflit: { page: 0, x: 35.3, y: 725.3 },
  recherche: { page: 1, x: 35.3, y: 23.4 },
  insertion: { page: 1, x: 35.3, y: 41.5 },
  assoInter: { page: 1, x: 35.3, y: 58.3 },
  aci: { page: 1, x: 35.3, y: 75.7 },
  adaptees: { page: 1, x: 35.3, y: 93.2 },
  anr: { page: 1, x: 35.3, y: 110.6 },
  geiq: { page: 1, x: 35.3, y: 128.2 },
  creation: { page: 1, x: 35.3, y: 145.6 },
  ue: { page: 1, x: 35.3, y: 174.0 },
};

const ORG_SUBTYPE = {
  asso1901: { x: 63.6, y: 339.7 },
  rup: { x: 63.5, y: 353.6 },
  fondationUniv: { x: 63.5, y: 389.5 },
  fondationEntreprise: { x: 63.6, y: 414.5 },
  musee: { x: 63.6, y: 428.4 },
  aide: { x: 63.5, y: 442.4 },
  foret: { x: 63.5, y: 467.3 },
  autres: { x: 63.6, y: 492.2 },
};

/* ---------- UI visibility ---------- */

function updateVisibility() {
  const category = form.elements.orgCategory?.value;
  const subtype = form.elements.orgSubtype?.value;
  const nature = form.elements.donationNature.value;

  $$("[data-show-when]").forEach((el) => {
    el.hidden = el.dataset.showWhen !== category;
  });
  $$("[data-show-when-subtype]").forEach((el) => {
    el.hidden = category !== "oeuvre" || el.dataset.showWhenSubtype !== subtype;
  });
  $$("[data-show-when-nature]").forEach((el) => {
    el.hidden = el.dataset.showWhenNature !== nature;
  });
  $$("[data-show-when-nature-block]").forEach((el) => {
    el.hidden = nature !== el.dataset.showWhenNatureBlock;
  });
}

function syncAmountWords() {
  amountWordsInput.value = amountToFrenchWords(amountInput.value);
}

function setStatus(msg, type = "") {
  statusEl.textContent = msg;
  statusEl.className = `hint${type ? ` ${type}` : ""}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/* ---------- Signature pad ---------- */

function clearSignature() {
  const { width, height } = signatureCanvas;
  signatureCtx.clearRect(0, 0, width, height);
  signatureHasInk = false;
}

function canvasPoint(event) {
  const rect = signatureCanvas.getBoundingClientRect();
  const source = event.touches ? event.touches[0] : event;
  return {
    x: ((source.clientX - rect.left) / rect.width) * signatureCanvas.width,
    y: ((source.clientY - rect.top) / rect.height) * signatureCanvas.height,
  };
}

function startSignature(event) {
  event.preventDefault();
  signatureDrawing = true;
  const { x, y } = canvasPoint(event);
  signatureCtx.beginPath();
  signatureCtx.moveTo(x, y);
}

function moveSignature(event) {
  if (!signatureDrawing) return;
  event.preventDefault();
  const { x, y } = canvasPoint(event);
  signatureCtx.lineWidth = 2.4;
  signatureCtx.lineCap = "round";
  signatureCtx.lineJoin = "round";
  signatureCtx.strokeStyle = "#1e1e1c";
  signatureCtx.lineTo(x, y);
  signatureCtx.stroke();
  signatureCtx.beginPath();
  signatureCtx.moveTo(x, y);
  signatureHasInk = true;
}

function endSignature() {
  signatureDrawing = false;
  signatureCtx.beginPath();
}

function signaturePngBytes() {
  if (!signatureHasInk) return null;

  // Trim empty margins so the drawing fills the PDF slot at the right size
  const { width, height } = signatureCanvas;
  const pixels = signatureCtx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = pixels[(y * width + x) * 4 + 3];
      if (a > 20) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  const pad = 8;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  const trimmed = document.createElement("canvas");
  trimmed.width = cropW;
  trimmed.height = cropH;
  trimmed.getContext("2d").drawImage(
    signatureCanvas,
    minX,
    minY,
    cropW,
    cropH,
    0,
    0,
    cropW,
    cropH
  );

  const dataUrl = trimmed.toDataURL("image/png");
  const bin = atob(dataUrl.split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ---------- PDF generation ---------- */

function templateBytes() {
  if (!window.CERFA_TEMPLATE_BASE64) {
    throw new Error("Modèle CERFA introuvable (template-base64.js).");
  }
  const bin = atob(window.CERFA_TEMPLATE_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function fillPdf(data) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdf = await PDFDocument.load(templateBytes());
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();
  const p1 = pages[0];
  const p2 = pages[1];

  const ink = rgb(0, 0, 0);

  // write(page, text, x, lineBottomYFromTop, size) — sits clearly above dotted lines
  const write = (page, text, x, lineBottomY, size = 10, bold = false) => {
    const value = normalizePdfText(text);
    if (!value) return;
    page.drawText(value, {
      x,
      y: yAboveLine(lineBottomY),
      size,
      font: bold ? fontBold : font,
      color: ink,
    });
  };

  // Date: blank out preprinted ……/……/…… guides, then write "JJ / MM / YYYY"
  const writeDate = (page, iso, x, lineTopY, lineBottomY, size = 11) => {
    const value = formatDateFR(iso);
    if (!value) return;
    const textWidth = fontBold.widthOfTextAtSize(value, size);
    const guideHeight = Math.max(lineBottomY - lineTopY, 10);
    const y = yAboveLine(lineBottomY, 2.8);
    page.drawRectangle({
      x: x - 2,
      y: PAGE_H - lineBottomY - 1,
      width: Math.max(textWidth + 8, 62),
      height: guideHeight + 4,
      color: rgb(1, 1, 1),
    });
    page.drawText(value, {
      x,
      y,
      size,
      font: fontBold,
      color: ink,
    });
  };

  // Centered X in square checkbox (~8×9)
  const mark = (page, boxX, boxTopY, boxW = 8.0, boxH = 9.0) => {
    const glyph = 7.2;
    const width = fontBold.widthOfTextAtSize("X", glyph);
    page.drawText("X", {
      x: boxX + (boxW - width) / 2 + 0.25,
      y: yCheckCenter(boxTopY, boxH, glyph),
      size: glyph,
      font: fontBold,
      color: ink,
    });
  };

  // Filled dot centered in round radio (~8×9)
  const markRadio = (page, boxX, boxTopY, boxW = 8.0, boxH = 9.0) => {
    page.drawCircle({
      x: boxX + boxW / 2,
      y: PAGE_H - (boxTopY + boxH / 2),
      size: 2.35,
      color: ink,
    });
  };

  // --- Page 1: organisme ---
  write(p1, data.receiptNumber, 428, 126, 11, true);
  write(p1, data.orgName, 34, 179, 10);
  write(p1, data.orgSiren, 198, 189.5, 10);
  write(p1, data.orgStreetNumber, 50, 218.4, 10);
  write(p1, data.orgStreet, 134, 218.4, 10);
  write(p1, data.orgPostal, 97, 232.4, 10);
  write(p1, data.orgCity, 231, 232.4, 10);
  write(p1, data.orgCountry, 64, 244.5, 10);

  const objet = fitObjectText(data.orgObject, font);
  if (objet.lines[0]) write(p1, objet.lines[0], 72, 256.9, objet.size);
  if (objet.lines[1]) write(p1, objet.lines[1], 34, 267.2, objet.size);

  const cat = ORG_CATEGORY[data.orgCategory];
  if (cat) {
    mark(pages[cat.page], cat.x, cat.y);
  }

  if (data.orgCategory === "oeuvre") {
    const sub = ORG_SUBTYPE[data.orgSubtype];
    if (sub) markRadio(p1, sub.x, sub.y);

    if (data.orgSubtype === "rup") {
      if (data.rupDecreeDate) {
        writeDate(p1, data.rupDecreeDate, 408, 354.6, 364.9, 10);
      }
      if (data.rupJoDate) {
        writeDate(p1, data.rupJoDate, 86, 365.6, 375.9, 10);
      }
    }
    if (data.orgSubtype === "autres" && data.orgAutresPrecisions) {
      write(p1, data.orgAutresPrecisions, 155, 501, 10);
    }
  }

  if (data.orgCategory === "patrimoine" && data.patrimoineAgrement) {
    writeDate(p1, data.patrimoineAgrement, 430, 710, 720, 10);
  }
  if (data.orgCategory === "ue" && data.ueAgrement) {
    writeDate(p2, data.ueAgrement, 502, 187.1, 197.4, 9);
  }

  // --- Page 2: donateur + don ---
  write(p2, data.donorLastName, 68, 250.5, 11);
  write(p2, data.donorFirstName, 358, 254.2, 11);
  write(p2, data.donorStreetNumber, 50, 281.3, 10);
  write(p2, data.donorStreet, 136, 281.3, 10);
  write(p2, data.donorPostal, 98, 295.5, 10);
  write(p2, data.donorCity, 234, 295.5, 10);
  write(p2, data.donorCountry, 68, 310.5, 10);

  write(p2, formatAmount(data.amount), 52, 366, 12, true);
  write(p2, data.amountWords, 355, 363.1, 10);
  writeDate(p2, data.donationDate, 182, 375.6, 385.9, 11);

  if (data.article200) mark(p2, 99.4, 439.6);
  if (data.article978) mark(p2, 290.3, 439.6);

  const formMarks = {
    authentique: [34.0, 476.5],
    seing: [149.8, 476.5],
    manuel: [290.4, 476.5],
    autres: [482.9, 476.5],
  };
  if (formMarks[data.donationForm]) {
    mark(p2, ...formMarks[data.donationForm]);
  }

  const natureMarks = {
    numeraire: [34.0, 513.4],
    titres: [149.8, 513.4],
    abandon: [337.4, 513.4],
    frais: [34.0, 533.4],
    autres: [337.4, 533.4],
  };
  if (natureMarks[data.donationNature]) {
    mark(p2, ...natureMarks[data.donationNature]);
  }
  if (data.donationNature === "autres" && data.natureAutres) {
    write(p2, data.natureAutres, 432, 544.6, 10);
  }

  if (data.donationNature === "numeraire") {
    const payMarks = {
      especes: [34.0, 581.3],
      cheque: [149.8, 581.3],
      virement: [290.4, 581.3],
    };
    if (payMarks[data.paymentMode]) {
      mark(p2, ...payMarks[data.paymentMode]);
    }
  }

  writeDate(p2, data.signatureDate, 310, 631.5, 644.2, 10);

  if (data.signaturePng) {
    const sigImage = await pdf.embedPng(data.signaturePng);
    // Signature box (303–522 × 613–662). Date on the left; drawing fits on the right.
    const maxW = 118;
    const maxH = 38;
    const iw = sigImage.width;
    const ih = sigImage.height;
    const scale = Math.min(maxW / iw, maxH / ih);
    const sigW = iw * scale;
    const sigH = ih * scale;
    const boxRight = 518;
    const boxBottom = 658; // from page top
    p2.drawImage(sigImage, {
      x: boxRight - sigW - 4,
      y: PAGE_H - boxBottom,
      width: sigW,
      height: sigH,
    });
  }

  return pdf.save();
}

function collectFormData() {
  return {
    receiptNumber: form.elements.receiptNumber.value.trim(),
    orgName: form.elements.orgName.value.trim(),
    orgSiren: form.elements.orgSiren.value.trim(),
    orgStreetNumber: form.elements.orgStreetNumber.value.trim(),
    orgStreet: form.elements.orgStreet.value.trim(),
    orgPostal: form.elements.orgPostal.value.trim(),
    orgCity: form.elements.orgCity.value.trim(),
    orgCountry: form.elements.orgCountry.value.trim(),
    orgObject: form.elements.orgObject.value.trim(),
    orgCategory: form.elements.orgCategory.value,
    orgSubtype: form.elements.orgSubtype.value,
    orgAutresPrecisions: form.elements.orgAutresPrecisions?.value.trim() || "",
    rupDecreeDate: "",
    rupJoDate: "",
    patrimoineAgrement: "",
    ueAgrement: "",
    donorLastName: form.elements.donorLastName.value.trim(),
    donorFirstName: form.elements.donorFirstName.value.trim(),
    donorStreetNumber: form.elements.donorStreetNumber.value.trim(),
    donorStreet: form.elements.donorStreet.value.trim(),
    donorPostal: form.elements.donorPostal.value.trim(),
    donorCity: form.elements.donorCity.value.trim(),
    donorCountry: form.elements.donorCountry.value.trim(),
    amount: form.elements.amount.value,
    amountWords: form.elements.amountWords.value.trim(),
    donationDate: form.elements.donationDate.value,
    signatureDate: form.elements.signatureDate.value,
    article200: form.elements.article200.checked,
    article978: form.elements.article978.checked,
    donationForm: form.elements.donationForm.value,
    donationNature: form.elements.donationNature.value,
    natureAutres: form.elements.natureAutres.value.trim(),
    paymentMode: form.elements.paymentMode.value,
    signaturePng: signaturePngBytes(),
  };
}

function downloadBlob(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function authHeaders(extra = {}) {
  const hash = window.AUTH_CONFIG?.passwordHash;
  if (!hash) throw new Error("Configuration d’accès manquante.");
  return {
    Authorization: `Bearer ${hash}`,
    ...extra,
  };
}

async function fetchNextReceiptNumber(year) {
  const qs = year ? `?year=${encodeURIComponent(year)}` : "";
  const res = await fetch(`/api/next-receipt${qs}`, {
    method: "GET",
    credentials: "include",
    headers: authHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      body.error || `Impossible d’obtenir le n° de reçu (${res.status})`
    );
    err.status = res.status;
    err.code = body.code;
    throw err;
  }
  return body.receiptNumber;
}

async function uploadRescritToDrive(bytes, receiptNumber) {
  const res = await fetch("/api/upload-rescrit", {
    method: "POST",
    credentials: "include",
    headers: authHeaders({
      "Content-Type": "application/pdf",
      "X-Receipt-Number": receiptNumber,
    }),
    body: bytes,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Upload Drive échoué (${res.status})`);
    err.status = res.status;
    err.code = body.code;
    err.payload = body;
    throw err;
  }
  return body;
}

async function isGoogleConnected() {
  try {
    const res = await fetch("/api/auth/google/status", { credentials: "include" });
    const body = await res.json().catch(() => ({}));
    return Boolean(res.ok && body.connected);
  } catch {
    return false;
  }
}

async function clearGoogleSession() {
  try {
    await fetch("/api/auth/google/logout", { method: "POST", credentials: "include" });
  } catch (_) {}
}

function connectGoogleViaPopup() {
  return new Promise((resolve, reject) => {
    const width = 520;
    const height = 680;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
    const popup = window.open(
      "/api/auth/google/start",
      "cerfa-google-oauth",
      `popup=yes,width=${width},height=${height},left=${left},top=${top}`
    );

    if (!popup) {
      reject(
        new Error(
          "Autorisez les fenêtres pop-up pour connecter Google Drive, puis réessayez."
        )
      );
      return;
    }

    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(poll);
      try {
        if (!popup.closed) popup.close();
      } catch (_) {}
      if (ok) resolve(true);
      else reject(new Error(error || "Connexion Google annulée."));
    };

    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== "cerfa-google-oauth") return;
      finish(Boolean(event.data.ok), event.data.error);
    };

    window.addEventListener("message", onMessage);

    const poll = setInterval(async () => {
      if (!popup.closed) return;
      const ok = await isGoogleConnected();
      finish(ok, ok ? null : "Connexion Google non terminée.");
    }, 600);
  });
}

async function ensureGoogleConnected({ force } = {}) {
  if (force) await clearGoogleSession();
  if (!force && (await isGoogleConnected())) return true;
  setStatus("Connexion Google Drive…");
  await connectGoogleViaPopup();
  if (!(await isGoogleConnected())) {
    throw new Error("Google Drive n’est pas connecté.");
  }
  return true;
}

function validateBeforeGenerate() {
  if (!form.elements.article200.checked && !form.elements.article978.checked) {
    setStatus("Cochez au moins l’article 200 ou 978 du CGI.", "error");
    return false;
  }
  if (!signatureHasInk) {
    setStatus("Ajoutez une signature dans le cadre avant de générer.", "error");
    return false;
  }
  return true;
}

async function allocateAndBuildPdf() {
  const year = (form.elements.donationDate.value || todayISO()).slice(0, 4);
  setStatus("Attribution du n° de reçu…");
  const receiptNumber = await fetchNextReceiptNumber(year);
  form.elements.receiptNumber.value = receiptNumber;

  syncAmountWords();
  const data = collectFormData();
  setStatus(`Génération du PDF ${receiptNumber}…`);
  const bytes = await fillPdf(data);
  return { receiptNumber, bytes };
}

async function withGoogleDrive(action) {
  await ensureGoogleConnected();
  try {
    return await action();
  } catch (err) {
    if (err.code === "GOOGLE_REAUTH_REQUIRED" || err.code === "GOOGLE_NOT_CONNECTED") {
      setStatus("Reconnectez Google Drive…");
      await ensureGoogleConnected({ force: true });
      return action();
    }
    throw err;
  }
}

async function handleDownloadOnly() {
  if (!validateBeforeGenerate()) return;
  const btn = $("#download-only");
  const other = $("#save-drive");
  btn.disabled = true;
  other.disabled = true;
  try {
    // Téléchargement local : pas besoin de Google ni de n° Drive.
    // N° provisoire local pour le PDF (le n° officiel est attribué à l’enregistrement Drive).
    const year = (form.elements.donationDate.value || todayISO()).slice(0, 4);
    let receiptNumber = form.elements.receiptNumber.value.trim();
    if (!/^DON\d{7}$/i.test(receiptNumber)) {
      const key = `cerfa-local-seq-${year}`;
      const next = Number(localStorage.getItem(key) || "0") + 1;
      localStorage.setItem(key, String(next));
      receiptNumber = `DON${year}${String(next).padStart(3, "0")}`;
      form.elements.receiptNumber.value = receiptNumber;
    }
    syncAmountWords();
    setStatus(`Génération du PDF ${receiptNumber}…`);
    const bytes = await fillPdf(collectFormData());
    downloadBlob(bytes, `${receiptNumber}.pdf`);
    setStatus(
      `PDF téléchargé (${receiptNumber}). Astuce : l’enregistrement Drive attribuera le n° officiel.`,
      "ok"
    );
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Erreur lors du téléchargement.", "error");
  } finally {
    btn.disabled = false;
    other.disabled = false;
  }
}

async function handleSaveDrive() {
  if (!validateBeforeGenerate()) return;
  const btn = $("#save-drive");
  const other = $("#download-only");
  btn.disabled = true;
  other.disabled = true;
  try {
    await withGoogleDrive(async () => {
      let { receiptNumber, bytes } = await allocateAndBuildPdf();
      setStatus(`Envoi vers Google Drive (${receiptNumber})…`);
      try {
        const uploaded = await uploadRescritToDrive(bytes, receiptNumber);
        setStatus(
          `Enregistré sur Drive : ${uploaded.fileName || `${receiptNumber}.pdf`}`,
          "ok"
        );
      } catch (uploadErr) {
        if (uploadErr.status === 409 && uploadErr.payload?.receiptNumber) {
          receiptNumber = uploadErr.payload.receiptNumber;
          form.elements.receiptNumber.value = receiptNumber;
          syncAmountWords();
          bytes = await fillPdf(collectFormData());
          const uploaded = await uploadRescritToDrive(bytes, receiptNumber);
          setStatus(
            `Enregistré sur Drive après renumérotation : ${uploaded.fileName || receiptNumber}.pdf`,
            "ok"
          );
        } else {
          throw uploadErr;
        }
      }
    });
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Erreur lors de l’enregistrement Drive.", "error");
  } finally {
    btn.disabled = false;
    other.disabled = false;
  }
}

/* ---------- Init ---------- */

form.addEventListener("change", updateVisibility);
form.addEventListener("input", (e) => {
  if (e.target === amountInput) syncAmountWords();
});

$("#clear-signature").addEventListener("click", clearSignature);

signatureCanvas.addEventListener("mousedown", startSignature);
signatureCanvas.addEventListener("mousemove", moveSignature);
signatureCanvas.addEventListener("mouseup", endSignature);
signatureCanvas.addEventListener("mouseleave", endSignature);
signatureCanvas.addEventListener("touchstart", startSignature, { passive: false });
signatureCanvas.addEventListener("touchmove", moveSignature, { passive: false });
signatureCanvas.addEventListener("touchend", endSignature);
signatureCanvas.addEventListener("touchcancel", endSignature);

form.addEventListener("submit", (e) => e.preventDefault());
$("#download-only").addEventListener("click", handleDownloadOnly);
$("#save-drive").addEventListener("click", handleSaveDrive);

clearSignature();
updateVisibility();
syncAmountWords();

if (!form.elements.donationDate.value) form.elements.donationDate.value = todayISO();
if (!form.elements.signatureDate.value) form.elements.signatureDate.value = todayISO();
form.elements.receiptNumber.value = "";
