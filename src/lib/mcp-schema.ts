import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { JsonSchema, Schema } from "effect";

type McpJsonSchemaOptions = Parameters<
  StandardSchemaWithJSON["~standard"]["jsonSchema"]["input"]
>[0];

function makeMcpJsonSchema(
  schema: Schema.Top,
  options: McpJsonSchemaOptions,
): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(schema);
  switch (options.target) {
    case "draft-07": {
      const draft07 = JsonSchema.toDocumentDraft07(document);
      return {
        $schema: "http://json-schema.org/draft-07/schema#",
        ...draft07.schema,
        ...(Object.keys(draft07.definitions).length > 0
          ? { definitions: draft07.definitions }
          : {}),
      };
    }
    case "draft-2020-12":
      return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        ...document.schema,
        ...(Object.keys(document.definitions).length > 0
          ? { $defs: document.definitions }
          : {}),
      };
    default:
      throw new Error(
        `Unsupported MCP JSON Schema target: ${String(options.target)}. Effect supports draft-07 and draft-2020-12.`,
      );
  }
}

/**
 * Adapts an Effect Schema to the Standard Schema + JSON Schema contract used
 * by the MCP SDK for tool input and output schemas.
 *
 * Effect already implements Standard Schema validation. The MCP SDK also
 * needs the companion JSON Schema converter to advertise schemas over the
 * wire, so this adapter supplies that one additional capability.
 */
export function toMcpSchema<Output, Input = Output>(
  schema: Schema.Codec<Output, Input>,
): StandardSchemaWithJSON<Input, Output> {
  const standard = Schema.toStandardSchemaV1(schema);

  const adapted = {
    "~standard": {
      ...standard["~standard"],
      jsonSchema: {
        input: (options) => makeMcpJsonSchema(schema, options),
        output: (options) => makeMcpJsonSchema(Schema.toType(schema), options),
      },
    },
  } satisfies StandardSchemaWithJSON<Input, Output>;

  return adapted;
}
