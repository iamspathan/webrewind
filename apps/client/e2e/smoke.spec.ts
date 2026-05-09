// Smoke tests for the rendering & form layer. Does not touch the server —
// these run even when the API is offline, on fresh clones, and in CI.

import { test, expect } from "@playwright/test";

test.describe("WebsiteEvolutionViewer — smoke", () => {
  test("home page boots with form visible", async ({ page }) => {
    await page.goto("/");

    // Hero copy — sanity check that the main component mounted.
    await expect(page.getByText(/Travel through/i)).toBeVisible();

    // Form fields — use role-based selectors to stay resilient to styling.
    await expect(
      page.getByPlaceholder("https://example.com")
    ).toBeVisible();
    await expect(page.getByPlaceholder("website_evolution")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /start rewinding/i })
    ).toBeVisible();
  });

  test("invalid URL surfaces a validation message", async ({ page }) => {
    await page.goto("/");

    // The Zod resolver fires on submit; an empty URL is "Please enter a
    // valid URL". This lets us verify the form is actually wired up.
    const urlInput = page.getByPlaceholder("https://example.com");
    await urlInput.fill("not-a-url");

    await page.getByRole("button", { name: /start rewinding/i }).click();

    await expect(page.getByText(/please enter a valid url/i)).toBeVisible();
  });

  test("high-quality toggle is on by default and can be switched", async ({
    page,
  }) => {
    await page.goto("/");

    const toggle = page.locator('input[type="checkbox"]').first();
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
  });
});
