import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  armar_paquete,
  generar_formulario,
  leer_solicitud,
  mapear_campos,
} from "./src/tools/proveedor.ts";

const root = process.cwd();

interface ToolResult<T> {
  ok: true;
  data: T;
}

interface ToolError {
  ok: false;
  error: string;
}

interface SolicitudData {
  pais: string;
  cliente: string;
  formato: "xlsx" | "pdf" | "portal";
  campos: Array<{ etiqueta: string }>;
  soportes: string[];
}

interface MapeoData {
  llenos: unknown[];
  faltantes: unknown[];
  requiere_confirmacion: unknown[];
}

interface FormularioData {
  ruta: string;
  formato: string;
}

interface PaqueteData {
  ruta: string;
  listo_para_firma: boolean;
  checklist: unknown[];
}

type ToolResponse<T> = ToolResult<T> | ToolError;

function parseToolResult<T>(raw: string): ToolResponse<T> {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) {
    throw new Error("La herramienta devolvió una respuesta con formato inválido.");
  }
  const result = parsed as { ok: unknown; data?: unknown; error?: unknown };
  if (result.ok === false && typeof result.error === "string") {
    return { ok: false, error: result.error };
  }
  if (result.ok !== true || !("data" in result)) {
    throw new Error("La herramienta devolvió una respuesta incompleta.");
  }
  return { ok: true, data: result.data as T };
}

async function execute<T, A extends object>(
  tool: { execute(args: A, ctx: { directory: string; sessionId: string }): Promise<string> },
  args: A,
  caso: string,
): Promise<ToolResponse<T>> {
  const raw = await tool.execute(args, { directory: root, sessionId: caso });
  return parseToolResult<T>(raw);
}

function requireSuccess<T>(result: ToolResponse<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

async function ejecutarDemo(): Promise<void> {
  const casesRoot = path.join(root, "fixtures", "reto-01", "casos");
  await fs.access(casesRoot);

  console.log("=================================================");
  console.log("  INICIANDO VERIFICACIÓN DETERMINISTA EN FRÍO");
  console.log("=================================================\n");

  const cases = (await fs.readdir(casesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (cases.length === 0) throw new Error("No se encontraron casos en los fixtures.");

  await fs.rm(path.join(root, "out"), { recursive: true, force: true });

  let failures = 0;
  for (const caso of cases) {
    console.log(`\n▶ PROCESANDO CASO: [ ${caso} ]`);
    try {
      const request = requireSuccess(
        await execute<SolicitudData, { caso: string }>(leer_solicitud, { caso }, caso),
      );
      console.log(`   - Cliente: ${request.cliente} (${request.pais}) | Formato: ${request.formato}`);

      const mapping = requireSuccess(
        await execute<MapeoData, { caso: string; campos: string[] }>(
          mapear_campos,
          { caso, campos: request.campos.map((field) => field.etiqueta) },
          caso,
        ),
      );
      console.log(`   - Campos Llenos: ${mapping.llenos.length}`);
      console.log(`   - Campos Faltantes: ${mapping.faltantes.length}`);
      console.log(`   - Requieren Confirmación: ${mapping.requiere_confirmacion.length}`);

      const form = requireSuccess(
        await execute<FormularioData, { caso: string; mapeo: MapeoData }>(
          generar_formulario,
          { caso, mapeo: mapping },
          caso,
        ),
      );
      console.log(`   - Formulario generado en: ${form.ruta}`);

      const bundle = requireSuccess(
        await execute<PaqueteData, { caso: string }>(armar_paquete, { caso }, caso),
      );
      console.log(`   - Paquete generado en: ${bundle.ruta}`);
      console.log(`   - Estado Listo para Firma: ${bundle.listo_para_firma ? "SÍ" : "NO (Soportes vencidos/ausentes)"}`);
    } catch (error) {
      failures++;
      const message = error instanceof Error ? error.message : "Error inesperado.";
      console.error(`   - Error: ${message}`);
    }
  }

  console.log("\n=================================================");
  console.log(failures === 0
    ? "  [PASS] VERIFICACIÓN COMPLETADA EXITOSAMENTE"
    : `  [FAIL] ${failures} de ${cases.length} casos fallaron; los demás se procesaron`);
  console.log("=================================================");
  if (failures > 0) process.exitCode = 1;
}

ejecutarDemo().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Error inesperado durante la demo.";
  console.error(`\n[FAIL] ${message}`);
  process.exitCode = 1;
});
