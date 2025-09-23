// netlify/functions/generate-dashboard.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const OPENAI_URL = "https://api.openai.com/v1";

/* ============================================================
   Utilidades robustas para extraer y parsear la salida del modelo
   ============================================================ */

// Extrae cualquier output_text de la Responses API
function extractOutputText(json) {
  const texts = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === "object") {
      if (node.type === "output_text" && typeof node.text === "string") texts.push(node.text);
      if (node.type === "message" && Array.isArray(node.content)) {
        node.content.forEach((c) => {
          if (c.type === "output_text" && typeof c.text === "string") texts.push(c.text);
        });
      }
      for (const k in node) walk(node[k]);
    }
  };
  walk(json.output);
  return texts.join("");
}

// Quita fences de markdown (```json ... ```)
function stripFences(s) {
  if (typeof s !== "string") return s;
  return s.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
}

// Normaliza comillas “curvas” y espacios raros, aplana saltos de línea dentro de strings
function normalizeWhitespaceAndQuotes(s) {
  return s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\r\n?/g, "\n")   // CRLF → LF
    .replace(/\n+/g, " ")      // JSON no admite \n sueltos dentro de strings
    .replace(/\u00A0/g, " ")   // nbsp → espacio
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Extrae el PRIMER objeto JSON top-level, ignorando llaves dentro de strings
function extractFirstTopLevelObjectBlock(s) {
  let inStr = false, esc = false, depth = 0, start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    } else {
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && start !== -1) {
          return s.slice(start, i + 1);
        }
      }
    }
  }
  return null;
}

function removeTrailingCommas(s) {
  return s.replace(/,\s*([}\]])/g, "$1").replace(/:\s*,/g, ":");
}

function quoteBareKeys(s) {
  // { foo: 1 } -> { "foo": 1 }
  return s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
}

// Parser tolerante para JSON “a pelo” del modelo
function parseJsonLoose(raw) {
  if (!raw) throw new Error("empty");
  let s = stripFences(raw);
  s = normalizeWhitespaceAndQuotes(s);

  // si hay varios objetos pegados, quedarnos con el primero balanceado
  let block = extractFirstTopLevelObjectBlock(s) || s;

  const attempts = [
    (x) => JSON.parse(x),
    (x) => JSON.parse(removeTrailingCommas(x)),
    (x) => JSON.parse(quoteBareKeys(removeTrailingCommas(x))),
  ];

  for (const tryParse of attempts) {
    try { return tryParse(block); } catch (_) {}
  }

  // último intento: aplicar fixes sobre el string completo
  const alt = extractFirstTopLevelObjectBlock(quoteBareKeys(removeTrailingCommas(s))) || s;
  for (const tryParse of attempts) {
    try { return tryParse(alt); } catch (_) {}
  }

  throw new Error("invalid_json_after_cleanup");
}

/* ============================================================
   Render de PDF con paleta clara y alto contraste
   ============================================================ */

// Paleta clara alto-contraste
const COLOR_BG = rgb(1, 1, 1);                   // fondo blanco (implícito)
const COLOR_TITLE = rgb(0.05, 0.06, 0.10);       // títulos casi negro
const COLOR_TEXT = rgb(0.12, 0.14, 0.18);        // texto principal
const COLOR_MUTED = rgb(0.32, 0.36, 0.44);       // texto secundario
const COLOR_H2 = rgb(0.08, 0.10, 0.16);          // subtítulos
const COLOR_KPI_BOX = rgb(0.96, 0.97, 0.98);     // relleno KPI
const COLOR_KPI_BORDER = rgb(0.72, 0.76, 0.84);  // borde KPI
const COLOR_KPI_LABEL = COLOR_MUTED;
const COLOR_KPI_VALUE = rgb(0.10, 0.12, 0.18);   // valor KPI
const COLOR_ACCENT = rgb(0.07, 0.33, 0.73);      // opcional para separadores

// Métricas tipográficas (ligero boost legibilidad)
const TITLE_SIZE = 24;
const H2 = 15;
const TEXT = 11.5;
const LINE = 15;

/* ============================================================
   Handler Netlify Function
   ============================================================ */
export default async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (!process.env.OPENAI_API_KEY) return new Response("Misconfig: falta OPENAI_API_KEY", { status: 500 });

    const form = await req.formData();
    const rawPrompt = (form.get("prompt") || "").toString();
    const file = form.get("file");
    if (!(file && typeof file === "object")) return new Response("Falta el archivo", { status: 400 });

    // Validación servidor
    const MAX_BYTES = 20 * 1024 * 1024;
    const allowed = new Set(["pdf", "xlsx", "xls"]);
    const name = file.name ?? "";
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    if (!allowed.has(ext)) return new Response("Solo se aceptan PDF o Excel (.pdf, .xlsx, .xls).", { status: 400 });
    if (typeof file.size === "number" && file.size > MAX_BYTES) return new Response("Archivo demasiado grande (máximo 20 MB).", { status: 413 });

    // Prompt: pedimos JSON estructurado (no HTML ni binarios)
    const limiter = `
Responde SOLO JSON válido con esta forma EXACTA (sin markdown):
{
  "title": "string",
  "executive_summary": "string (3-6 líneas)",
  "kpis": [{"label": "string", "value": "string"}],
  "insights": ["bullet", "..."],
  "recommendations": ["bullet", "..."]
}
Las secciones deben ser concisas: el PDF final tendrá máximo 3 páginas A4.`;

    const prompt =
      (rawPrompt || `Eres analista de negocio. Sintetiza el documento en estructura para un reporte corto.`) +
      "\n\n" + limiter;

    // 1) Subir a Files API
    let fileId = null;
    {
      const uploadForm = new FormData();
      uploadForm.append("file", file);
      uploadForm.append("purpose", "user_data");
      const filesResp = await fetch(`${OPENAI_URL}/files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: uploadForm,
      });
      if (!filesResp.ok) {
        const t = await filesResp.text();
        return new Response(`Error subiendo archivo: ${t}`, { status: 500 });
      }
      ({ id: fileId } = await filesResp.json());
      if (!fileId) return new Response("No se obtuvo file_id de OpenAI.", { status: 502 });
    }

    // 2) Responses API (sin text.format) → pedimos JSON “a pelo”
    const body = {
      model: "gpt-4.1-mini",
      max_output_tokens: 2200, // acotado para rapidez
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_file", file_id: fileId },
          ],
        },
      ],
    };

    const resp = await fetch(`${OPENAI_URL}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const t = await resp.text();
      return new Response(`Error en Responses API: ${t}`, { status: 500 });
    }
    const json = await resp.json();

    // 3) Parseo tolerante del JSON
    let rawOut = extractOutputText(json);
    let data;
    try {
      data = parseJsonLoose(rawOut);
    } catch {
      // fallback mínimo para no romper
      data = {
        title: "InsightSimple — Reporte",
        executive_summary: "No se pudo parsear JSON válido en este intento. Reintentá la generación.",
        kpis: [],
        insights: [],
        recommendations: []
      };
    }

    // 4) Componer PDF (≤ 3 páginas) con pdf-lib y paleta clara
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const PAGE_W = 595.28;   // A4 width pt
    const PAGE_H = 841.89;   // A4 height pt
    const M = 42;            // margin

    const addPage = () => pdfDoc.addPage([PAGE_W, PAGE_H]);

    const title = (data.title || "InsightSimple — Reporte").toString().trim();
    const summary = (data.executive_summary || "").toString().trim();
    const kpis = Array.isArray(data.kpis) ? data.kpis.slice(0, 6) : [];
    const insights = Array.isArray(data.insights) ? data.insights.slice(0, 8) : [];
    const recs = Array.isArray(data.recommendations) ? data.recommendations.slice(0, 8) : [];

    // Página 1 — Portada + KPIs
    let page = addPage();
    let y = PAGE_H - M;

    page.drawText(title, { x: M, y: y - TITLE_SIZE, size: TITLE_SIZE, font: fontBold, color: COLOR_TITLE });
    y -= (TITLE_SIZE + 14);

    const dateStr = new Date().toLocaleDateString("es-AR");
    page.drawText(`Fecha: ${dateStr}`, { x: M, y: y - TEXT, size: TEXT, font, color: COLOR_MUTED });
    y -= (TEXT + 18);

    page.drawText("KPIs estrella", { x: M, y: y - H2, size: H2, font: fontBold, color: COLOR_H2 });
    y -= (H2 + 10);

    const kpiCols = 2;
    const kpiBoxW = (PAGE_W - 2*M - 16) / kpiCols;
    const kpiBoxH = 48;

    (kpis.length ? kpis : [{label:"Métrica", value:"N/A"}]).slice(0, 4).forEach((kpi, i) => {
      const row = Math.floor(i / kpiCols);
      const col = i % kpiCols;
      const x = M + col * (kpiBoxW + 16);
      const boxY = y - row * (kpiBoxH + 12);

      page.drawRectangle({
        x, y: boxY - kpiBoxH, width: kpiBoxW, height: kpiBoxH,
        color: COLOR_KPI_BOX, borderColor: COLOR_KPI_BORDER, borderWidth: 0.8
      });

      page.drawText((kpi.label ?? "").toString(), { x: x + 10, y: boxY - 18, size: TEXT, font, color: COLOR_KPI_LABEL });
      page.drawText((kpi.value ?? "").toString(), { x: x + 10, y: boxY - 34, size: TEXT + 2.5, font: fontBold, color: COLOR_KPI_VALUE });

      if (i === 3) y = boxY - kpiBoxH - 16;
    });
    if (kpis.length <= 2) y -= 60;

    // Página 2 — Resumen + Insights
    page = addPage();
    y = PAGE_H - M;

    page.drawText("Resumen ejecutivo", { x: M, y: y - H2, size: H2, font: fontBold, color: COLOR_H2 });
    y -= (H2 + 12);

    wrapText(summary || "Sin resumen disponible.", 90).forEach(line => {
      page.drawText(line, { x: M, y: y - TEXT, size: TEXT, font, color: COLOR_TEXT });
      y -= LINE;
    });
    y -= 10;

    page.drawText("Insights", { x: M, y: y - H2, size: H2, font: fontBold, color: COLOR_H2 });
    y -= (H2 + 8);

    (insights.length ? insights : ["Sin insights disponibles."]).forEach(b => {
      if (y < M + 40) return;
      const lines = wrapText("• " + b, 95);
      lines.forEach(line => {
        if (y < M + 40) return;
        page.drawText(line, { x: M, y: y - TEXT, size: TEXT, font, color: COLOR_TEXT });
        y -= LINE;
      });
    });

    // Página 3 — Recomendaciones
    page = addPage();
    y = PAGE_H - M;

    page.drawText("Recomendaciones", { x: M, y: y - H2, size: H2, font: fontBold, color: COLOR_H2 });
    y -= (H2 + 10);

    (recs.length ? recs : ["Sin recomendaciones disponibles."]).forEach(b => {
      if (y < M + 40) return;
      const lines = wrapText("• " + b, 95);
      lines.forEach(line => {
        if (y < M + 40) return; // no crear más páginas: límite 3
        page.drawText(line, { x: M, y: y - TEXT, size: TEXT, font, color: COLOR_TEXT });
        y -= LINE;
      });
    });

    const bytes = await pdfDoc.save();
    const safe = title.replace(/[^a-z0-9\-_. ]/gi, "").replace(/\s+/g, "-");
    const filename = `${safe || "InsightSimple-Reporte"}.pdf`;

    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    console.error("Error interno:", e);
    return new Response("Error interno en generate-dashboard", { status: 500 });
  }
};

// Helper: wrapText reutilizado aquí para mantener cohesión
function wrapText(text, maxChars) {
  const words = (text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const probe = line ? line + " " + w : w;
    if (probe.length > maxChars) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = probe;
    }
  }
  if (line) lines.push(line);
  return lines;
}
