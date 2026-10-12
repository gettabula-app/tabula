section: Changed

- Adopting a restored disk (a Fly volume snapshot or another workspace's volume) now closes the tracker to writes until its recovery and readiness check have run, so a disk that is older than the last ticket number cannot hand out the same ticket key twice.
