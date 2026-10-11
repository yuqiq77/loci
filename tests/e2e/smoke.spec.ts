import { expect, test } from "@playwright/test";
import postgres from "postgres";

test("protects the app with the owner login", async ({ page }) => {
  const createdSessionIds: string[] = [];
  let ownerCookieHeader = "";
  let originalSettings: Record<string, unknown> | null = null;

  await page.goto("/");

  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: "Private access" }),
  ).toBeVisible();

  await page.getByLabel("Password", { exact: true }).fill("wrong password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByText("Unable to sign in. Check the password and try again."),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("Password", { exact: true }).fill("loci-test-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3000/");
  await expect(
    page.getByRole("button", { name: "New chat", exact: true }),
  ).toBeVisible();
  const ownerCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "loci_session",
  );
  ownerCookieHeader = ownerCookie
    ? `${ownerCookie.name}=${ownerCookie.value}`
    : "";
  const settingsResponse = await page.request.get("/api/settings");
  originalSettings = (await settingsResponse.json()).settings;

  try {
    // Signing in lands on the blank new-chat state; the conversation is
    // only created by the first send.
    await expect(
      page.getByRole("heading", { name: "What's on your mind?" }),
    ).toBeVisible();
    const createFirstResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/sessions") &&
        response.request().method() === "POST",
    );
    await page.getByPlaceholder("Write a message").fill("Say hello");
    await page.getByRole("button", { name: "Send" }).click();
    const firstSession = (await (await createFirstResponse).json()).session;
    createdSessionIds.push(firstSession.id);
    await expect(page.getByText("Hello from mock Anthropic.")).toBeVisible();
    await expect(page.getByText("Streaming…")).toHaveCount(0);
    await expect(page.getByPlaceholder("Write a reply")).toBeVisible();

    const firstRow = page.locator(
      `[data-session-id="${firstSession.id}"]`,
    );
    await expect(firstRow.locator('[aria-current="true"]')).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open conversations" }).click();
    await firstRow
      .getByRole("button", { name: /Conversation actions for/ })
      .click();
    await expect(
      firstRow.getByRole("menuitem", { name: "Rename" }),
    ).toBeVisible();
    await expect(
      firstRow.getByRole("menuitem", { name: "Archive" }),
    ).toBeVisible();
    await expect(
      firstRow.getByRole("menuitem", { name: "Delete" }),
    ).toBeVisible();

    const renamedTitle = `Renamed ${Date.now()}`;
    const renamedName = new RegExp(`^${renamedTitle}`);
    page.once("dialog", (dialog) => dialog.accept(renamedTitle));
    await firstRow.getByRole("menuitem", { name: "Rename" }).click();
    await expect(
      firstRow.getByRole("button", { name: renamedName }),
    ).toBeVisible();

    // Mobile: leaving to a tool page and coming back restores the
    // conversation that was open.
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.getByRole("link", { name: "Back to chats" }).click();
    await expect(page.getByText("Hello from mock Anthropic.")).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.reload();
    const persistedFirstRow = page.locator(
      `[data-session-id="${firstSession.id}"]`,
    );
    await expect(
      persistedFirstRow.getByRole("button", { name: renamedName }),
    ).toBeVisible();

    // The conversation survives a reload via the last-session cookie.
    await expect(page.getByText("Say hello")).toBeVisible();
    await expect(page.getByText("Hello from mock Anthropic.")).toBeVisible();

    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole("heading", { name: "Settings" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Settings" }),
    ).toBeVisible();
    await expect(page.getByText("Opus 5.5", { exact: true })).toBeVisible();
    await page.getByLabel("Context token budget").fill("1000");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(
      page.getByText(
        "Context budget must be at least output tokens plus 2000.",
      ),
    ).toBeVisible();
    await page.getByLabel("Context token budget").fill("96000");
    await page
      .getByLabel("System prompt")
      .fill("Playwright system prompt");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();

    await persistedFirstRow
      .getByRole("button", { name: renamedName })
      .click();
    await page.getByPlaceholder("Write a reply").fill("Check settings");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Settings applied.")).toBeVisible();

    await page.goto("/memories");
    await expect(
      page.getByRole("heading", { name: "Memories" }),
    ).toBeVisible();
    await page.goto("/");

    // "New chat" only switches to the blank state; the second conversation
    // is created by its first send, carrying the model picked beforehand.
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "What's on your mind?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^Opus 5\.5/ }).click();
    await page.getByRole("menuitemradio", { name: /^Sonnet 4\.6/ }).click();
    const createSecondResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/sessions") &&
        response.request().method() === "POST",
    );
    await page.getByPlaceholder("Write a message").fill("Say hello");
    await page.getByRole("button", { name: "Send" }).click();
    const secondSession = (await (await createSecondResponse).json()).session;
    createdSessionIds.push(secondSession.id);
    expect(secondSession.modelId).toBe("claude-sonnet-4-6");
    // New chats start with thinking on unless the user turns it off.
    expect(secondSession.thinkingEnabled).toBe(true);
    const secondRow = page.locator(
      `[data-session-id="${secondSession.id}"]`,
    );
    await expect(secondRow.locator('[aria-current="true"]')).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Sonnet 4\.6/ }),
    ).toBeVisible();

    await persistedFirstRow
      .getByRole("button", { name: renamedName })
      .click();
    await expect(
      persistedFirstRow.getByRole("button", { name: renamedName }),
    ).toHaveAttribute("aria-current", "true");

    await persistedFirstRow.hover();
    await persistedFirstRow
      .getByRole("button", { name: /Conversation actions for/ })
      .click();
    await persistedFirstRow.getByRole("menuitem", { name: "Archive" }).click();
    await expect(persistedFirstRow).toHaveCount(0);

    await secondRow.hover();
    await secondRow
      .getByRole("button", { name: /Conversation actions for/ })
      .click();
    page.once("dialog", (dialog) => dialog.accept());
    await secondRow.getByRole("menuitem", { name: "Delete" }).click();
    await expect(secondRow).toHaveCount(0);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  } finally {
    if (originalSettings && ownerCookieHeader) {
      const editableSettings = { ...originalSettings };
      delete editableSettings.updatedAt;
      await page.request.put("/api/settings", {
        data: editableSettings,
        headers: { cookie: ownerCookieHeader },
      });
    }
    for (const id of createdSessionIds) {
      await page.request.delete(`/api/sessions/${id}`, {
        headers: ownerCookieHeader ? { cookie: ownerCookieHeader } : {},
      });
    }
  }
});

test("rejects unauthenticated protected API requests", async ({ request }) => {
  const response = await request.post("/api/auth/logout");

  expect(response.status()).toBe(401);
});

test("searches, edits, and deletes a memory", async ({ page }) => {
  // Set by playwright.config.ts from the required TEST_DATABASE_URL.
  const databaseUrl = process.env.DATABASE_URL!;
  const connection = postgres(databaseUrl, { max: 1, prepare: false });
  const content = `Playwright memory ${Date.now()}`;
  const [memory] = await connection<{ id: string }[]>`
    insert into memories (
      content, importance, valence, arousal, resolved, pinned, content_hash
    ) values (
      ${content}, 0.6, 0.1, 0.2, false, false, ${`e2e-${Date.now()}`}
    ) returning id
  `;

  try {
    await page.goto("/login");
    await page.getByLabel("Password", { exact: true }).fill("loci-test-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL("http://127.0.0.1:3000/");
    await page.goto("/memories");

    await expect(
      page.getByRole("heading", { name: "Memories" }),
    ).toBeVisible();
    await page.getByPlaceholder("Search by content").fill(content);
    const row = page.locator(`[data-memory-id="${memory.id}"]`);
    await expect(row.getByText(content)).toBeVisible();

    await row.getByRole("button", { name: "Edit" }).click();
    const updatedContent = `${content} updated`;
    await row.locator("textarea").fill(updatedContent);
    await row.getByLabel("Pinned").check();
    await row.getByRole("button", { name: "Save changes" }).click();
    await expect(row.getByText(updatedContent)).toBeVisible();
    await expect(row.getByText("Yes").last()).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await row.getByRole("button", { name: "Move to bin" }).click();
    await expect(row).toHaveCount(0);
  } finally {
    await connection`
      delete from jobs
      where type = 'embed_memory'
        and payload->>'memoryId' = ${memory.id}
    `;
    await connection`delete from memories where id = ${memory.id}`;
    await connection.end();
  }
});
