# Instance telemetry

Hosted workspaces default to product analytics on, with a disclosure; the owner can turn it off. That switch stops feature-use counts and durations, including how many boards were opened and counts of coarse device, browser-family, and operating-system classes. It does not stop operating data. Self-hosted instances default off; when the owner turns telemetry on, the listed report is prepared once an hour for Tabula.

The Privacy panel shows the exact scrubbed report the instance would build. Always-on operating data includes request counts and durations by route template, current and hourly peak connection totals, process resource use, workspace scale, seats and guests, version and disk data, backup and restore health, and last activity. Workspace scale reports sizes only: how many boards, members, and items the workspace holds, never their content. A board count is operating data; the count of boards opened is product analytics controlled by the switch.

Device, browser-family, and operating-system classes are sent only as counts under product analytics. The raw User-Agent and browser strings are read on the instance and discarded; neither is sent. Error reports are not collected yet. When they are added they will stay on and contain only an error code and the software version, never anything from your boards.

This version does not send telemetry anywhere. The preview says “Nothing has been sent”; delivery will be added in a later version.
