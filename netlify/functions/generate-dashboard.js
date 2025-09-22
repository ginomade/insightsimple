// netlify/functions/generate-dashboard.js
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

function stripCodeFences(s) {
  if (typeof s !== "string") return s;
  return s.replace(/^```[a-zA-Z]*\n?/m, "").replace(/```$/m, "").trim();
}

function cleanseBase64(b64) {
  if (!b64 || typeof b64 !== "string") return b64;
  b64 = b64.replace(/^data:application\/pdf;base64,?/i, "");
  b64 = b64.replace(/\s+/g, "");
  return b64;
}

function looksLikePdf(bytes) {
  if (!bytes || bytes.length < 4) return false;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  try {
    const form = await req.formData();
    const prompt = form.get("prompt") || "Genera un informe en PDF.";
    const file = form.get("file");

    if (!(file && typeof file === "object")) {
      return new Response("Falta el archivo", { status: 400 });
    }

    // Validación servidor: extensión y tamaño
    const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
    const allowed = new Set(["pdf", "xlsx", "xls"]);
    const name = file.name ?? "";
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    if (!allowed.has(ext)) {
      return new Response("Solo se aceptan PDF o Excel (.pdf, .xlsx, .xls).", { status: 400 });
    }
    if (typeof file.size === "number" && file.size > MAX_BYTES) {
      return new Response("Archivo demasiado grande (máximo 20 MB).", { status: 413 });
    }

    // 1) Subir a OpenAI Files API
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

    // 2) Responses API con text.format (json_schema) — name requerido al mismo nivel
    const body = {
      model: "gpt-4.1-mini",
      max_output_tokens: 200000,
      text: {
        format: {
          type: "json_schema",
          name: "pdf_payload",               // <- requerido
          schema: {                          // <- schema directo aquí
            type: "object",
            additionalProperties: false,
            properties: {
              filename: { type: "string" },
              base64: { type: "string", description: "PDF en Base64 sin prefijos ni saltos" }
            },
            required: ["base64"]
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
                `SALIDA OBLIGATORIA: responde SOLO un JSON válido que cumpla el schema (sin markdown, sin backticks). ` +
                `Asegúrate de que el PDF sea válido y esté codificado en Base64 sin prefijos (sin 'data:...') ni saltos de línea.`
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

    // Extraer texto con el JSON y parsearlo
    let out = extractOutputText(json) || "";
    out = stripCodeFences(out);

    let data;
    try { data = JSON.parse(out); }
    catch {
      return new Response("El modelo no devolvió JSON válido con el PDF en base64.", { status: 502 });
    }

    const filename = (typeof data.filename === "string" && data.filename.trim())
      ? data.filename.trim()
      : "InsightSimple-Reporte.pdf";

    let base64 = cleanseBase64(data.base64);
    if (!base64) {
      return new Response("Respuesta sin base64 utilizable.", { status: 502 });
    }

    let bytes;
    try {
      bytes = Buffer.from(base64, "base64");
    } catch {
      return new Response("Base64 inválido recibido del modelo.", { status: 502 });
    }

    if (!looksLikePdf(bytes)) {
      return new Response("El contenido devuelto no parece ser un PDF válido.", { status: 502 });
    }

    return new Response(bytes, {
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
