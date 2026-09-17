/* global document, window */
import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";

test("a viewer can subscribe, resume a title, search, and manage their account", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const email = `browser-${Date.now()}@example.com`;
  await page.goto("/");
  await page.getByRole("button", { name: "Start exploring" }).click();
  await page.getByLabel("Your name").fill("Frame Browser Test");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Testing1234");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Trending now", exact: true })
    .waitFor();

  await page.getByRole("link", { name: "Plans", exact: true }).click();
  await page
    .getByRole("button", { name: "Choose Premium", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Your current plan", exact: true })
    .waitFor();
  await page.getByRole("link", { name: "Movies", exact: true }).click();
  await page
    .getByRole("button", { name: "View Interstellar", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start playback demo", exact: true })
    .click();
  await page.locator("#progress").fill("1800");
  await page
    .getByRole("button", { name: "Save progress", exact: true })
    .click();
  await page
    .locator("#notice")
    .filter({ hasText: "Progress saved." })
    .waitFor();
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await page.locator("#modal").waitFor({ state: "hidden" });
  await page.getByRole("link", { name: "Discover", exact: true }).click();
  await page
    .getByRole("heading", { name: "Continue watching", exact: true })
    .waitFor();
  await page
    .locator('[data-title="tt_interstellar"][data-resume="1800"]')
    .click();
  await page
    .getByRole("button", { name: "Resume playback demo", exact: true })
    .click();
  await page.locator("#progress").waitFor();
  assert.equal(await page.locator("#progress").inputValue(), "1800");
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await page.locator("#modal").waitFor({ state: "hidden" });
  await page
    .getByLabel("Search titles or describe your mood")
    .fill("korean thriller series");
  await page.getByRole("button", { name: "Find a story" }).click();
  await page
    .getByRole("button", { name: "View Squid Game", exact: true })
    .waitFor();
  await page.getByRole("link", { name: "My account", exact: true }).click();
  await page.getByLabel("Display name").fill("Updated Viewer");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.getByRole("heading", { name: "Hello, Updated Viewer." }).waitFor();
  await page
    .getByRole("button", { name: "Mark all as read", exact: true })
    .click();
  await page.getByRole("button", { name: "Cancel plan", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm cancellation", exact: true })
    .click();
  await page.getByText("cancelled · INR 649.00", { exact: true }).waitFor();

  await page.getByRole("link", { name: "Discover", exact: true }).click();
  await page
    .getByRole("heading", { name: "Trending now", exact: true })
    .waitFor();

  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "mobile page must not overflow",
  );

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("button", { name: "Start exploring" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Testing1234");
  await page
    .locator("#auth-form")
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(page.locator("#modal")).not.toBeVisible();
  await page.getByRole("link", { name: "My account", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hello, Updated Viewer." }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
});
