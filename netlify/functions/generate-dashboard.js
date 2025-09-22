// netlify/functions/generate-dashboard.js
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

    // Validación: extensión y tamaño
    const MAX_BYTES = 20 * 1024 * 1024;
    const allowed = new Set(["pdf", "xlsx", "xls"]);
    const name = file.name ?? "";
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    if (!allowed.has(ext)) return new Response("Solo se aceptan PDF o Excel (.pdf, .xlsx, .xls).", { status: 400 });
    if (typeof file.size === "number" && file.size > MAX_BYTES) return new Response("Archivo demasiado grande (máximo 20 MB).", { status: 413 });

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
    const filesJson = await filesResp.json();
    const fileId = filesJson.id;

    // 2) Pedir PDF en base64 via Responses API
    const body = {
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `${prompt}\n\n` +
                `IMPORTANTE: devolvé únicamente un objeto JSON con la forma { "filename": "reporte.pdf", "base64": "<...>" } ` +
                `donde "base64" es el contenido del PDF en Base64 sin prefijos. ` +
                `No incluyas texto adicional fuera del JSON.`,
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

    // Extraer JSON con base64 desde output_text
    const texts = [];
    for (const item of json.output ?? []) {
      if (item.type === "message") {
        for (const c of item.content ?? []) {
          if (c.type === "output_text") texts.push(c.text);
        }
      }
      if (item.type === "output_text") texts.push(item.text);
    }
    const out = texts.join("");
    let data;
    try { data = JSON.parse(out); } catch {
      return new Response("El modelo no devolvió JSON válido con el PDF en base64.", { status: 500 });
    }

    const filename = data.filename || "InsightSimple-Reporte.pdf";
    const base64 = data.base64;
    if (!base64) return new Response("Respuesta sin campo base64.", { status: 500 });

    const bytes = Buffer.from(base64, "base64");
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
