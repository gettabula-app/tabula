section: Changed
audience: dev

- CI also runs on `queue/**` branches (the merge queue's staging refs), and a push to main whose commit already passed there skips the second run of the same tests: only the image publish and "CI passed" run.
