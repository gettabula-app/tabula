import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { releaseBody } from '../scripts/release-body.mjs';

// TAB-236, docs/releasing.md: the body the release workflow sends to POST /admin/releases, and the workflow's rule that a missing
// secret skips the push and register steps instead of failing the run.

const DIGEST = `sha256:${'ab'.repeat(32)}`;
const info = { schema: { directory: 10, chat: 3 }, maxReader: { directory: 9, chat: 2 } };

describe('the registration body', () => {
  it('names the image by digest and carries the version, schema and reader generations', () => {
    expect(releaseBody({ version: 'v4', digest: DIGEST }, info)).toEqual({
      image: `registry.fly.io/tabula-app@${DIGEST}`, version: 'v4', schema: info.schema, maxReader: info.maxReader,
    });
  });

  it('adds the security flag and the notes only when given', () => {
    expect(releaseBody({ version: 'v4', digest: DIGEST, security: true, notes: 'fix' }, info)).toMatchObject({ security: true, notes: 'fix' });
    const plain = releaseBody({ version: 'v4', digest: DIGEST, security: false }, info);
    expect(plain).not.toHaveProperty('security');
    expect(plain).not.toHaveProperty('notes');
  });

  it('refuses a bad version, digest, repository or generations', () => {
    expect(() => releaseBody({ version: 'v 4', digest: DIGEST }, info)).toThrow('invalid version');
    expect(() => releaseBody({ version: 'a'.repeat(41), digest: DIGEST }, info)).toThrow('invalid version');
    expect(() => releaseBody({ version: 'v4', digest: 'sha256:ABC' }, info)).toThrow('invalid digest');
    expect(() => releaseBody({ version: 'v4', digest: `${DIGEST}0` }, info)).toThrow('invalid digest');
    expect(() => releaseBody({ version: 'v4', digest: DIGEST, imageRepo: 'ghcr.io/x/y' }, info)).toThrow('invalid image repository');
    expect(() => releaseBody({ version: 'v4', digest: DIGEST }, { ...info, schema: { directory: -1, chat: 0 } })).toThrow('non-negative');
    expect(() => releaseBody({ version: 'v4', digest: DIGEST }, undefined as never)).toThrow('non-negative');
  });
});

describe('the release workflow', () => {
  const text = fs.readFileSync('.github/workflows/release.yml', 'utf8');
  const step = (name: string) => {
    const at = text.indexOf(`- name: ${name}`);
    expect(at).toBeGreaterThan(-1);
    return text.slice(at, text.indexOf('\n      - ', at + 1) === -1 ? undefined : text.indexOf('\n      - ', at + 1));
  };

  it('runs on v* tags and by hand, and calls the CI gates before it builds', () => {
    expect(text).toMatch(/tags: \['v\*'\]/);
    expect(text).toContain('workflow_dispatch:');
    expect(text).toContain('uses: ./.github/workflows/ci.yml');
    expect(text).toMatch(/release:\n(?:.*\n)*?\s+needs: gates/);
    expect(fs.readFileSync('.github/workflows/ci.yml', 'utf8')).toContain('workflow_call:');
  });

  it('gives the Docker build the tag as TABULA_VERSION', () => {
    expect(text).toContain('TABULA_VERSION=${{ env.TAG }}');
    expect(fs.readFileSync('Dockerfile', 'utf8')).toContain('ARG TABULA_VERSION');
  });

  it('only logs in and pushes with FLY_API_TOKEN, and only registers with the token and the URL as well', () => {
    expect(step('Check the label and what is configured')).toContain('[ -n "$FLY_API_TOKEN" ]');
    expect(text).toMatch(/docker\/login-action@v\d+\n\s+if: steps\.plan\.outputs\.push == 'true'/);
    expect(text).toContain("push: ${{ steps.plan.outputs.push == 'true' }}");
    expect(step('Register the release with the control plane')).toContain("if: steps.plan.outputs.register == 'true'");
    expect(step('Check the label and what is configured')).toContain('[ -n "$ADMIN_TOKEN" ] && [ -n "$ADMIN_URL" ]');
  });

  it('never fails the run for a missing secret: it prints a notice', () => {
    const plan = step('Check the label and what is configured');
    expect(plan.match(/::notice::/g)?.length).toBe(2);
    // the one exit 1 of the step is the bad-label check, before any secret is looked at
    expect(plan.match(/exit 1/g)?.length).toBe(1);
    expect(plan.indexOf('exit 1')).toBeLessThan(plan.indexOf('FLY_API_TOKEN'));
  });

  it('never puts a secret on a command line or in the log', () => {
    expect(text).not.toMatch(/--header ['"]?Authorization: Bearer \$/);
    expect(text).not.toContain('echo "$ADMIN_TOKEN"');
    expect(text).not.toContain('set -x');
  });
});
