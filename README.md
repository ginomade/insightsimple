# InsightSimple — HTML→PDF (Netlify Functions)

Front estilo **SaaS 2025**. Cargás PDF/Excel (≤ 20 MB). La función:
1) Sube tu archivo a **OpenAI Files** (`purpose=user_data`).
2) Pide al modelo **HTML completo** del informe (no binario).
3) Renderiza **HTML → PDF** con `puppeteer-core` + `@sparticuz/chromium`.
4) Devuelve **PDF válido** para descarga.

## Deploy desde GitHub
1. Subí este repo a GitHub.
2. Netlify → Add new site → Import from Git.
3. Config:
   - Build command: *(vacío)*
   - Publish directory: `.`
   - Functions directory: `netlify/functions`
4. Env vars: `OPENAI_API_KEY`.
5. Test:
   - `/.netlify/functions/hello` → 200 JSON
   - Subí un PDF/Excel en la landing → descarga PDF.

— Generado: 2025-09-22T20:04:28.272145
