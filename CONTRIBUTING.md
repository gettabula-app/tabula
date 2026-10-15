# Contributing to Tabula

Thank you for wanting to help. Tabula is open source under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).

## Before your first pull request: sign the contributor agreement

Before we can merge your first pull request, we ask you to accept the [Tabula Contributor Licence Agreement](CLA.md). You do it once, by commenting on your pull request:

> I have read the CLA Document and I hereby sign the CLA

A check on the pull request shows whether you have signed. It also covers anything you contributed before you signed.

**What it means, in short.** You keep the copyright in what you write. You give Tabula the right to use it and to license it under any terms, including the AGPL and commercial licences, and that right stays with the project if it changes owner. In return, every version published under the AGPL stays available under the AGPL. The full text in [CLA.md](CLA.md) is what counts.

**Why we ask.** It lets one company answer for the whole codebase: offer the AGPL version, sell commercial licences to organisations that cannot use the AGPL, and keep the project in one piece if it is ever sold.

## How to contribute

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Keep each pull request to one change, with tests.
3. Add a changelog fragment in `changelog.d/`, as described in [changelog.d/README.md](changelog.d/README.md).
4. Run the checks: `npx tsc --noEmit`, `npm run lint`, `npm run changelog:check` and `npm test`.
5. Do not include code you do not have the right to contribute, and say where any third-party code comes from and under which licence.

## Security

Please do not open a public issue for a security problem. Write to support@gettabula.app instead.
