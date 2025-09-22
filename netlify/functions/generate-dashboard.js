// netlify/functions/generate-dashboard.js
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

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

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const form = await req.formData();
    const prompt = form.get("prompt") || "Genera un informe HTML.";
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

    // 1) Subir a Files API
    const uploadForm = new FormData();
    uploadForm.append("file", file);
    uploadForm.append("purpose", "user_data");

    const filesResp = await fetch("https://api.openai.com/v1/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: uploadForm,
    });
    if (!filesResp.ok) {
      const t = await filesResp.text();
      return new Response(`Error subiendo archivo: ${t}`, { status: 500 });
    }
    const { id: fileId } = await filesResp.json();

    // 2) Pedir HTML estricto (no PDF) usando text.format con json_schema
    const body = {
      model: "gpt-4.1-mini",
      max_output_tokens: 200000,
      text: {
        format: {
          type: "json_schema",
          name: "report_html_payload",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string", description: "Título del informe" },
              html:  { type: "string", description: "Documento HTML completo (<!DOCTYPE html> ... </html>)" }
            },
            required: ["html", "title"]
          }
        }
      },
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `${prompt}\n\n` +
                `**FORMATO DE SALIDA**: Responde SOLO un JSON que cumpla el schema con "title" y "html". ` +
                `El campo "html" DEBE ser un documento HTML completo, no mas de 3 páginas, con estilos inline (sin assets externos), ` +
                `incluyendo portada, resumen ejecutivo, KPIs (tablas), 2-3 gráficos como SVG/HTML (no imágenes remotas), ` +
                `insights y recomendaciones, y página final con próximos pasos. ` +
                `El HTML debe ser apto para impresión A4 (usa CSS @page si querés). Idioma: español.`
            },
            { type: "input_file", file_id: fileId },
          ],
        },
      ],
    };

    const resp = await fetch("https://api.openai.com/v1/responses", {
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

    // 3) Extraer y validar JSON con { title, html }
    let out = extractOutputText(json) || "";
    out = stripFences(out);

    let data;
    try { data = JSON.parse(out); }
    catch {
      return new Response("El modelo no devolvió JSON válido con {title, html}.", { status: 502 });
    }
    const title = (data.title && typeof data.title === "string") ? data.title.trim() : "InsightSimple - Reporte";
    const html  = (data.html  && typeof data.html  === "string") ? data.html.trim()  : "";

    if (!html || !html.toLowerCase().includes("</html>")) {
      return new Response("El modelo no devolvió un documento HTML completo.", { status: 502 });
    }

    // 4) Renderizar HTML -> PDF con puppeteer-core + @sparticuz/chromium
    const exePath = await chromium.executablePath();

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: exePath,
      headless: chromium.headless,
    });

    let pdfBytes;
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: ["load", "domcontentloaded", "networkidle0"] });
      pdfBytes = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "14mm", right: "12mm", bottom: "16mm", left: "12mm" }
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
    console.error(e);
    return new Response("Error interno en generate-dashboard", { status: 500 });
  }
};
