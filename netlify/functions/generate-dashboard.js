// netlify/functions/generate-dashboard.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

function extractOutputText(json) {
  const texts = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === "object") {
      if (node.type === "output_text" && typeof node.text === "string") {
        texts.push(node.text);
      }
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

function stripFences(s) {
  if (typeof s !== "string") return s;
  return s.replace(/^```[a-zA-Z]*\n?/m, "").replace(/```$/m, "").trim();
}

const OPENAI_URL = "https://api.openai.com/v1";

// Simple wrapped text into lines by width
function wrapText(text, maxChars) {
  const words = (text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars) {
      if (line) lines.push(line.trim());
      line = w;
    } else {
      line = (line ? line + " " : "") + w;
    }
  }
  if (line) lines.push(line.trim());
  return lines;
}

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

    // Prompt compacto: pedimos JSON estructurado (no HTML ni binarios)
    const limiter = `
Requisitos estrictos:
- Responde SOLO JSON válido con las claves solicitadas (sin markdown, sin código).
- Máximo 3 páginas A4 en el PDF final, así que mantén el contenido conciso.
- KPIs: como pares label + value.
- Insights y recomendaciones: bullets cortos, accionables.`;

    const prompt =
      (rawPrompt || `Eres analista de negocio. sintetiza el documento en estructura para un reporte corto.`) +
      `\n\n` + limiter +
      `\n\nDevuelve JSON con esta forma EXACTA:\n` +
      `{\n  "title": "string",\n  "executive_summary": "string (3-6 líneas)",\n  "kpis": [{"label": "string", "value": "string"}],\n  "insights": ["bullet", ...],\n  "recommendations": ["bullet", ...]\n}`;

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

    // 2) Responses API → JSON estructurado
    const body = {
      model: "gpt-4.1-mini",
      max_output_tokens: 3000, // rápido
      text: {
        format: {
          type: "json_schema",
          name: "report_struct_payload",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              executive_summary: { type: "string" },
              kpis: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: { label: { type: "string" }, value: { type: "string" } },
                  required: ["label", "value"]
                }
              },
              insights: { type: "array", items: { type: "string" } },
              recommendations: { type: "array", items: { type: "string" } }
            },
            required: ["title", "executive_summary", "kpis", "insights", "recommendations"]
          }
        }
      },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_file", file_id: fileId }
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

    let out = extractOutputText(json) || "";
    out = stripFences(out);

    let data;
    try { data = JSON.parse(out); }
    catch {
      return new Response("El modelo no devolvió JSON válido.", { status: 502 });
    }

    // Normalizar campos
    const title = (data.title || "InsightSimple — Reporte").toString().trim();
    const summary = (data.executive_summary || "").toString().trim();
    const kpis = Array.isArray(data.kpis) ? data.kpis.slice(0, 6) : [];
    const insights = Array.isArray(data.insights) ? data.insights.slice(0, 8) : [];
    const recs = Array.isArray(data.recommendations) ? data.recommendations.slice(0, 8) : [];

    // 3) Componer PDF (≤ 3 páginas) con pdf-lib
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const PAGE_W = 595.28;   // A4 width pt
    const PAGE_H = 841.89;   // A4 height pt
    const M = 42;            // margin
    const LINE = 14;         // leading
    const TITLE_SIZE = 22;
    const H2 = 14;
    const TEXT = 11;
    const GRAY = rgb(0.35, 0.40, 0.55);

    const addPage = () => pdfDoc.addPage([PAGE_W, PAGE_H]);

    // Page 1 — portada + KPIs
    let page = addPage();
    let y = PAGE_H - M;
    page.drawText(title, { x: M, y: y - TITLE_SIZE, size: TITLE_SIZE, font: fontBold, color: rgb(0.93, 0.95, 0.98) });
    y -= (TITLE_SIZE + 14);

    const dateStr = new Date().toLocaleDateString("es-AR");
    page.drawText(`Fecha: ${dateStr}`, { x: M, y: y - TEXT, size: TEXT, font, color: GRAY });
    y -= (TEXT + 18);

    page.drawText("KPIs estrella", { x: M, y: y - H2, size: H2, font: fontBold, color: rgb(0.85, 0.88, 1) });
    y -= (H2 + 10);
    const kpiCols = 2;
    const kpiBoxW = (PAGE_W - 2*M - 16) / kpiCols;
    const kpiBoxH = 48;

    (kpis.length ? kpis : [{label:"Métrica", value:"N/A"}]).slice(0, 4).forEach((kpi, i) => {
      const row = Math.floor(i / kpiCols);
      const col = i % kpiCols;
      const x = M + col * (kpiBoxW + 16);
      const boxY = y - row * (kpiBoxH + 12);
      page.drawRectangle({ x, y: boxY - kpiBoxH, width: kpiBoxW, height: kpiBoxH, color: rgb(0.08,0.11,0.20), borderColor: GRAY, borderWidth: 0.5, opacity: 0.9 });
      page.drawText(kpi.label?.toString() || "", { x: x + 10, y: boxY - 18, size: TEXT, font, color: GRAY });
      page.drawText(kpi.value?.toString() || "", { x: x + 10, y: boxY - 34, size: TEXT+3, font: fontBold, color: rgb(0.95,0.97,1) });
      if (i === 3) y = boxY - kpiBoxH - 16;
    });
    if (kpis.length <= 2) y -= 60; // espacio si pocos KPIs

    // Page 2 — Resumen + Insights
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
      const lines = wrapText("• " + b, 95);
      lines.forEach(line => {
        page.drawText(line, { x: M, y: y - TEXT, size: TEXT, font, color: rgb(0.92,0.94,0.98) });
        y -= LINE;
      });
    });

    // Page 3 — Recomendaciones
    page = addPage();
    y = PAGE_H - M;
    page.drawText("Recomendaciones", { x: M, y: y - H2, size: H2, font: fontBold, color: rgb(0.85, 0.88, 1) });
    y -= (H2 + 10);
    (recs.length ? recs : ["Sin recomendaciones disponibles."]).forEach(b => {
      const lines = wrapText("• " + b, 95);
      lines.forEach(line => {
        if (y < M + 40) return; // no crear más páginas: límite 3
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
