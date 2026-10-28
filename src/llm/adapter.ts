import { z } from "zod";
import { toolRegistry } from "../tools/proveedor.js";

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
export type ModelReply = {
  message: ModelMessage;
  toolCalls: ToolCall[];
  usageTokens: number;
};

export async function enviar(mensajes: ModelMessage[], maxTokens: number): Promise<ModelReply> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Falta configurar OPENAI_API_KEY en el archivo .env.");
  const functions = Object.entries(toolRegistry).map(([name, tool]) => ({
    type: "function",
    function: {
      name,
      description: tool.description,
      parameters: jsonSchema(tool.args),
    },
  }));
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      messages: mensajes,
      tools: functions,
      tool_choice: "auto",
      max_tokens: Math.min(maxTokens, 4096),
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    const status = response.status;
    throw new Error(status === 401 ? "La clave del proveedor de IA no fue aceptada." : `El proveedor de IA respondió con estado ${status}.`);
  }

  function jsonSchema(args: z.ZodRawShape): Record<string, unknown> {
    const schema = z.toJSONSchema(z.object(args));
    delete schema.$schema;
    return schema;
  }
  const body = await response.json() as {
    choices?: Array<{ message?: { role?: string; content?: string | null; tool_calls?: ToolCall[] } }>;
    usage?: { total_tokens?: number };
  };
  const source = body.choices?.[0]?.message;
  if (!source) throw new Error("El proveedor de IA devolvió una respuesta vacía.");
  const message: ModelMessage = {
    role: "assistant",
    content: source.content ?? null,
    ...(source.tool_calls ? { tool_calls: source.tool_calls } : {}),
  };
  return { message, toolCalls: source.tool_calls ?? [], usageTokens: body.usage?.total_tokens ?? 0 };
}
