import { expect, test } from "@playwright/test";

test("retracts the turn and arms a retry notice when generation fails", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Password", { exact: true }).fill("loci-test-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("button", { name: "New chat", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "New chat", exact: true }).click();

  const composer = page.getByPlaceholder("Write a message");
  await composer.fill("trigger-provider-failure please");
  await page.getByRole("button", { name: "Send" }).click();

  // The failed turn is retracted: both bubbles disappear and the failure
  // notice preserves the text with a Retry action (MC-116A).
  await expect(page.getByText("Message failed to send.")).toBeVisible();
  await expect(page.getByText("No messages yet.")).toBeVisible();
  await expect(page.getByText("Streaming…")).toHaveCount(0);
  await expect(
    page.getByText("trigger-provider-failure please", { exact: true }),
  ).toBeVisible();
  const retry = page.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  // The composer stays free for new text; the notice owns the failed draft.
  await expect(composer).toHaveValue("");

  // Retry reconciles (the pair is gone server-side) and resends as a fresh
  // attempt, which fails again against the mock — the notice re-arms and
  // still no residue rows are shown.
  await retry.click();
  await expect(page.getByText("Message failed to send.")).toBeVisible();
  await expect(page.getByText("No messages yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("replaces an old failure notice once a new send is accepted", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Password", { exact: true }).fill("loci-test-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "New chat", exact: true }).click();

  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/sessions") &&
      response.request().method() === "POST",
  );
  const failedContent = "trigger-provider-failure abandoned draft";
  await page.getByPlaceholder("Write a message").fill(failedContent);
  await page.getByRole("button", { name: "Send" }).click();
  const sessionId = (await (await created).json()).session.id as string;
  const notice = page.getByText("Message failed to send.");

  try {
    await expect(notice).toBeVisible();
    await expect(page.getByText("No messages yet.")).toBeVisible();

    // A request rejected before the message SSE must not consume the old
    // notice. The new text is returned to the composer for another send.
    await page.route(
      "**/api/chat",
      (route) => route.fulfill({
        status: 409,
        json: {
          error: {
            code: "GENERATION_IN_PROGRESS",
            message: "Try again shortly.",
          },
        },
      }),
      { times: 1 },
    );
    const composer = page.getByPlaceholder("Write a message");
    await composer.fill("Say hello instead");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Try again shortly.")).toBeVisible();
    await expect(notice).toBeVisible();
    await expect(page.getByText(failedContent, { exact: true })).toBeVisible();
    await expect(composer).toHaveValue("Say hello instead");

    // Send normally, without using the old notice's Retry action.
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Hello from mock Anthropic.")).toBeVisible();
    await expect(page.getByText("Streaming…")).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    await expect(page.getByText(failedContent, { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await page.locator(`[data-session-id="${sessionId}"]`).click();
    await expect(page.getByText("Hello from mock Anthropic.")).toBeVisible();
    await expect(notice).toHaveCount(0);
    await expect(page.getByText(failedContent, { exact: true })).toHaveCount(0);

    await page.reload();
    await expect(page.getByText("Hello from mock Anthropic.")).toBeVisible();
    await expect(notice).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/sessions/${sessionId}`);
  }
});
