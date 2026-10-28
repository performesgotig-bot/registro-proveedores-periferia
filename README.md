# Agente conversacional — Registro como Proveedor

Aplicación local para procesar las solicitudes ficticias del reto: lectura de casos, mapeo trazable contra el maestro, generación de formularios, armado de paquete para firma y una interfaz de chat con llamadas a herramientas visibles.

## Requisitos

- Node.js 20 o superior
- Una clave de API de Gemini para conversar con el agente. La demo determinista no la requiere.

## Inicio rápido

En Windows PowerShell, copia `.env.example` a `.env`, agrega tu nueva clave de Gemini a `GEMINI_API_KEY` y luego ejecuta:

```powershell
npm.cmd install
npm.cmd run dev
```

La clave compartida anteriormente debe revocarse antes de configurar una clave nueva. No la pegues en el chat ni la guardes en Git; `.env` está excluido del repositorio.

Abre <http://localhost:3000>. La clave permanece en el backend. No se incluye un enlace público desplegado.

## Demo sin modelo

```powershell
npx.cmd ts-node demo.ts
```

La demo importa y ejecuta las herramientas reales, sin llamar al modelo. Procesa todos los casos en `fixtures/reto-01/casos/`, recrea `out/` desde cero y sigue con el siguiente caso si alguno falla. Genera el formulario y el paquete con datos y vigencias leídos de los fixtures.

## Variables de entorno

| Variable | Uso | Valor de ejemplo |
|---|---|---|
| `PORT` | Puerto local HTTP | `3000` |
| `GEMINI_API_KEY` | Clave del backend; no se expone al navegador | Vacía en `.env.example` |
| `GEMINI_MODEL` | Modelo de chat | `gemini-2.5-flash` |
| `MAX_TOOL_ITERATIONS` | Límite de llamadas a herramientas por turno | `25` |
| `MAX_SESSION_TOKENS` | Límite aproximado de tokens por sesión | `30000` |

## API

- `GET /api/health`: estado, proveedor y modelo, sin revelar secretos.
- `POST /api/chat`: `{ "sessionId": "opcional", "message": "..." }`.
- `GET /api/sessions/:id`: historial y llamadas a herramientas de una sesión en memoria.

Las salidas y los registros se escriben debajo de `out/<caso>/`. Ningún envío, firma o carga se realiza externamente.
