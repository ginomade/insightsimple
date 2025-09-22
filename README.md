# InsightSimple — SaaS 2025 Edition

UI renovada (dropzone, toasts, spinner), validación en cliente/servidor y Functions (Node base64).

## Local
```bash
npm i
npm run dev
# http://localhost:8888
```

## Deploy desde GitHub
1. Subí este repo a GitHub.
2. Netlify → **Add new site → Import from Git**.
3. Configurá:
   - Build command: *(vacío)*
   - Publish directory: `.`
   - Functions directory: `netlify/functions`
4. **Environment variables**: `OPENAI_API_KEY`.
5. Verificá:
   - `/.netlify/functions/hello` → JSON ok
   - `/.netlify/functions/generate-dashboard` → GET devuelve 405
6. Subí un **PDF/Excel ≤ 20MB** y recibí el **.pptx**.

— Generado: 2025-09-22T17:10:48.677419
