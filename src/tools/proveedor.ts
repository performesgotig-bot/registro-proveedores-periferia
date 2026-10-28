import { appendFile, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { z } from "zod";

type ToolContext = { directory: string; sessionId: string };
type Result = { ok: true; data: unknown } | { ok: false; error: string };

const solicitudSchema = z.object({
  id: z.string(),
  pais: z.string(),
  cliente: z.string(),
  formato: z.enum(["xlsx", "pdf", "portal"]),
  cuerpo: z.string(),
  asunto: z.string(),
});
const celdaSchema = z.object({
  hoja: z.string(),
  celda_etiqueta: z.string(),
  etiqueta: z.string(),
  celda_valor: z.string(),
});
const campoPdfSchema = z.object({ etiqueta: z.string(), obligatorio: z.boolean() });
const maestroSchema = z.record(z.string(), z.unknown());
const soporteSchema = z.object({
  tipo: z.string(),
  archivo: z.string(),
  vigencia_hasta: z.string().nullable(),
  pais_emisor: z.string(),
  descripcion: z.string(),
});
const mapeoItemSchema = z.object({
  etiqueta: z.string(),
  ruta: z.string().optional(),
  valor: z.unknown().optional(),
  estado: z.enum(["lleno", "faltante", "requiere_confirmacion"]),
  nota: z.string().optional(),
  hoja: z.string().optional(),
  celda_valor: z.string().optional(),
});
const mapeoSchema = z.object({
  llenos: z.array(mapeoItemSchema),
  faltantes: z.array(mapeoItemSchema),
  requiere_confirmacion: z.array(mapeoItemSchema),
});

export const leer_solicitud = {
  description: "Lee el correo, la plantilla y los soportes solicitados de un caso.",
  args: { caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/") },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    return runTool("leer_solicitud", args.caso, ctx, async () => {
      const { solicitud, campos, soportes } = await loadCase(ctx.directory, args.caso);
      return {
        pais: solicitud.pais,
        cliente: solicitud.cliente,
        formato: solicitud.formato,
        campos,
        soportes,
      };
    });
  },
};

export const mapear_campos = {
  description: "Cruza los campos pedidos con el maestro sin inventar datos y devuelve faltantes o confirmaciones.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    campos: z.array(z.string()).describe("Etiquetas de campos solicitados por el cliente"),
  },
  async execute(args: { caso: string; campos: string[] }, ctx: ToolContext): Promise<string> {
    return runTool("mapear_campos", args.caso, ctx, async () => mapFields(ctx.directory, args.caso, args.campos));
  },
};

export const generar_formulario = {
  description: "Genera el formulario de salida en Excel, PDF o una lista Markdown para portal.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    mapeo: mapeoSchema.describe("Resultado de mapear_campos"),
  },
  async execute(args: { caso: string; mapeo: z.infer<typeof mapeoSchema> }, ctx: ToolContext): Promise<string> {
    return runTool("generar_formulario", args.caso, ctx, async () => generateForm(ctx.directory, args.caso, args.mapeo));
  },
};

export const armar_paquete = {
  description: "Prepara el paquete para firma con formulario, soportes y checklist de vigencias.",
  args: { caso: z.string().describe("Nombre de la carpeta del caso") },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    return runTool("armar_paquete", args.caso, ctx, async () => buildPackage(ctx.directory, args.caso));
  },
};

export const simular_envio = {
  description: "Registra una simulación local de envío únicamente después de una confirmación humana explícita.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    confirmado: z.boolean().describe("Debe ser true solo tras confirmación explícita de la persona"),
  },
  async execute(args: { caso: string; confirmado: boolean }, ctx: ToolContext): Promise<string> {
    return runTool("simular_envio", args.caso, ctx, async () => {
      if (!args.confirmado) throw new Error("requiere confirmación explícita");
      const out = caseOutputDir(ctx.directory, args.caso);
      await mkdir(out, { recursive: true });
      const destination = path.join(out, "ENVIO-SIMULADO.md");
      await writeFile(destination, `# Envío simulado\n\nCaso: ${args.caso}\nFecha: ${new Date().toISOString()}\n\nNo se realizó ningún envío externo.\n`, "utf8");
      return { ruta: relativePath(ctx.directory, destination) };
    });
  },
};

export const toolRegistry = {
  proveedor_leer_solicitud: leer_solicitud,
  proveedor_mapear_campos: mapear_campos,
  proveedor_generar_formulario: generar_formulario,
  proveedor_armar_paquete: armar_paquete,
  proveedor_simular_envio: simular_envio,
};

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  let args: unknown;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    await logTool(ctx, name, false, "Los argumentos no contienen JSON válido");
    return JSON.stringify({ ok: false, error: "Los argumentos no contienen JSON válido." });
  }
  switch (name) {
    case "proveedor_leer_solicitud":
      return executeValidated(name, leer_solicitud, args, ctx);
    case "proveedor_mapear_campos":
      return executeValidated(name, mapear_campos, args, ctx);
    case "proveedor_generar_formulario":
      return executeValidated(name, generar_formulario, args, ctx);
    case "proveedor_armar_paquete":
      return executeValidated(name, armar_paquete, args, ctx);
    case "proveedor_simular_envio":
      return executeValidated(name, simular_envio, args, ctx);
    default:
      await logTool(ctx, name, false, "Herramienta desconocida");
      return JSON.stringify({ ok: false, error: "Herramienta desconocida." });
  }
}

async function executeValidated<T extends z.ZodRawShape>(
  name: string,
  tool: { args: T; execute: (args: z.infer<z.ZodObject<T>>, ctx: ToolContext) => Promise<string> },
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<string> {
  const parsed = z.object(tool.args).safeParse(rawArgs);
  if (!parsed.success) {
    await logTool(ctx, name, false, "Los argumentos no cumplen el formato requerido");
    return JSON.stringify({ ok: false, error: "Los argumentos no cumplen el formato requerido." });
  }
  return tool.execute(parsed.data, ctx);
}

export async function runDemo(directory: string): Promise<Array<{ caso: string; resultado: unknown }>> {
  const casesRoot = path.join(directory, "fixtures", "reto-01", "casos");
  const cases = (await readdir(casesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const output = path.join(directory, "out");
  await rm(output, { recursive: true, force: true });
  const results: Array<{ caso: string; resultado: unknown }> = [];
  for (const caso of cases) {
    const request = JSON.parse(await readFile(path.join(casesRoot, caso, "solicitud.json"), "utf8")) as z.infer<typeof solicitudSchema>;
    const ctx = { directory, sessionId: caso };
    const loaded = await loadCase(directory, caso);
    await logTool(ctx, "leer_solicitud", true, `Caso ${caso} leído`);
    const fields = loaded.campos.map((field) => field.etiqueta);
    const mapping = await mapFields(directory, caso, fields);
    await logTool(ctx, "mapear_campos", true, `Caso ${caso}: ${mapping.llenos.length} campos llenos`);
    const form = await generateForm(directory, caso, mapping);
    await logTool(ctx, "generar_formulario", true, `Formulario ${request.formato} generado`);
    const bundle = await buildPackage(directory, caso, mapping);
    await logTool(ctx, "armar_paquete", true, `Paquete de firma ${bundle.listo_para_firma ? "listo" : "pendiente"}`);
    results.push({
      caso,
      resultado: {
        formato: request.formato,
        campos_llenos: mapping.llenos.length,
        campos_faltantes: mapping.faltantes.length,
        requieren_confirmacion: mapping.requiere_confirmacion.length,
        formulario: form.ruta,
        listo_para_firma: bundle.listo_para_firma,
      },
    });
  }
  return results;
}

async function loadCase(directory: string, caso: string) {
  if (!/^[\w-]+$/.test(caso)) throw new Error("El nombre del caso no es válido.");
  const base = path.join(directory, "fixtures", "reto-01", "casos", caso);
  const solicitud = solicitudSchema.parse(await readJson(path.join(base, "solicitud.json")));
  const soportes = z.array(z.string()).parse(await readJson(path.join(base, "soportes-exigidos.json")));
  let campos: Array<z.infer<typeof celdaSchema> | z.infer<typeof campoPdfSchema>>;
  if (solicitud.formato === "xlsx") {
    campos = z.array(celdaSchema).parse(await readJson(path.join(base, "plantilla-celdas.json")));
  } else if (solicitud.formato === "pdf") {
    campos = z.array(campoPdfSchema).parse(await readJson(path.join(base, "plantilla-campos.json")));
  } else {
    campos = [
      "Razón social",
      "RUC",
      "Dirección",
      "Ciudad",
      "País",
      "Teléfono",
      "Correo electrónico",
      "Página web",
      "Representante legal",
      "Cargo del representante legal",
      "Actividad económica",
    ].map((etiqueta) => ({ etiqueta, obligatorio: false }));
  }
  return { base, solicitud, campos, soportes };
}

async function mapFields(directory: string, caso: string, requested: string[]) {
  const { solicitud, campos } = await loadCase(directory, caso);
  const maestro = maestroSchema.parse(await readJson(path.join(directory, "fixtures", "reto-01", "repositorio", "maestro.json")));
  const glossary = z.record(z.string(), z.string()).parse(await readJson(path.join(directory, "fixtures", "reto-01", "glosario-campos.json")));
  const templates = new Map(campos.map((field) => [field.etiqueta, field]));
  const result = { llenos: [] as z.infer<typeof mapeoItemSchema>[], faltantes: [] as z.infer<typeof mapeoItemSchema>[], requiere_confirmacion: [] as z.infer<typeof mapeoItemSchema>[] };
  for (const etiqueta of requested) {
    const template = templates.get(etiqueta);
    const mappedPath = findGlossaryPath(glossary, etiqueta);
    const value = mappedPath ? getValue(maestro, mappedPath) : undefined;
    const entry = {
      etiqueta,
      ...(mappedPath ? { ruta: mappedPath } : {}),
      ...(value !== undefined ? { valor: value } : {}),
      ...(template && "hoja" in template ? { hoja: template.hoja, celda_valor: template.celda_valor } : {}),
      estado: (value === undefined ? "faltante" : "lleno") as z.infer<typeof mapeoItemSchema>["estado"],
    };
    if (value === undefined) {
      result.faltantes.push(entry);
    } else if (isTaxId(etiqueta) && solicitud.pais !== "CO") {
      result.requiere_confirmacion.push({ ...entry, estado: "requiere_confirmacion", nota: "identificador extranjero" });
    } else {
      result.llenos.push(entry);
    }
  }
  return result;
}

function findGlossaryPath(glossary: Record<string, string>, label: string): string | undefined {
  const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase();
  const exact = Object.entries(glossary).find(([key]) => normalize(key) === normalize(label));
  if (exact) return exact[1];
  const direct = Object.keys(glossary).find((key) => normalize(key).includes(normalize(label)) || normalize(label).includes(normalize(key)));
  return direct ? glossary[direct] : undefined;
}

function isTaxId(label: string): boolean {
  return /(^|\b)(nit|ruc|rtn|identificaci[oó]n tributaria|n[uú]mero de identificaci[oó]n fiscal)(\b|$)/i.test(label);
}

function getValue(root: Record<string, unknown>, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((current, key) => {
    if (current && typeof current === "object" && key in current) return (current as Record<string, unknown>)[key];
    return undefined;
  }, root);
}

async function generateForm(directory: string, caso: string, mapping: z.infer<typeof mapeoSchema>) {
  const { solicitud, campos } = await loadCase(directory, caso);
  const output = caseOutputDir(directory, caso);
  await mkdir(output, { recursive: true });
  const values = [...mapping.llenos, ...mapping.requiere_confirmacion];
  const byLabel = new Map(values.map((item) => [item.etiqueta, item.valor]));
  if (solicitud.formato === "portal") {
    const destination = path.join(output, "valores-portal.md");
    const lines = ["# Valores para copiar en el portal", "", "> El llenado y el envío en el portal los realiza una persona.", ""];
    for (const item of values) lines.push(`- **${item.etiqueta}:** ${formatValue(item.valor)}`);
    for (const item of mapping.faltantes) lines.push(`- **${item.etiqueta}:** Pendiente (sin dato en el maestro)`);
    await writeFile(destination, `${lines.join("\n")}\n`, "utf8");
    return { ruta: relativePath(directory, destination), formato: "portal" };
  }
  if (solicitud.formato === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    for (const field of z.array(celdaSchema).parse(campos)) {
      let sheet = workbook.getWorksheet(field.hoja);
      if (!sheet) sheet = workbook.addWorksheet(field.hoja);
      sheet.getCell(field.celda_etiqueta).value = field.etiqueta;
      sheet.getCell(field.celda_valor).value = byLabel.has(field.etiqueta) ? formatValue(byLabel.get(field.etiqueta)) : "";
    }
    const destination = path.join(output, "formulario.xlsx");
    await workbook.xlsx.writeFile(destination);
    return { ruta: relativePath(directory, destination), formato: "xlsx" };
  }
  const destination = path.join(output, "formulario.pdf");
  await writePdf(destination, z.array(campoPdfSchema).parse(campos).map((field) => ({
    etiqueta: field.etiqueta,
    valor: byLabel.has(field.etiqueta) ? formatValue(byLabel.get(field.etiqueta)) : "",
  })));
  return { ruta: relativePath(directory, destination), formato: "pdf" };
}

async function buildPackage(directory: string, caso: string, knownMapping?: z.infer<typeof mapeoSchema>) {
  const { solicitud, campos, soportes: required } = await loadCase(directory, caso);
  const mapping = knownMapping ?? await mapFields(directory, caso, campos.map((field) => field.etiqueta));
  const form = await generateForm(directory, caso, mapping);
  const output = caseOutputDir(directory, caso);
  const packageDir = path.join(output, "paquete");
  await mkdir(packageDir, { recursive: true });
  await copyFile(path.join(directory, form.ruta), path.join(packageDir, path.basename(form.ruta)));
  const supportIndex = z.array(soporteSchema).parse(await readJson(path.join(directory, "fixtures", "reto-01", "repositorio", "soportes", "index.json")));
  const checklist: Array<{ tipo: string; estado: "presente" | "ausente" | "vencido"; archivo?: string; vigencia_hasta?: string | null }> = [];
  for (const tipo of required) {
    const support = supportIndex.find((item) => item.tipo === tipo);
    if (!support) {
      checklist.push({ tipo, estado: "ausente" });
      continue;
    }
    const expired = support.vigencia_hasta !== null && support.vigencia_hasta < new Date().toISOString().slice(0, 10);
    checklist.push({ tipo, estado: expired ? "vencido" : "presente", archivo: support.archivo, vigencia_hasta: support.vigencia_hasta });
    await copyFile(
      path.join(directory, "fixtures", "reto-01", "repositorio", "soportes", support.archivo),
      path.join(packageDir, support.archivo),
    );
  }
  const missingFields = mapping.faltantes.map((item) => item.etiqueta);
  const checklistLines = [
    `# Checklist de paquete — ${solicitud.cliente}`,
    "",
    ...checklist.map((item) => `- ${item.estado === "presente" ? "[x]" : "[ ]"} ${item.tipo}: ${item.estado}${item.vigencia_hasta ? ` (vigencia hasta ${item.vigencia_hasta})` : ""}`),
    "",
    "## Campos faltantes",
    "",
    ...(missingFields.length ? missingFields.map((label) => `- ${label}`) : ["- Ninguno"]),
    "",
    "## Campos que requieren confirmación",
    "",
    ...(mapping.requiere_confirmacion.length ? mapping.requiere_confirmacion.map((item) => `- ${item.etiqueta}: ${item.nota ?? "Revisar"}`) : ["- Ninguno"]),
  ];
  await writeFile(path.join(packageDir, "checklist.md"), `${checklistLines.join("\n")}\n`, "utf8");
  const email = [
    `# Borrador de correo para ${solicitud.cliente}`,
    "",
    `**Asunto:** Registro como proveedor — ${solicitud.cliente}`,
    "",
    "Estimados,",
    "",
    "Adjuntamos el formulario de registro diligenciado y los soportes disponibles para su revisión y firma del representante legal.",
    "",
    "Quedamos atentos a cualquier información adicional requerida.",
    "",
    "Saludos cordiales,",
    "Periferia IT Group S.A.S.",
  ].join("\n");
  await writeFile(path.join(packageDir, "borrador-correo.md"), `${email}\n`, "utf8");
  const ready = checklist.every((item) => item.estado === "presente");
  return { ruta: relativePath(directory, packageDir), listo_para_firma: ready, checklist };
}

async function writePdf(destination: string, fields: Array<{ etiqueta: string; valor: string }>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const document = new PDFDocument({ margin: 48 });
    const file = createWriteStream(destination);
    file.on("error", reject);
    document.pipe(file);
    document.fontSize(18).text("Formulario de registro de proveedor", { underline: true });
    document.moveDown();
    for (const field of fields) {
      document.fontSize(11).font("Helvetica-Bold").text(field.etiqueta);
      document.font("Helvetica").text(field.valor || "Pendiente");
      document.moveDown(0.7);
    }
    document.end();
    file.on("finish", resolve);
  });
}

async function runTool(name: string, caso: string, ctx: ToolContext, operation: () => Promise<unknown>): Promise<string> {
  try {
    const data = await operation();
    await logTool(ctx, name, true, `Caso ${caso} procesado`);
    return JSON.stringify({ ok: true, data } satisfies Result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado.";
    await logTool(ctx, name, false, message);
    return JSON.stringify({ ok: false, error: friendlyError(message) } satisfies Result);
  }
}

async function logTool(ctx: ToolContext, name: string, ok: boolean, summary: string): Promise<void> {
  const log = path.join(caseOutputDir(ctx.directory, ctx.sessionId), "log.jsonl");
  await mkdir(path.dirname(log), { recursive: true });
  await appendFile(log, `${JSON.stringify({ ts: new Date().toISOString(), herramienta: name, ok, resumen: summary })}\n`, "utf8");
}

function friendlyError(message: string): string {
  if (message.includes("ENOENT")) return "No se encontró el caso o uno de sus archivos requeridos.";
  if (message.includes("ZodError")) return "Un archivo del caso no tiene el formato esperado.";
  return message;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function caseOutputDir(directory: string, caso: string): string {
  if (!/^[\w-]+$/.test(caso)) throw new Error("El nombre del caso no es válido.");
  return path.join(directory, "out", caso);
}

function relativePath(directory: string, file: string): string {
  return path.relative(directory, file).split(path.sep).join("/");
}
