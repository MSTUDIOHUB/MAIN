/** Output formatting is a transport constraint, never task or tool authority. */
export type ResponseFormatProtocol = "openai_chat" | "openai_responses" | "ollama" | "unsupported";

export function applyStreamResponseFormat(
  body: Record<string, unknown>,
  protocol: ResponseFormatProtocol,
  format?: Record<string, unknown>,
): Record<string, unknown> {
  if (!format || protocol === "unsupported") return body;
  if (protocol === "openai_chat") return { ...body, response_format: format };
  const schema = format.type === "json_schema" && format.json_schema && typeof format.json_schema === "object"
    ? format.json_schema as Record<string, unknown> : null;
  if (protocol === "ollama") return { ...body, format: format.type === "json_object" ? "json" : schema?.schema || format };
  return { ...body, text: { ...(body.text && typeof body.text === "object" ? body.text : {}), format: schema ? { type: "json_schema", ...schema } : format } };
}

/** Retry only a rejected optional field, never a bad schema or output parse. */
export function isUnsupportedStreamResponseFormat(message: string): boolean {
  const text = String(message || "").toLowerCase();
  if (!/^http\s+(?:400|422)\b/.test(text.trim()) ||
    /invalid[_ -]*(?:json[_ -]*)?schema|schema (?:is |was )?(?:invalid|unsupported)|unsupported (?:schema|keyword)|schema validation|\.json_schema|\.schema|\b(?:anyof|oneof|allof|additionalproperties|keyword)\b/.test(text)) return false;
  const field = "(?:[\"']?(?:response_format|text\\.format)[\"']?|[\"']format[\"'])(?![\\w.\\[])";
  const rejectsField = new RegExp(`(?:unsupported|unknown|unrecognized)\\s+(?:(?:request\\s+)?(?:parameter|field|argument)(?:\\s+supplied)?\\s*[:=]?\\s*)?${field}`);
  const fieldRejected = new RegExp(`${field}\\s+(?:(?:parameter|field)\\s+)?(?:(?:is|are)\\s+)?(?:not supported|unsupported|unknown|unrecognized)\\b`);
  const cannotSupportField = new RegExp(`(?:does not|doesn't|cannot)\\s+support\\s+${field}`);
  if (rejectsField.test(text) || fieldRejected.test(text) || cannotSupportField.test(text)) return true;
  try {
    const json = JSON.parse(text.slice(text.indexOf("{")));
    const error = json.error || json;
    return ["response_format", "text.format", "format"].includes(error.param) &&
      ["unsupported_parameter", "unknown_parameter", "unrecognized_parameter", "unsupported_field"].includes(error.code);
  } catch { return false; }
}
