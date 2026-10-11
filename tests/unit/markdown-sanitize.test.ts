import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "@/features/chat/markdown";

describe("Markdown", () => {
  it("strips unsafe HTML and scripts", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: '<script>alert(1)</script><img src=x onerror="hack()">',
      }),
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });

  it("renders GFM tables and code blocks", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content: "| a | b |\n| - | - |\n| 1 | 2 |\n\n```\ncode\n```",
      }),
    );

    expect(html).toContain("<table");
    expect(html).toContain("<pre");
  });
});
