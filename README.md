# InsightSimple — SaaS 2025 (PDF hardened, json_schema)

- Output: **PDF**.
- Responses API con **response_format: json_schema** para garantizar JSON válido.
- Limpieza de base64 (sin prefijos), verificación del header **%PDF** antes de enviar.
- Front SaaS 2025 intacto.

## Local
```bash
npm i
npm run dev
# http://localhost:8888
```

## Deploy desde GitHub
1. Subí este repo a GitHub.
2. Netlify → **Add new site → Import from Git**.
3. Config:
   - Build command: *(vacío)*
   - Publish directory: `.`
   - Functions directory: `netlify/functions`
4. Env vars: `OPENAI_API_KEY`.
5. Pruebas:
   - `/.netlify/functions/hello` → 200 JSON
   - `/.netlify/functions/generate-dashboard` (GET) → 405
   - Carga un PDF/Excel ≤20MB y descarga el **PDF**.

— Generado: 2025-09-22T19:33:26.042944
