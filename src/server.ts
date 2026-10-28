import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { enviar, type ModelMessage } from "./llm/adapter.js";
import { executeTool } from "./tools/proveedor.js";

const app = express();
const root = process.cwd();
const port = Number(process.env.PORT ?? 3000);
const maxIterations = Math.max(1, Number(process.env.MAX_TOOL_ITERATIONS ?? 25));
const maxSessionTokens = Math.max(1000, Number(process.env.MAX_SESSION_TOKENS ?? 30000));
const chatRequest = z.object({ sessionId: z.string().optional(), message: z.string().trim().min(1).max(4000) });
type ToolCallView = { name: string; arguments: Record<string, unknown>; result: unknown };
type Session = {
  messages: ModelMessage[];
  toolCalls: ToolCallView[];
  tokenCount: number;
  needsConfirmation: boolean;
  confirmationCase?: string;
};
const sessions = new Map<string, Session>();

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(root, "web")));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, provider: "OpenAI", model: process.env.OPENAI_MODEL ?? "gpt-4o-mini" });
});

app.get("/api/sessions/:id", (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session) {
    response.status(404).json({ error: "No se encontró la sesión." });
    return;
  }
  response.json({
    messages: session.messages.filter((message) => message.role !== "system"),
    toolCalls: session.toolCalls,
    needsConfirmation: session.needsConfirmation,
  });
});

app.post("/api/chat", async (request, response) => {
  const parsed = chatRequest.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Envía un mensaje válido y una sesión opcional." });
    return;
  }
  const sessionId = parsed.data.sessionId || randomUUID();
  if (!/^[\w-]{1,80}$/.test(sessionId)) {
    response.status(400).json({ error: "El identificador de sesión no es válido." });
    return;
  }
  const session = sessions.get(sessionId) ?? await createSession();
  sessions.set(sessionId, session);
  let confirmationWasPending = session.needsConfirmation;
  const confirmationCase = session.confirmationCase;
  session.needsConfirmation = false;
  session.confirmationCase = undefined;
  session.messages.push({ role: "user", content: parsed.data.message });
  const toolCalls: ToolCallView[] = [];
  try {
    let replyText = "";
    let iterations = 0;
    while (iterations < maxIterations) {
      if (session.tokenCount >= maxSessionTokens) {
        replyText = "Se alcanzó el límite de uso de esta sesión. Inicia una nueva para continuar.";
        break;
      }
      const model = await enviar(session.messages, maxSessionTokens - session.tokenCount);
      session.tokenCount += model.usageTokens;
      session.messages.push(model.message);
      if (model.toolCalls.length === 0) {
        replyText = model.message.content ?? "No se obtuvo una respuesta del agente.";
        break;
      }
      iterations += model.toolCalls.length;
      for (const call of model.toolCalls) {
        const args = parseArgs(call.function.arguments);
        const isSimulation = call.function.name === "proveedor_simular_envio";
        let result: string;
        if (isSimulation && !(confirmationWasPending && confirmationCase === args.caso && isAffirmative(parsed.data.message))) {
          result = await executeTool(
            call.function.name,
            JSON.stringify({ ...args, confirmado: false }),
            { directory: root, sessionId: typeof args.caso === "string" && /^[\w-]+$/.test(args.caso) ? args.caso : sessionId },
          );
        } else {
          const caseId = typeof args.caso === "string" && /^[\w-]+$/.test(args.caso) ? args.caso : sessionId;
          result = await executeTool(call.function.name, call.function.arguments, { directory: root, sessionId: caseId });
        }
        const resultValue = parseResult(result);
        const callView = { name: call.function.name, arguments: args, result: resultValue };
        toolCalls.push(callView);
        session.toolCalls.push(callView);
        session.messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      confirmationWasPending = false;
    }
    if (!replyText) replyText = "Llegué al límite de iteraciones de herramientas. Revisa el resumen y los resultados disponibles.";
    const needsConfirmation = asksForConfirmation(replyText);
    session.needsConfirmation = needsConfirmation;
    if (needsConfirmation) {
      const packageCall = [...toolCalls].reverse().find((call) => call.name === "proveedor_armar_paquete");
      const caseId = packageCall?.arguments.caso;
      session.confirmationCase = typeof caseId === "string" ? caseId : undefined;
    }
    session.messages.push({ role: "assistant", content: replyText });
    response.json({ sessionId, reply: replyText, toolCalls, needsConfirmation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado.";
    const safeMessage = message.includes("fetch failed") || message.includes("timed out")
      ? "No fue posible contactar al proveedor de IA. Revisa la conexión e inténtalo de nuevo."
      : message;
    session.messages.push({ role: "assistant", content: safeMessage });
    response.status(200).json({ sessionId, reply: safeMessage, toolCalls, needsConfirmation: false });
  }
});

async function createSession(): Promise<Session> {
  let prompt: string;
  try {
    prompt = await readFile(path.join(root, "agent", "prompt.md"), "utf8");
  } catch {
    throw new Error("No se encontró agent/prompt.md; no se puede iniciar el agente.");
  }
  return {
    messages: [{ role: "system", content: prompt }],
    toolCalls: [],
    tokenCount: 0,
    needsConfirmation: false,
  };
}

function parseArgs(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseResult(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { ok: false, error: "No se pudo interpretar la respuesta de la herramienta." };
  }
}

function isAffirmative(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase();
  return !/\b(no|cancelo|cancelar)\b/.test(normalized)
    && /^(s[ií]|confirmo|autorizo|adelante|procede|env[ií]a|enviar)\b/i.test(normalized);
}

function asksForConfirmation(value: string): boolean {
  return /(¿[^?]*(confirm|autoriz|env[ií]o|simulaci[oó]n)|confirma[sr]?[^.?!]*\?|autoriza[sr]?[^.?!]*\?)/i.test(value);
}

app.listen(port, () => {
  console.log(`Agente de registro de proveedor disponible en http://localhost:${port}`);
});
