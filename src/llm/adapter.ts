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

type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
};
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

export async function enviar(mensajes: ModelMessage[], maxTokens: number): Promise<ModelReply> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Falta configurar GEMINI_API_KEY en el archivo .env.");

  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const systemPrompt = mensajes.find((message) => message.role === "system")?.content ?? "";
  const contents = toGeminiContents(mensajes);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        tools: [{
          functionDeclarations: Object.entries(toolRegistry).map(([name, tool]) => ({
            name,
            description: tool.description,
            parameters: jsonSchema(tool.args),
          })),
        }],
        toolConfig: {
          functionCallingConfig: { mode: "AUTO" },
        },
        generationConfig: { maxOutputTokens: Math.min(maxTokens, 4096) },
      }),
      signal: AbortSignal.timeout(60000),
    },
  );
  if (!response.ok) {
    const status = response.status;
    throw new Error(status === 401 || status === 403
      ? "La clave de Gemini no fue aceptada. Revísala en la configuración del backend."
      : `Gemini respondió con estado ${status}.`);
  }

  const body = await response.json() as {
    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
  const parts = body.candidates?.[0]?.content?.parts;
  if (!parts) throw new Error("Gemini devolvió una respuesta vacía.");

  const text = parts.flatMap((part) => part.text ? [part.text] : []).join("");
  const toolCalls = parts.flatMap((part, index): ToolCall[] => {
    if (!part.functionCall) return [];
    const call = part.functionCall;
    return [{
      id: call.id ?? `${call.name}-${index}`,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.args ?? {}),
      },
    }];
  });
  const message: ModelMessage = {
    role: "assistant",
    content: text || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
  const usage = body.usageMetadata;
  return {
    message,
    toolCalls,
    usageTokens: (usage?.promptTokenCount ?? 0)
      + (usage?.candidatesTokenCount ?? 0)
      + (usage?.thoughtsTokenCount ?? 0),
  };
}

function toGeminiContents(messages: ModelMessage[]): GeminiContent[] {
  const functionNames = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) functionNames.set(call.id, call.function.name);
  }

  const contents: GeminiContent[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const parts: GeminiPart[] = [];
      while (index < messages.length && messages[index].role === "tool") {
        const toolMessage = messages[index];
        const name = functionNames.get(toolMessage.tool_call_id ?? "");
        if (!name) throw new Error("No se pudo asociar la respuesta de una herramienta con Gemini.");
        parts.push({
          functionResponse: {
            name,
            response: parseToolResponse(toolMessage.content),
            ...(toolMessage.tool_call_id ? { id: toolMessage.tool_call_id } : {}),
          },
        });
        index++;
      }
      index--;
      contents.push({ role: "user", parts });
      continue;
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      const parts: GeminiPart[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.tool_calls) {
        parts.push({
          functionCall: {
            name: call.function.name,
            args: parseArguments(call.function.arguments),
            id: call.id,
          },
        });
      }
      contents.push({ role: "model", parts });
      continue;
    }

    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content ?? "" }],
    });
  }
  return contents;
}

function jsonSchema(args: z.ZodRawShape): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(args));
  delete schema.$schema;
  return schema;
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function parseToolResponse(value: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value ?? "");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return { result: value ?? "" };
  }
  return { result: value ?? "" };
}
