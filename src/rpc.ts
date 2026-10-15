import { Rpc } from "@opencode/plugin/rpc"

const sessionInput = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
} as const

const goal = { anyOf: [{ type: "object" }, { type: "null" }] } as const

/**
 * Shared contract between the server plugin and clients (the bundled TUI, or any OpenCode client):
 * `client.rpc(GoalRpc).get({ sessionID })`, and live `changed` / `notice` events.
 */
export const GoalRpc = Rpc.define({
  id: "goal",
  methods: {
    get: {
      input: sessionInput,
      output: { type: "object", properties: { goal }, required: ["goal"] },
    },
    list: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", properties: { goals: { type: "array", items: { type: "object" } } }, required: ["goals"] },
    },
    status: {
      input: sessionInput,
      output: { type: "object" },
    },
    clear: {
      input: sessionInput,
      output: { type: "object", properties: { cleared: { type: "boolean" } }, required: ["cleared"] },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" }, goal },
        required: ["sessionID", "goal"],
      },
    },
    notice: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          kind: { type: "string" },
          level: { type: "string", enum: ["info", "success", "warning", "error"] },
          title: { type: "string" },
          message: { type: "string" },
        },
        required: ["sessionID", "kind", "level", "title", "message"],
      },
    },
  },
})
