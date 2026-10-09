section: Fixed

- The join-code secret file tests no longer assert POSIX permission bits on Windows, where every file reports 0o666 and
  the Windows CI shards were failing on it.
