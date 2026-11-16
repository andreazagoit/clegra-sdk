import { withClegra } from "clegra/next"

// The app's own rewrites in the array shape: withClegra keeps them (afterFiles) behind its own (beforeFiles).
export default withClegra({
  agentRules: false,
  rewrites: async () => [{ source: "/probe-src/:rest*", destination: "/api/probe/:rest*" }],
})
