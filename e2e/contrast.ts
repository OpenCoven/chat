import { expect, type Page } from '@playwright/test';

/** Every visible text measured against the pixels behind it; failures below 4.5:1. */
export async function contrastFailures(page: Page, { minimum = 20 } = {}): Promise<string[]> {
  // The palette tests check tokens in isolation; this measures the rendered
  // page. Every text is made transparent and the viewport captured, so each
  // text box is compared with the pixels actually behind it, gradients and
  // layered surfaces included. Every text must meet WCAG AA for normal text
  // (4.5:1); the app sets none large enough for the 3:1 allowance.
  // Let entry transitions settle; a menu measured mid-fade reads as a failure.
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
  const texts = await page.evaluate(() => {
    // An open modal makes everything outside it inert; only the modal is read.
    const modal = document.querySelector(':modal');
    const found: { label: string; color: string; opacity: number; box: number[] }[] = [];
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (!element || !node.textContent?.trim() || seen.has(element)) continue;
      seen.add(element);
      const style = getComputedStyle(element);
      if (
        style.visibility === 'hidden' ||
        element.closest('[aria-hidden="true"], [inert], .coven-sr-only') ||
        (modal && !modal.contains(element)) ||
        // Inactive controls are exempt from contrast (WCAG 1.4.3).
        element.closest(':disabled, [aria-disabled="true"]') ||
        (element.closest('details:not([open])') && !element.closest('summary'))
      )
        continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || rect.bottom <= 0 || rect.top >= innerHeight)
        continue;
      let opacity = 1;
      for (let e: Element | null = element; e; e = e.parentElement)
        opacity *= Number.parseFloat(getComputedStyle(e).opacity);
      found.push({
        label: node.textContent.trim().slice(0, 30),
        color: style.color,
        opacity,
        box: [rect.left, rect.top, rect.width, rect.height],
      });
    }
    return found;
  });
  expect(texts.length).toBeGreaterThanOrEqual(minimum);
  const hide = await page.addStyleTag({
    content:
      '*, *::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }',
  });
  const backdrop = (await page.screenshot()).toString('base64');
  await hide.evaluate((element) => (element as HTMLElement).remove());
  const failures = await page.evaluate(
    async ({ image, texts }) => {
      const picture = new Image();
      picture.src = `data:image/png;base64,${image}`;
      await picture.decode();
      const canvas = document.createElement('canvas');
      canvas.width = picture.width;
      canvas.height = picture.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('No 2D context.');
      context.drawImage(picture, 0, 0);
      const scale = picture.width / innerWidth;
      const pixel = (x: number, y: number) =>
        Array.from(context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data);
      const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      if (!probe) throw new Error('No 2D context.');
      const parse = (color: string): number[] => {
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = color;
        probe.fillRect(0, 0, 1, 1);
        const [r = 0, g = 0, b = 0, a = 255] = probe.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
      };
      const luminance = (c: number[]) =>
        c
          .slice(0, 3)
          .map((v) => v / 255)
          .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((sum, v, i) => sum + v * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0);
      const ratio = (a: number[], b: number[]) => {
        const [light = 0, dark = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (light + 0.05) / (dark + 0.05);
      };
      const found: string[] = [];
      for (const text of texts) {
        const [left = 0, top = 0, width = 0, height = 0] = text.box;
        // The darkest-to-lightest spread of a few points inside the box; the
        // worst of them is the backdrop the text must stand out from.
        const points = [0.25, 0.5, 0.75].map((f) => pixel(left + width * f, top + height / 2));
        const [r, g, b, a] = parse(text.color);
        let worst = Number.POSITIVE_INFINITY;
        for (const back of points) {
          const alpha = (a ?? 1) * text.opacity;
          const shown = [r, g, b].map((v, i) => (v ?? 0) * alpha + (back[i] ?? 0) * (1 - alpha));
          worst = Math.min(worst, ratio(shown, back));
        }
        if (worst < 4.5) found.push(`${worst.toFixed(2)} "${text.label}"`);
      }
      return found;
    },
    { image: backdrop, texts },
  );
  return failures;
}
