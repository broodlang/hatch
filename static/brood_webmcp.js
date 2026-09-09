// hatch WebMCP client — registers this page's tools with the browser's agent surface.
//
// The tool DEFINITIONS are rendered by the server into a JSON block (see web/mcp); this
// file is the code that reads them and calls them. The split is deliberate: the definitions
// are data the app declares in Brood, and no application ever has to write this.
//
// The API is young and has moved. The getter has been specified on both `navigator` and
// `document`, and Chrome shipped the navigator form first, so both are probed and the page
// is inert where neither exists — which is every browser that has not shipped it, and every
// crawler.
(function () {
  "use strict";

  var el = document.getElementById("hatch-mcp-tools");
  if (!el) return;

  var ctx = (typeof document !== "undefined" && document.modelContext) ||
            (typeof navigator !== "undefined" && navigator.modelContext);
  if (!ctx || typeof ctx.registerTool !== "function") return;

  var tools;
  try {
    tools = JSON.parse(el.textContent);
  } catch (e) {
    return; // a malformed block is not worth breaking the page over
  }
  if (!Array.isArray(tools)) return;

  function buildUrl(endpoint, args) {
    var url = new URL(endpoint.url, window.location.origin);
    (endpoint.query || []).forEach(function (name) {
      if (args && args[name] !== undefined && args[name] !== null) {
        url.searchParams.set(name, String(args[name]));
      }
    });
    return url.toString();
  }

  function runner(tool) {
    return async function (args) {
      var endpoint = tool.endpoint || {};
      var method = (endpoint.method || "GET").toUpperCase();
      var init = { method: method, headers: { Accept: "application/json" } };
      var url;

      if (method === "GET") {
        url = buildUrl(endpoint, args);
      } else {
        url = new URL(endpoint.url, window.location.origin).toString();
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(args || {});
      }

      var response = await fetch(url, init);
      var body = await response.text();
      var parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        parsed = body;
      }
      // A non-2xx is an ANSWER, not an exception: an agent that asked for a package that
      // does not exist should be told so, not handed a rejected promise to interpret.
      if (!response.ok) {
        return { ok: false, status: response.status, error: parsed };
      }
      return { ok: true, status: response.status, result: parsed };
    };
  }

  tools.forEach(function (tool) {
    try {
      ctx.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: runner(tool),
      });
    } catch (e) {
      // one bad tool must not cost the page the rest of them
    }
  });
})();
