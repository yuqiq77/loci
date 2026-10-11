import { expect, test } from "@playwright/test";

// MC-117C browser smoke: the mock provider answers a last user message of
// "trigger-tool-call" (only when the request advertises tools) with a
// search_memory tool_use; the app executes the tool, whose query embedding
// the mock delays so the transient status is observable; the continuation
// completes the reply. A second flow fails the continuation so the
// indicator must not survive a stream failure.
test("shows transient tool status across execution, session switch, and failure", async ({
  page,
}) => {
  // Cold dev-server compiles plus the mock's deliberate tool-query embedding
  // delay exceed the default budget.
  test.setTimeout(120_000);
  const createdSessionIds: string[] = [];

  await page.goto("/");
  await page.getByLabel("Password", { exact: true }).fill("loci-test-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("button", { name: "New chat", exact: true }),
  ).toBeVisible();
  // The settings PUT is strict over the full row: echo the GET payload
  // minus updatedAt (the smoke spec's restore pattern) with the one change.
  const editableSettings = {
    ...((await (await page.request.get("/api/settings")).json()).settings as
      Record<string, unknown>),
  };
  delete editableSettings.updatedAt;

  async function sendAndCaptureSession(text: string): Promise<string> {
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/sessions") &&
        response.request().method() === "POST",
    );
    await page.getByPlaceholder("Write a message").fill(text);
    await page.getByRole("button", { name: "Send" }).click();
    const id = (await (await created).json()).session.id as string;
    createdSessionIds.push(id);
    return id;
  }

  try {
    const enabled = await page.request.put("/api/settings", {
      data: { ...editableSettings, toolsEnabled: true },
    });
    expect(enabled.ok()).toBe(true);

    // A first conversation to switch to while the tool runs.
    await expect(
      page.getByRole("heading", { name: "What's on your mind?" }),
    ).toBeVisible();
    const firstSession = await sendAndCaptureSession("Say hello");
    const firstRow = page.locator(`[data-session-id="${firstSession}"]`);
    await expect(page.getByText("Hello from mock Anthropic.")).toBeVisible();
    await expect(page.getByText("Streaming…")).toHaveCount(0);

    // Warm the session-switch route once so the switches below, which must
    // fit inside the tool's execution window, do not pay a cold compile.
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await firstRow.click();
    await expect(page.getByText("Hello from mock Anthropic.")).toBeVisible();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "What's on your mind?" }),
    ).toBeVisible();

    const secondSession = await sendAndCaptureSession("trigger-tool-call");
    const secondRow = page.locator(`[data-session-id="${secondSession}"]`);
    const recalling = page.getByText("Recalling memory…");
    await expect(recalling).toBeVisible({ timeout: 20_000 });

    // Switch away and back while the tool is still running: the live
    // status is restored from the draft, not invented from history.
    await firstRow.click();
    await expect(page.getByText("Hello from mock Anthropic.")).toBeVisible();
    await expect(recalling).toHaveCount(0);
    await secondRow.click();
    await expect(recalling).toBeVisible();

    await expect(page.getByText("Recalled and replied.")).toBeVisible({
      timeout: 20_000,
    });
    await expect(recalling).toHaveCount(0);
    await expect(page.getByText("Streaming…")).toHaveCount(0);

    // A tool round whose continuation fails: the pair is retracted and no
    // indicator lingers.
    await page
      .getByPlaceholder("Write a reply")
      .fill("trigger-tool-then-failure");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(recalling).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Message failed to send.")).toBeVisible({
      timeout: 20_000,
    });
    await expect(recalling).toHaveCount(0);
    await expect(page.getByText("Streaming…")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  } finally {
    await page.request.put("/api/settings", { data: editableSettings });
    for (const id of createdSessionIds) {
      await page.request.delete(`/api/sessions/${id}`);
    }
  }
});
