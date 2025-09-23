// netlify/functions/generate-dashboard.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const OPENAI_URL = "https://api.openai.com/v1";

// -------- utilidades de extracción / saneado ----------
// --- utilidades robustas para parsear la salida del modelo ---

function extractOutputText(json) {
  const texts = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === "object") {
      if (node.type === "output_text" && typeof node.text === "string") texts.push(node.text);
      if (node.type === "message" && Array.isArray(node.content)) {
        node.content.forEach((c) => { if (c.type === "output_text" && typeof c.text === "string") texts.push(c.text); });
      }
      for (const k in node) walk(node[k]);
    }
  };
  walk(json.output);
  return texts.join("");
}

function stripFences(s) {
  if (typeof s !== "string") return s;
  // quita ```json ... ``` o ```
  return s.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
}

// Extrae el PRIMER objeto JSON top-level, incluso si hay varios pegados.
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
  // ", }" o ", ]" → quitamos la coma
  return s.replace(/,\s*([}\]])/g, "$1").replace(/:\s*,/g, ":");
}

function quoteBareKeys(s) {
  // Añade comillas a claves simples no entrecomilladas: { foo: 1 } -> { "foo": 1 }
  // (Heurístico; asume que no estamos dentro de strings gracias al escáner previo)
  return s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
}

function normalizeWhitespaceAndQuotes(s) {
  return s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\r\n?/g, "\n")   // normaliza CRLF
    .replace(/\n+/g, " ")      // JSON no admite \n crudos dentro de strings → espacios
    .replace(/\u00A0/g, " ")   // nbsp → espacio
    .replace(/\s{2,}/g, " ")   // colapsar espacios
    .trim();
}

function parseJsonLoose(raw) {
  if (!raw) throw new Error("empty");
  // 1) limpieza básica
  let s = stripFences(raw);
  s = normalizeWhitespaceAndQuotes(s);

  // 2) si la salida trae 2+ objetos pegados, agarramos el primero bien balanceado
  let block = extractFirstTopLevelObjectBlock(s) || s;

  // 3) intentos de parseo progresivos
  const attempts = [
    (x) => JSON.parse(x),
    (x) => JSON.parse(removeTrailingCommas(x)),
    (x) => JSON.parse(quoteBareKeys(removeTrailingCommas(x))),
  ];

  for (const tryParse of attempts) {
    try { return tryParse(block); } catch (_) {}
  }

  // 4) si aún falla y el bloque detectado es muy chico, intentamos con el global "s" entero
  if (block.length < 50) {
    const alt = extractFirstTopLevelObjectBlock(quoteBareKeys(removeTrailingCommas(s))) || s;
    for (const tryParse of attempts) {
      try { return tryParse(alt); } catch (_) {}
    }
  }

  // Nada funcionó
  throw new Error("invalid_json_after_cleanup");
}


function normalizeQuotes(s) {
  if (typeof s !== "string") return s;
  // comillas “inteligentes” → ASCII
  return s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

function findLikelyJsonBlock(s) {
  // busca el primer { ... } grande que parezca JSON
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return s.slice(first, last + 1);
}

// -------- PDF helpers ----------
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

// -------- handler ----------
export default async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (!process.env.OPENAI_API_KEY) return new Response("Misconfig: falta OPENAI_API_KEY", { status: 500 });

    const form = await req.formData();
    const rawPrompt = (form.get("prompt") || "").toString();
    const file = form.get("file");
    if (!(file && typeof file === "object")) return new Response("Falta el archivo", { status: 400 });

    // validación servidor
    const MAX_BYTES = 20 * 1024 * 1024;
    const allowed = new Set(["pdf", "xlsx", "xls"]);
    const name = file.name ?? "";
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    if (!allowed.has(ext)) return new Response("Solo se aceptan PDF o Excel (.pdf, .xlsx, .xls).", { status: 400 });
    if (typeof file.size === "number" && file.size > MAX_BYTES) return new Response("Archivo demasiado grande (máximo 20 MB).", { status: 413 });

    // prompt: pedimos JSON estructurado (no HTML ni binarios)
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

    // 1) subir a Files API
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

    // 3) parseo tolerante del JSON
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

    // normalizar campos
    const title = (data.title || "InsightSimple — Reporte").toString().trim();
    const summary = rawOut; //(data.executive_summary || "").toString().trim();
    const kpis = Array.isArray(data.kpis) ? data.kpis.slice(0, 6) : [];
    const insights = Array.isArray(data.insights) ? data.insights.slice(0, 8) : [];
    const recs = Array.isArray(data.recommendations) ? data.recommendations.slice(0, 8) : [];

    // 4) Componer PDF (≤ 3 páginas) con pdf-lib
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const PAGE_W = 595.28, PAGE_H = 841.89, M = 42, LINE = 14;
    const TITLE_SIZE = 22, H2 = 14, TEXT = 11;
    const GRAY = rgb(0.35, 0.40, 0.55);

    const addPage = () => pdfDoc.addPage([PAGE_W, PAGE_H]);

    // Pag 1 — Portada + KPIs
    let page = addPage();
    let y = PAGE_H - M;
    page.drawText(title, { x: M, y: y - TITLE_SIZE, size: TITLE_SIZE, font: fontBold, color: rgb(0.93, 0.95, 0.98) });
    y -= (TITLE_SIZE + 14);
    const dateStr = new Date().toLocaleDateString("es-AR");
    page.drawText(`Fecha: ${dateStr}`, { x: M, y: y - TEXT, size: TEXT, font, color: GRAY });
    y -= (TEXT + 18);

    page.drawText("KPIs estrella", { x: M, y: y - H2, size: H2, font: fontBold, color: rgb(0.85, 0.88, 1) });
    y -= (H2 + 10);
    const kpiCols = 2, kpiBoxW = (PAGE_W - 2*M - 16) / kpiCols, kpiBoxH = 48;
    (kpis.length ? kpis : [{label:"Métrica", value:"N/A"}]).slice(0, 4).forEach((kpi, i) => {
      const row = Math.floor(i / kpiCols);
      const col = i % kpiCols;
      const x = M + col * (kpiBoxW + 16);
      const boxY = y - row * (kpiBoxH + 12);
      page.drawRectangle({ x, y: boxY - kpiBoxH, width: kpiBoxW, height: kpiBoxH, color: rgb(0.08,0.11,0.20), borderColor: GRAY, borderWidth: 0.5, opacity: 0.9 });
      page.drawText((kpi.label ?? "").toString(), { x: x + 10, y: boxY - 18, size: TEXT, font, color: GRAY });
      page.drawText((kpi.value ?? "").toString(), { x: x + 10, y: boxY - 34, size: TEXT+3, font: fontBold, color: rgb(0.95,0.97,1) });
      if (i === 3) y = boxY - kpiBoxH - 16;
    });
    if (kpis.length <= 2) y -= 60;

    // Pag 2 — Resumen + Insights
    page = addPage();
    y = PAGE_H - M;
    page.drawText("Resumen ejecutivo", { x: M, y: y - H2, size: H2, font: fontBold, color: rgb(0.85, 0.88, 1) });
    y -= (H2 + 12);
    wrapText(summary || "Sin resumen disponible.", 90).forEach(line => {
      page.drawText(line, { x: M, y: y - TEXT, size: TEXT, font, color: rgb(0.92,0.94,0.98) });
      y -= LINE;
    });
    y -= 10;

    page.drawText("Insights", { x: M, y: y - H2, size: H2, font: fontBold, color: rgb(0.85, 0.88, 1) });
    y -= (H2 + 8);
    (insights.length ? insights : ["Sin insights disponibles."]).forEach(b => {
      if (y < M + 40) return;
      const lines = wrapText("• " + b, 95);
      lines.forEach(line => {
        if (y < M + 40) return;
        page.drawText(line, { x: M, y: y - TEXT, size: TEXT, font, color: rgb(0.92,0.94,0.98) });
        y -= LINE;
      });
    });

    // Pag 3 — Recomendaciones
    page = addPage();
    y = PAGE_H - M;
    page.drawText("Recomendaciones", { x: M, y: y - H2, size: H2, font: fontBold, color: rgb(0.85, 0.88, 1) });
    y -= (H2 + 10);
    (recs.length ? recs : ["Sin recomendaciones disponibles."]).forEach(b => {
      if (y < M + 40) return;
      const lines = wrapText("• " + b, 95);
      lines.forEach(line => {
        if (y < M + 40) return;
        page.drawText(line, { x: M, y: y - TEXT, size: TEXT, font, color: rgb(0.92,0.94,0.98) });
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
