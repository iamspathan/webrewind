// End-to-end capture flow with a mocked server. Intercepts:
//
//   POST /screenshots                        -> { jobId: "mock-job" }
//   GET  /screenshots/events/mock-job        -> static text/event-stream
//
// The SSE response is sent as a single buffered body. The browser's
// EventSource parses it into discrete events, so we can replay a full
// capture timeline (phase → urls → capture:done → done) in milliseconds
// and then assert on the UI transition into "finalizing".

import { test, expect } from "@playwright/test";

const MOCK_JOB_ID = "mock-job";

// 1x1 transparent PNG as a data URL — used so the CinematicStage can render
// its <img> tags without reaching out to the network.
const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function sse(events: object[]) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

test.describe("Capture flow (mocked server)", () => {
  test.beforeEach(async ({ page }) => {
    // POST /screenshots — accept and return a static jobId.
    await page.route(/\/screenshots$/, async (route) => {
      if (route.request().method() !== "POST") {
        return route.fallback();
      }
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        headers: {
          "X-Request-Id": "test-request-1",
          "Access-Control-Expose-Headers": "X-Request-Id",
        },
        body: JSON.stringify({
          jobId: MOCK_JOB_ID,
          streamUrl: `/screenshots/events/${MOCK_JOB_ID}`,
        }),
      });
    });

    // SSE stream — one fulfill() call delivers a full buffered timeline.
    // The client's EventSource processes each data: block in order, hits
    // the terminal "done" event, and closes the connection.
    await page.route(
      new RegExp(`/screenshots/events/${MOCK_JOB_ID}$`),
      async (route) => {
        const body = sse([
          { type: "phase", phase: "starting" },
          { type: "phase", phase: "fetching-urls" },
          { type: "urls", total: 3 },
          { type: "phase", phase: "capturing", concurrency: 2 },
          {
            type: "capture:done",
            index: 0,
            total: 3,
            imageUrl: TRANSPARENT_PNG,
            timestamp: "20200101000000",
          },
          {
            type: "capture:done",
            index: 1,
            total: 3,
            imageUrl: TRANSPARENT_PNG,
            timestamp: "20210101000000",
          },
          {
            type: "capture:done",
            index: 2,
            total: 3,
            imageUrl: TRANSPARENT_PNG,
            timestamp: "20220101000000",
          },
          { type: "phase", phase: "encoding-gif" },
          {
            type: "done",
            images: [TRANSPARENT_PNG, TRANSPARENT_PNG, TRANSPARENT_PNG],
            gif: null,
            count: 3,
          },
        ]);

        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: {
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
          body,
        });
      }
    );
  });

  test("submits the form, streams progress, opens the stage", async ({
    page,
  }) => {
    await page.goto("/");

    await page
      .getByPlaceholder("https://example.com")
      .fill("https://example.com");
    await page.getByPlaceholder("website_evolution").fill("smoke_test");

    await page.getByRole("button", { name: /start rewinding/i }).click();

    // Progress card appears — the "Capturing snapshots" label lives in the
    // CaptureProgress header and is distinct enough to anchor on.
    await expect(page.getByText(/capturing snapshots/i)).toBeVisible();

    // After the full SSE timeline is consumed, the client enters the 700ms
    // "finalizing" state, then opens the CinematicStage. We give the
    // transition a generous upper bound for CI variance.
    await expect(page.getByText(/assembling the reel/i)).toBeVisible({
      timeout: 5_000,
    });
  });
});
