# InsightSimple — Repo GitHub (v2: validación cliente/servidor)

Este repo incluye validación de tipo y tamaño **en el cliente y en el servidor** (PDF/XLSX/XLS, ≤20MB).

## Uso local
```bash
npm i
npm run dev
# abrir http://localhost:8888
```

## Deploy desde GitHub
1. Subí este repo a GitHub.
2. En Netlify: **Add new site → Import from Git**.
3. Configurá:
   - Build command: *(vacío)*
   - Publish directory: `.`
   - Functions directory: `netlify/functions`
4. **Environment variables**: agregá `OPENAI_API_KEY`.
5. Verificá:
   - `/.netlify/functions/hello` → JSON ok
   - `/.netlify/functions/generate-dashboard` → GET debe dar 405 (existe)
6. En la landing, probá **Subir documento** con `.pdf` o `.xlsx/.xls` ≤ 20MB.

Generado: 2025-09-22T14:56:51.654540
