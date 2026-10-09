import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
const release = fs.readFileSync('.github/workflows/release.yml', 'utf8');

function dockerBuildSteps(text: string) {
  const starts = [...text.matchAll(/^      - uses: docker\/build-push-action@v7$/gm)].map((match) => match.index!);
  expect(starts).toHaveLength(2);
  return starts.map((start) => {
    const next = text.indexOf('\n      - ', start + 1);
    return text.slice(start, next === -1 ? undefined : next);
  });
}

function withBlock(step: string) {
  const start = step.indexOf('\n        with:\n');
  expect(start).toBeGreaterThan(-1);
  const lines = step.slice(start + 1).split('\n');
  const block = [lines[0]];
  for (const line of lines.slice(1)) {
    if (!/^ {10,}\S/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

describe('Docker image build retries', () => {
  it.each([
    ['ci.yml', ci],
    ['release.yml', release],
  ])('%s retries once after the first build fails', (_name, text) => {
    const [first, retry] = dockerBuildSteps(text);

    expect(first).toMatch(/\n        id: build\n        continue-on-error: true\n/);
    expect(retry).toMatch(/\n        id: build-retry\n        if: steps\.build\.outcome == 'failure'\n        continue-on-error: true\n/);
    expect(text).toContain('- name: Wait before retrying the image build\n        if: steps.build.outcome == \'failure\'\n        run: sleep 90');
    expect(withBlock(first)).toBe(withBlock(retry));
    expect(text).toContain("if: steps.build.outcome == 'failure' && steps.build-retry.outcome != 'success'\n        run: exit 1");
    expect(text).toContain('# Fail the job if the image build has failed on both attempts.');
  });

  it('uses the digest from whichever release build succeeded', () => {
    expect(release).toContain('digest: ${{ steps.digest.outputs.digest }}');
    expect(release).toContain('id: digest\n        if: steps.build.outcome == \'success\' || steps.build-retry.outcome == \'success\'');
    expect(release).toContain('BUILD_DIGEST: ${{ steps.build.outputs.digest }}');
    expect(release).toContain('RETRY_DIGEST: ${{ steps.build-retry.outputs.digest }}');
    expect(release.match(/DIGEST: \$\{\{ steps\.digest\.outputs\.digest \}\}/g)).toHaveLength(2);
    expect(release).not.toMatch(/^\s*DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/m);
  });
});
