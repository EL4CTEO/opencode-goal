// @bun
// src/tui.tsx
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { createMemo, createSignal, Show } from "solid-js";

// src/core/format.ts
var GOAL_GLYPH = "\u25CE";
function formatDurationCoarse(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1)
    return "<1m";
  if (minutes < 60)
    return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var sessionInput = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false
};
var goal = { anyOf: [{ type: "object" }, { type: "null" }] };
var GoalRpc = Rpc.define({
  id: "goal",
  methods: {
    get: {
      input: sessionInput,
      output: { type: "object", properties: { goal }, required: ["goal"] }
    },
    list: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", properties: { goals: { type: "array", items: { type: "object" } } }, required: ["goals"] }
    },
    status: {
      input: sessionInput,
      output: { type: "object" }
    },
    clear: {
      input: sessionInput,
      output: { type: "object", properties: { cleared: { type: "boolean" } }, required: ["cleared"] }
    }
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" }, goal },
        required: ["sessionID", "goal"]
      }
    },
    notice: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          kind: { type: "string" },
          level: { type: "string", enum: ["info", "success", "warning", "error"] },
          title: { type: "string" },
          message: { type: "string" }
        },
        required: ["sessionID", "kind", "level", "title", "message"]
      }
    }
  }
});

// src/tui.tsx
var TICK_MS = 15000;
var ATTENTION_KINDS = new Set(["achieved", "impossible", "failed", "paused"]);
var tui_default = Plugin.define({
  id: "opencode-goal.tui",
  setup(context) {
    const rpc = context.client.rpc(GoalRpc);
    const [entries, setEntries] = createSignal({});
    const [now, setNow] = createSignal(Date.now());
    const requested = new Set;
    const at = (sessionID) => {
      const location = context.data.session.get(sessionID)?.location ?? context.location;
      return location ? {
        location
      } : undefined;
    };
    const put = (sessionID, goal) => setEntries((previous) => ({
      ...previous,
      [sessionID]: {
        goal,
        receivedAt: Date.now()
      }
    }));
    const ensure = (sessionID) => {
      if (requested.has(sessionID))
        return;
      requested.add(sessionID);
      rpc.get({
        sessionID
      }, at(sessionID)).then((result) => put(sessionID, result.goal)).catch(() => requested.delete(sessionID));
    };
    const live = (sessionID) => {
      if (!sessionID)
        return;
      ensure(sessionID);
      const goal = entries()[sessionID]?.goal;
      return goal && (goal.status === "active" || goal.status === "paused") ? goal : undefined;
    };
    const currentSession = () => {
      const route = context.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };
    const onNotice = (notice) => {
      const here = currentSession() === notice.sessionID;
      if (notice.kind === "status") {
        if (here)
          context.ui.dialog.alert({
            title: `${GOAL_GLYPH} /goal`,
            message: `${notice.title}

${notice.message}`
          });
        return;
      }
      const important = ATTENTION_KINDS.has(notice.kind);
      if (!here && !important)
        return;
      context.ui.toast.show({
        title: `${GOAL_GLYPH} ${notice.title}`,
        message: notice.message,
        variant: notice.level,
        duration: notice.level === "error" || notice.level === "warning" ? 8000 : 4000
      });
      if (important)
        context.attention.notify({
          title: `OpenCode \xB7 ${notice.title}`,
          message: notice.message,
          notification: {
            when: "blurred"
          },
          sound: {
            name: notice.kind === "achieved" ? "done" : "error",
            when: "blurred"
          }
        });
    };
    const offChanged = rpc.events.on("changed", (event) => {
      const data = event.data;
      if (typeof data.sessionID === "string")
        put(data.sessionID, data.goal ?? null);
    });
    const offNotice = rpc.events.on("notice", (event) => onNotice(event.data));
    const timer = setInterval(() => {
      if (Object.values(entries()).some((entry) => entry.goal?.status === "active"))
        setNow(Date.now());
    }, TICK_MS);
    context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => {
        const goal = createMemo(() => live(props.sessionID));
        const label = createMemo(() => {
          const g = goal();
          if (!g || !props.sessionID)
            return "";
          const entry = entries()[props.sessionID];
          const elapsed = g.status === "active" ? g.elapsedMs + Math.max(0, now() - (entry?.receivedAt ?? now())) : g.elapsedMs;
          const state = g.status === "paused" ? "paused" : g.evaluating ? "checking" : g.waiting ? "waiting" : "active";
          const turns = g.turns > 0 ? ` \xB7 ${g.turns} turn${g.turns === 1 ? "" : "s"}` : "";
          return `${GOAL_GLYPH} goal ${state} \xB7 ${formatDurationCoarse(elapsed)}${turns}`;
        });
        const color = () => goal()?.status === "paused" ? context.theme.text.feedback.warning.base : goal()?.evaluating ? context.theme.text.feedback.info.base : context.theme.text.muted;
        return _$createComponent(Show, {
          get when() {
            return goal();
          },
          get children() {
            var _el$ = _$createElement("box"), _el$2 = _$createElement("text");
            _$insertNode(_el$, _el$2);
            _$setProp(_el$, "flexShrink", 0);
            _$setProp(_el$, "onMouseUp", () => props.sessionID && void rpc.status({
              sessionID: props.sessionID
            }, at(props.sessionID)).catch(() => {}));
            _$setProp(_el$2, "wrapMode", "none");
            _$insert(_el$2, label);
            _$effect((_$p) => _$setProp(_el$2, "fg", color(), _$p));
            return _el$;
          }
        });
      }
    });
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "goal.status",
        title: "Goal: show status",
        group: "Goal",
        palette: true,
        enabled: () => Boolean(live(currentSession()) ?? entries()[currentSession() ?? ""]?.goal),
        run: () => {
          const sessionID = currentSession();
          if (sessionID)
            rpc.status({
              sessionID
            }, at(sessionID)).catch(() => {});
        }
      }, {
        id: "goal.clear",
        title: "Goal: clear",
        group: "Goal",
        palette: true,
        enabled: () => Boolean(live(currentSession())),
        run: () => {
          const sessionID = currentSession();
          if (sessionID)
            rpc.clear({
              sessionID
            }, at(sessionID)).catch(() => {});
        }
      }]
    }));
    return () => {
      clearInterval(timer);
      offChanged();
      offNotice();
    };
  }
});
export {
  tui_default as default
};
