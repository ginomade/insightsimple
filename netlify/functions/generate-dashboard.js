// netlify/functions/generate-dashboard.js
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

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
  return s.replace(/^```[a-zA-Z]*\n?/m, "").replace(/```$/m, "").trim();
}

const TIME_BUDGET_MS = 23000;           // presupuestamos < 23s totales (para planes con ~26s de límite)
const OPENAI_TIMEOUT_MS = 10000;        // 10s para OpenAI
const PUPPETEER_TIMEOUT_MS = 9000;      // 9s para render PDF

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const start = Date.now();
  const timeLeft = () => Math.max(0, TIME_BUDGET_MS - (Date.now() - start));
  const abortIn = (ms) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort("timeout"), ms);
    return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
  };

  try {
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

    // Prompt compacto para ≤3 páginas y HTML liviano
    const limiter = `
Reglas duras:
- Máximo 3 páginas A4 (ideal: 2–3).
- HTML completo con CSS inline (sin assets remotos).
- Tablas y gráficos como HTML/SVG simples (sin imágenes externas).
- Texto conciso en bullets; evita tablas enormes.
- Nada de fuentes web; usa system fonts.
- No incluyas recursos que requieran red.`;

    const prompt =
      (rawPrompt || `Eres analista de negocio y diseñador. Genera un informe HTML (no PDF) con **máximo 3 páginas A4**: 1) Portada con 3 KPIs, 2) Resumen + KPIs + 1–2 gráficos (SVG/HTML), 3) Insights + próximos pasos.`)
      + "\n\n" + limiter;

    // 1) Subir a Files API
    {
      const uploadForm = new FormData();
      uploadForm.append("file", file);
      uploadForm.append("purpose", "user_data");

      const { signal, cancel } = abortIn(Math.min(4000, timeLeft())); // subir rápido (4s máx)
      const filesResp = await fetch("https://api.openai.com/v1/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: uploadForm,
        signal,
      }).catch((e) => { throw new Error("No se pudo subir el archivo a OpenAI Files."); });
      cancel();
      if (!filesResp?.ok) {
        const t = await filesResp.text().catch(() => "");
        return new Response(`Error subiendo archivo: ${t}`, { status: 500 });
      }
      var { id: fileId } = await filesResp.json();
      if (!fileId) return new Response("No se obtuvo file_id de OpenAI.", { status: 502 });
    }

    // 2) Pedir HTML (no binario) con json_schema mínimo
    const body = {
      model: "gpt-4.1-mini",
      // tokens razonables para no inflar tiempos ni tamaño
      max_output_tokens: 6000,
      text: {
        format: {
          type: "json_schema",
          name: "report_html_payload",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              html:  { type: "string", description: "Documento HTML completo (<!DOCTYPE html> ... </html>)" }
            },
            required: ["title", "html"]
          }
        }
      },
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

    const { signal, cancel } = abortIn(Math.min(OPENAI_TIMEOUT_MS, timeLeft()));
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    }).catch((e) => { throw new Error("Timeout pidiendo el HTML al modelo."); });
    cancel();
    if (!resp?.ok) {
      const t = await resp.text().catch(() => "");
      return new Response(`Error en Responses API: ${t}`, { status: 500 });
    }
    const json = await resp.json();

    let out = extractOutputText(json) || "";
    out = stripFences(out);
    let data;
    try { data = JSON.parse(out); } catch { return new Response("El modelo no devolvió JSON válido con {title, html}.", { status: 502 }); }
    const title = (data.title && typeof data.title === "string") ? data.title.trim() : "InsightSimple - Reporte";
    let html  = (data.html  && typeof data.html  === "string") ? data.html.trim()  : "";
    if (!html || !html.toLowerCase().includes("</html>")) {
      return new Response("El modelo no devolvió un documento HTML completo.", { status: 502 });
    }

    // Pequeño guardrail para tamaño: recortar si el HTML explota
    if (html.length > 600_000) { // ~600 KB de HTML ya es mucho
      html = html.slice(0, 600_000) + "<!-- truncado por tamaño -->";
    }

    // 3) Renderizar HTML -> PDF lo más rápido posible
    const exePath = await chromium.executablePath();
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
      executablePath: exePath,
      headless: chromium.headless,
    });

    let pdfBytes;
    try {
      const page = await browser.newPage();
      // Evitar esperas largas de red (no debería haber assets externos)
      page.setDefaultNavigationTimeout(PUPPETEER_TIMEOUT_MS);
      page.setDefaultTimeout(PUPPETEER_TIMEOUT_MS);

      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: PUPPETEER_TIMEOUT_MS });
      // Forzar A4 y background
      pdfBytes = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "12mm", right: "10mm", bottom: "14mm", left: "10mm" },
        timeout: PUPPETEER_TIMEOUT_MS,
      });

      await page.close();
    } finally {
      await browser.close();
    }

    const safe = title.replace(/[^a-z0-9\-_. ]/gi, "").replace(/\s+/g, "-");
    const filename = `${safe || "InsightSimple-Reporte"}.pdf`;

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    // Si llegamos acá y se pasó el tiempo, devolvemos 504 entendible
    const left = timeLeft();
    if (left <= 0 || (e && (""+e).includes("timeout"))) {
      return new Response("La generación se quedó sin tiempo (504). Probá con un archivo más liviano o reintentá.", { status: 504 });
    }
    console.error(e);
    return new Response("Error interno en generate-dashboard", { status: 500 });
  }
};
