import { chromium } from "playwright";

/**
 * Screenshots the film's session list for one day. Used when a date opens but
 * the wanted showing is missing — a picture of what NOS actually published is
 * more useful than a list of times in a text alert.
 */
export async function captureSchedule(options: {
  movieUrl: string;
  dayLabel: string;
  outPath: string;
}) {
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
  try {
    const page = await browser.newPage({ locale: "pt-PT", viewport: { width: 1365, height: 1200 } });
    await page.goto(options.movieUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      [...document.querySelectorAll<HTMLElement>("button,a")]
        .find((el) => /^Aceitar todos$/i.test(el.textContent?.trim() ?? ""))?.click();
    });
    await page.waitForSelector(".movie-detail__sessions-list__container__theater", { timeout: 30_000 }).catch(() => {});

    // Day tabs are labelled in Portuguese ("Quarta-feira 19/08"); the schedule
    // API hands us that exact string, so match it rather than reconstructing it.
    const clicked = await page.evaluate((label) => {
      const el = [...document.querySelectorAll<HTMLElement>("button")]
        .find((b) => b.textContent?.trim() === label);
      if (!el) return false;
      el.click();
      return true;
    }, options.dayLabel);
    await page.waitForTimeout(3500);

    await page.screenshot({ path: options.outPath, fullPage: true });
    return { ok: true, dayTabFound: clicked };
  } finally {
    await browser.close();
  }
}
