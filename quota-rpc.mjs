const windowSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    usedPercent: { type: "number", minimum: 0, maximum: 100 },
    remainingPercent: { type: "number", minimum: 0, maximum: 100 },
    resetsAt: { type: ["string", "null"] },
  },
  required: ["name", "usedPercent", "remainingPercent", "resetsAt"],
  additionalProperties: false,
}
const sectionSchema = {
  anyOf: [{
    type: "object",
    properties: {
      label: { type: "string" },
      checkedAt: { type: "string" },
      windows: { type: "array", minItems: 1, items: windowSchema },
    },
    required: ["label", "checkedAt", "windows"],
    additionalProperties: false,
  }, {
    type: "object",
    properties: {
      label: { type: "string" },
      checkedAt: { type: "string" },
      error: {
      type: "object",
      properties: { code: { type: "string" }, message: { type: "string" } },
      required: ["code", "message"],
      additionalProperties: false,
      },
    },
    required: ["label", "checkedAt", "error"],
    additionalProperties: false,
  }],
}
export const QuotaRpc = {
  id: "go-codex-quota",
  methods: {
    read: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: { checkedAt: { type: "string" }, go: sectionSchema, codex: sectionSchema },
        required: ["checkedAt", "go", "codex"],
        additionalProperties: false,
      },
    },
  },
  events: {},
}
