import { definePage } from "@clegra/sdk"

// A custom page: our own MCP Apps document (forecast-view.ts) instead of a generated view.
export const forecastPage = definePage({
  name: "forecast",
  title: { en: "Forecast", it: "Previsione" },
  icon: "calculator",
  description: { en: "A weighted forecast you can tune", it: "Una previsione pesata da regolare" },
  permission: "deals.values",
  view: { html: () => import("../forecast-view").then((m) => m.forecastHtml) },
})
