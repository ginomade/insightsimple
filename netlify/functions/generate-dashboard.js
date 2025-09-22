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

// Afinar Chromium para serverless
chromium.setHeadlessMode = true;
chromium.setGraphicsMode = false;

const OPENAI_URL = "https://api.openai.com/v1";

export default async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (!process.env.OPENAI_API_KEY) {
      console.error("Falta OPENAI_API_KEY");
      return new Response("Misconfig: falta OPENAI_API_KEY", { status: 500 });
    }

    const form = await req.formData();
    const rawPrompt = (form.get("prompt") || "").toString();
    const file = form.get("file");

    if (!(file && typeof file === "object")) {
      return new Response("Falta el archivo", { status: 400 });
    }

    // Validación servidor
    const MAX_BYTES = 20 * 1024 * 1024;
    const allowed = new Set(["pdf", "xlsx", "xls"]);
    const name = file.name ?? "";
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    if (!allowed.has(ext)) return new Response("Solo se aceptan PDF o Excel (.pdf, .xlsx, .xls).", { status: 400 });
    if (typeof file.size === "number" && file.size > MAX_BYTES) return new Response("Archivo demasiado grande (máximo 20 MB).", { status: 413 });

    // Construir prompt (máx 3 páginas)
    const limiter = `
Reglas duras:
- Máximo 3 páginas A4 (ideal: 2–3).
- HTML completo con CSS inline (sin assets remotos).
- Tablas y gráficos como HTML/SVG simples (sin imágenes externas).
- Texto conciso en bullets; evita tablas enormes.
- System fonts, sin webfonts.`;
    const prompt =
      (rawPrompt || `Eres analista de negocio y diseñador. Genera un informe HTML (no PDF) con **máximo 3 páginas A4**: 1) Portada con 3 KPIs, 2) Resumen + KPIs + 1–2 gráficos (SVG/HTML), 3) Insights + próximos pasos.`)
      + "\n\n" + limiter;

    // 1) Subir a Files API
    let fileId = null;
    try {
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
        console.error("Files API error:", t);
        return new Response(`Error subiendo archivo: ${t}`, { status: 500 });
      }
      ({ id: fileId } = await filesResp.json());
    } catch (e) {
      console.error("Files API exception:", e);
      return new Response("No se pudo subir el archivo a OpenAI Files.", { status: 500 });
    }
    if (!fileId) {
      console.error("Sin fileId tras Files API");
      return new Response("No se obtuvo file_id de OpenAI.", { status: 502 });
    }

    // 2) Responses API → pedir {title, html}
    let title = "InsightSimple - Reporte";
    let html = "";
    try {
      const body = {
        model: "gpt-4.1-mini",
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
        console.error("Responses API error:", t);
        return new Response(`Error en Responses API: ${t}`, { status: 500 });
      }
      const json = await resp.json();

      let out = extractOutputText(json) || "";
      out = stripFences(out);

      let data;
      try { data = JSON.parse(out); }
      catch {
        console.error("JSON inválido devuelto por el modelo:", out.slice(0, 4000));
        return new Response("El modelo no devolvió JSON válido con {title, html}.", { status: 502 });
      }

      if (typeof data.title === "string" && data.title.trim()) title = data.title.trim();
      if (typeof data.html === "string") html = data.html.trim();

      if (!html || !html.toLowerCase().includes("</html>")) {
        console.error("HTML incompleto / sin </html>");
        return new Response("El modelo no devolvió un documento HTML completo.", { status: 502 });
      }

      // Guardrail tamaño
      if (html.length > 600_000) {
        html = html.slice(0, 600_000) + "<!-- truncado por tamaño -->";
      }
    } catch (e) {
      console.error("Responses API exception:", e);
      // Fallback: generamos un HTML mínimo para no romper (el usuario al menos descarga algo)
      html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,Segoe UI,Arial;margin:24px} h1{margin:0 0 8px} .muted{color:#666}</style>
</head><body>
<h1>${title}</h1>
<p class="muted">No se pudo generar el informe con IA en este intento. Probá de nuevo o usa un archivo más liviano.</p>
</body></html>`;
    }

    // 3) Render HTML → PDF
    let exePath = null;
    try {
      exePath = await chromium.executablePath();
    } catch (e) {
      console.error("chromium.executablePath() fallo:", e);
    }
    if (!exePath) {
      console.error("Chromium executablePath no disponible");
      return new Response("Chromium no inicializó en el entorno de Functions.", { status: 500 });
    }

    let pdfBytes;
    try {
      const browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
        executablePath: exePath,
        headless: chromium.headless,
      });

      try {
        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(9000);
        page.setDefaultTimeout(9000);

        await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 9000 });
        pdfBytes = await page.pdf({
          format: "A4",
          printBackground: true,
          margin: { top: "12mm", right: "10mm", bottom: "14mm", left: "10mm" },
          timeout: 9000,
        });
        await page.close();
      } finally {
        await browser.close();
      }
    } catch (e) {
      console.error("Puppeteer/Chromium exception:", e);
      return new Response("Fallo al renderizar el PDF en servidor.", { status: 500 });
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
    console.error("Error no controlado:", e);
    return new Response("Error interno en generate-dashboard", { status: 500 });
  }
};
