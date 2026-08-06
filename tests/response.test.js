import { describe, it, expect } from "vitest";
import { json, html, csvEscape, xmlEscape, htmlEscape } from "../src/utils/response.js";

describe("Response & Escaping Utilities", () => {
  it("escapes CSV values with quotes or commas", () => {
    expect(csvEscape("simple")).toBe("simple");
    expect(csvEscape("hello, world")).toBe('"hello, world"');
    expect(csvEscape('say "hello"')).toBe('"say ""hello"""');
  });

  it("escapes XML characters to avoid corrupted OpenXML files", () => {
    expect(xmlEscape("A & B < C > D")).toBe("A &amp; B &lt; C &gt; D");
    expect(xmlEscape(`"quote"`)).toBe("&quot;quote&quot;");
  });

  it("escapes HTML characters", () => {
    expect(htmlEscape("<div>test</div>")).toBe("&lt;div&gt;test&lt;/div&gt;");
  });

  it("constructs JSON responses with CORS headers", async () => {
    const res = json({ success: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});
