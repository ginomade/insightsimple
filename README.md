# InsightSimple — SaaS 2025 (PDF + user_data)

- Front: estilo SaaS 2025, dropzone, toasts, spinner, prompt editable, botón **Limpiar y nuevo**.
- Output **PDF**.
- Functions: Files API con `purpose=user_data`; Responses API devuelve JSON con base64 → `application/pdf`.

## Local
```bash
npm i
npm run dev
# http://localhost:8888
```

## Deploy desde GitHub
1. Subí este repo a GitHub.
2. Netlify → **Add new site → Import from Git**.
3. Configuración:
   - Build command: *(vacío)*
   - Publish directory: `.`
   - Functions directory: `netlify/functions`
4. **Environment variables**: `OPENAI_API_KEY`.
5. Verificá:
   - `/.netlify/functions/hello` → JSON ok
   - `/.netlify/functions/generate-dashboard` → GET devuelve 405 (si realizás un POST desde la web, descarga PDF)
6. Probá subir un **PDF/Excel ≤ 20MB** desde la landing.

— Generado: 2025-09-22T19:25:05.010320
