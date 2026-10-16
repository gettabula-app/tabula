import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { validatePreviewImage } from '../server/preview-image.mjs';

let browser: Browser | undefined;
let page: Page | undefined;
const available = existsSync(chromium.executablePath());

beforeAll(async () => {
  if (available) browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

async function canvasBytes(type: 'image/png' | 'image/webp') {
  await page!.setContent('<canvas id="preview" width="480" height="300"></canvas>');
  return page!.evaluate(async (mime) => {
    const canvas = document.querySelector<HTMLCanvasElement>('#preview')!;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#3264a8';
    context.fillRect(0, 0, 480, 300);
    context.fillStyle = '#f4d35e';
    context.fillRect(80, 70, 180, 120);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.8));
    return blob ? { type: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) } : null;
  }, type);
}

describe.skipIf(!available)('preview image validation in Chromium', () => {
  it('accepts a 480×300 canvas PNG', async () => {
    page = await browser!.newPage();
    const image = await canvasBytes('image/png');
    expect(image?.type).toBe('image/png');
    expect(validatePreviewImage(Buffer.from(image!.bytes), 'image/png')).toMatchObject({ ok: true, type: 'image/png', width: 480, height: 300 });
    await page.close();
    page = undefined;
  });

  it('accepts a 480×300 canvas WebP when Chromium supports toBlob', async (context) => {
    page = await browser!.newPage();
    const image = await canvasBytes('image/webp');
    if (!image || image.type !== 'image/webp') context.skip(`Chromium did not produce WebP (returned ${image?.type ?? 'null'})`);
    expect(validatePreviewImage(Buffer.from(image!.bytes), 'image/webp')).toMatchObject({ ok: true, type: 'image/webp', width: 480, height: 300 });
    await page.close();
    page = undefined;
  });
});
