import { withModelApp } from "modelapp/next"

// The app's own rewrites in the array shape: withModelApp keeps them (afterFiles) behind its own (beforeFiles).
export default withModelApp({
  agentRules: false,
  rewrites: async () => [{ source: "/probe-src/:rest*", destination: "/api/probe/:rest*" }],
})
